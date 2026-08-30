import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { page as sharedPage, escapeHtml, errorPage } from "./page.js";
import type { Env } from "./env.js";
import type { GithubIdentity } from "./spaces.js";
import { activateInstallation, getMemberByGithubId } from "./spaces.js";
import {
  fetchInstallationRepositories,
  validateMemoryRepository,
} from "./github-oauth.js";
import { generateCSRFProtection, validateCSRFToken } from "./oauth-consent.js";

export const SETUP_COOKIE = "__Host-WAYFORM_SETUP";
const SETUP_TTL_SECONDS = 600;
const RETURN_TTL_SECONDS = 3600;
const COOKIE_ATTRS = "HttpOnly; Secure; Path=/; SameSite=Lax";

export interface SetupRepository {
  owner: string;
  repo: string;
  private: boolean;
  defaultBranch: string | null;
}

export interface PendingSetup {
  oauthRequest: AuthRequest;
  user: GithubIdentity;
  createdAt: number;
  installationId?: number;
  repositories?: SetupRepository[];
  allowedInstallationIds?: number[];
}

interface SetupEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

export async function beginInstallSetup(
  request: Request,
  env: Env,
  pending: Omit<PendingSetup, "createdAt">,
): Promise<Response> {
  if (!env.GITHUB_APP_SLUG) {
    return new Response("GitHub App installation is not configured", {
      status: 503,
    });
  }
  const handle = crypto.randomUUID();
  const record: PendingSetup = { ...pending, createdAt: Date.now() };
  await env.OAUTH_KV.put(setupKey(handle), JSON.stringify(record), {
    expirationTtl: SETUP_TTL_SECONDS,
  });
  await env.OAUTH_KV.put(
    returnKey(handle),
    JSON.stringify(record.oauthRequest),
    { expirationTtl: RETURN_TTL_SECONDS },
  );
  const setupCookie = await bindSetupCookie(handle);
  if (record.installationId && record.repositories) {
    return pickerResponse(handle, record.repositories, setupCookie);
  }
  const install = new URL(
    `https://github.com/apps/${encodeURIComponent(
      env.GITHUB_APP_SLUG,
    )}/installations/new`,
  );
  install.searchParams.set("state", handle);
  return htmlResponse(renderInstallPage(install.href), [setupCookie]);
}

export async function handleInstallCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const handle = url.searchParams.get("state");
  const installationId = Number(url.searchParams.get("installation_id"));
  if (!handle || !Number.isSafeInteger(installationId) || installationId <= 0) {
    return new Response("invalid installation callback", { status: 400 });
  }
  const pending = await readPending(env, handle);
  if (!pending) return expiredSetupResponse(env, handle);
  if (!(await validSetupCookie(request, handle))) {
    return new Response("setup state mismatch", { status: 400 });
  }
  if (isExpired(pending)) return expireSetup(env, handle, pending);
  const previouslyAccessible =
    pending.allowedInstallationIds?.includes(installationId) ?? false;
  if (!previouslyAccessible) {
    const inventoryRaw = await env.ROUTING.get(
      `installation:inventory:${installationId}`,
    );
    if (!inventoryRaw) {
      return new Response(
        "Waiting for GitHub to confirm this installation. Refresh in a moment.",
        { status: 409, headers: { "retry-after": "2" } },
      );
    }
    const inventory = JSON.parse(inventoryRaw) as {
      senderGithubId?: number;
    };
    if (inventory.senderGithubId !== pending.user.id) {
      return new Response(
        "This GitHub installation does not belong to the signed-in user.",
        { status: 403 },
      );
    }
  }

  try {
    const repositories = await fetchInstallationRepositories(
      env,
      installationId,
    );
    const updated: PendingSetup = {
      ...pending,
      installationId,
      repositories,
    };
    await env.OAUTH_KV.put(setupKey(handle), JSON.stringify(updated), {
      expirationTtl: remainingTtl(updated),
    });
    return pickerResponse(handle, repositories, await bindSetupCookie(handle));
  } catch {
    // Our copy, never the exception text: internal error strings are
    // meaningless to the reader and can disclose gateway internals.
    return errorPage({
      status: 502,
      title: "GitHub App setup did not finish",
      message:
        "Wayform could not read the repositories for that installation. This is usually temporary.",
      hint: "Close this tab and start the connection again from your editor.",
    });
  }
}

export async function handleRepositorySelection(
  request: Request,
  env: Env,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return new Response("invalid form", { status: 400 });
  }
  const handle = stringField(form, "setup_handle");
  const selectedName = stringField(form, "repository");
  if (!handle || !selectedName) {
    return new Response("missing repository selection", { status: 400 });
  }
  const pending = await readPending(env, handle);
  if (!pending) return expiredSetupResponse(env, handle);
  try {
    validateCSRFToken(form, request);
  } catch {
    return new Response("CSRF validation failed", { status: 400 });
  }
  if (!(await validSetupCookie(request, handle))) {
    return new Response("setup state mismatch", { status: 400 });
  }
  if (isExpired(pending)) return expireSetup(env, handle, pending);
  if (!pending.installationId || !pending.repositories) {
    return new Response("installation setup is incomplete", { status: 400 });
  }
  const repository = pending.repositories.find(
    (item) => `${item.owner}/${item.repo}` === selectedName,
  );
  if (!repository) {
    return new Response("repository is not available to this installation", {
      status: 400,
    });
  }
  try {
    await validateMemoryRepository(env, pending.installationId, repository);
    const activated = await activateInstallation(env, {
      installationId: pending.installationId,
      owner: repository.owner,
      repo: repository.repo,
      branch: repository.defaultBranch!,
      actorGithubId: pending.user.id,
      actorLogin: pending.user.login,
    });
    if (activated === "preview") {
      await env.OAUTH_KV.delete(setupKey(handle));
      await env.OAUTH_KV.delete(returnKey(handle));
      return oauthError(
        pending.oauthRequest,
        "access_denied",
        "This GitHub account is not eligible to create a Wayform space.",
      );
    }
    if (activated === "space_conflict") {
      await env.OAUTH_KV.delete(setupKey(handle));
      await env.OAUTH_KV.delete(returnKey(handle));
      return oauthError(
        pending.oauthRequest,
        "access_denied",
        "This GitHub user already belongs to another Wayform space.",
      );
    }
    const member = await getMemberByGithubId(env, pending.user.id);
    if (!member || member.installationId !== pending.installationId) {
      await env.OAUTH_KV.delete(setupKey(handle));
      await env.OAUTH_KV.delete(returnKey(handle));
      return oauthError(
        pending.oauthRequest,
        "access_denied",
        "This installation is already assigned to another Wayform space.",
      );
    }
    if (!env.OAUTH_PROVIDER) {
      return new Response("oauth provider missing", { status: 500 });
    }
    const { redirectTo } = await (
      env as SetupEnv
    ).OAUTH_PROVIDER.completeAuthorization({
      request: pending.oauthRequest,
      userId: String(pending.user.id),
      metadata: { githubLogin: pending.user.login },
      scope: pending.oauthRequest.scope?.length
        ? pending.oauthRequest.scope
        : ["mcp"],
      props: {
        githubId: pending.user.id,
        githubLogin: pending.user.login,
      },
    });
    await env.OAUTH_KV.delete(setupKey(handle));
    await env.OAUTH_KV.delete(returnKey(handle));
    const headers = new Headers({ location: redirectTo });
    headers.append("set-cookie", clearCookie(SETUP_COOKIE));
    headers.append("set-cookie", clearCookie("__Host-CSRF_TOKEN"));
    return new Response(null, { status: 302, headers });
  } catch {
    return errorPage({
      status: 400,
      title: "That repository could not be set up",
      message:
        "Wayform could not prepare the repository you selected as this team's memory store.",
      hint: "Close this tab and start the connection again from your editor. If it keeps failing, try a different repository.",
    });
  }
}

function pickerResponse(
  handle: string,
  repositories: SetupRepository[],
  setupCookie: string,
): Response {
  const csrf = generateCSRFProtection();
  return htmlResponse(
    renderRepositoryPicker(handle, repositories, csrf.token),
    [setupCookie, csrf.setCookie],
  );
}

function renderInstallPage(installUrl: string): string {
  return page(
    "Install the Wayform GitHub App",
    `<p>Install Wayform on the private, initialized repository that will store your team's memory.</p>
    <p><a href="${escapeHtml(installUrl)}">Install Wayform on GitHub</a></p>`,
  );
}

function renderRepositoryPicker(
  handle: string,
  repositories: SetupRepository[],
  csrfToken: string,
): string {
  const firstSelectable = repositories.findIndex(
    (repository) => repository.private && repository.defaultBranch,
  );
  const choices =
    repositories.length === 0
      ? "<p>No repositories are available. Grant the App access to a private, initialized repository and try again.</p>"
      : repositories
          .map((repository, index) => {
            const name = `${repository.owner}/${repository.repo}`;
            const disabled =
              !repository.private || !repository.defaultBranch
                ? " disabled"
                : "";
            const note = !repository.private
              ? " (public repositories are not allowed)"
              : !repository.defaultBranch
                ? " (needs a first commit)"
                : "";
            return `<label><input type="radio" name="repository" value="${escapeHtml(
              name,
            )}"${index === firstSelectable ? " checked" : ""}${disabled}> ${escapeHtml(
              name + note,
            )}</label><br>`;
          })
          .join("\n");
  return page(
    "Choose the memory repository",
    `<form method="post" action="/install/select">
      <input type="hidden" name="setup_handle" value="${escapeHtml(handle)}">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
      ${choices}
      <p><button type="submit">Create Wayform space</button></p>
    </form>`,
  );
}

/** Delegates to the one shared shell so install steps match the consent screen. */
function page(title: string, body: string): string {
  return sharedPage({ title, body });
}

async function readPending(
  env: Env,
  handle: string,
): Promise<PendingSetup | null> {
  const raw = await env.OAUTH_KV.get(setupKey(handle));
  if (!raw) return null;
  try {
    return typeof raw === "string"
      ? (JSON.parse(raw) as PendingSetup)
      : (raw as PendingSetup);
  } catch {
    return null;
  }
}

async function expireSetup(
  env: Env,
  handle: string,
  pending: PendingSetup,
): Promise<Response> {
  await env.OAUTH_KV.delete(setupKey(handle));
  await env.OAUTH_KV.delete(returnKey(handle));
  return oauthError(
    pending.oauthRequest,
    "access_denied",
    "Wayform setup expired. Start the connection again.",
  );
}

async function expiredSetupResponse(
  env: Env,
  handle: string,
): Promise<Response> {
  const raw = await env.OAUTH_KV.get(returnKey(handle));
  if (!raw) return new Response("expired or unknown setup", { status: 400 });
  try {
    const request =
      typeof raw === "string"
        ? (JSON.parse(raw) as AuthRequest)
        : (raw as AuthRequest);
    await env.OAUTH_KV.delete(returnKey(handle));
    return oauthError(
      request,
      "access_denied",
      "Wayform setup expired. Start the connection again.",
    );
  } catch {
    return new Response("expired or unknown setup", { status: 400 });
  }
}

function oauthError(
  request: AuthRequest,
  code: string,
  description: string,
): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", code);
  redirect.searchParams.set("error_description", description);
  if (request.state) redirect.searchParams.set("state", request.state);
  if (request.issuer) redirect.searchParams.set("iss", request.issuer);
  // `new Response`, not Response.redirect: the latter is immutable, so any
  // caller appending a cookie-clearing header would throw at runtime.
  return new Response(null, {
    status: 302,
    headers: { Location: redirect.href },
  });
}

function isExpired(pending: PendingSetup): boolean {
  return Date.now() - pending.createdAt >= SETUP_TTL_SECONDS * 1000;
}

function remainingTtl(pending: PendingSetup): number {
  return Math.max(
    1,
    SETUP_TTL_SECONDS - Math.floor((Date.now() - pending.createdAt) / 1000),
  );
}

async function bindSetupCookie(handle: string): Promise<string> {
  return `${SETUP_COOKIE}=${await sha256Hex(
    handle,
  )}; ${COOKIE_ATTRS}; Max-Age=${SETUP_TTL_SECONDS}`;
}

async function validSetupCookie(
  request: Request,
  handle: string,
): Promise<boolean> {
  return cookieValue(request, SETUP_COOKIE) === (await sha256Hex(handle));
}

function setupKey(handle: string): string {
  return `oauth:setup:${handle}`;
}

function returnKey(handle: string): string {
  return `oauth:setup-return:${handle}`;
}

function clearCookie(name: string): string {
  return `${name}=; ${COOKIE_ATTRS}; Max-Age=0`;
}

function htmlResponse(html: string, cookies: string[]): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(html, { status: 200, headers });
}

function stringField(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" && value ? value : null;
}

function cookieValue(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const value = part.trim();
    if (value.startsWith(`${name}=`)) return value.slice(name.length + 1);
  }
  return null;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
