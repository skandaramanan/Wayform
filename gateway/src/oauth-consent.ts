import { page, escapeHtml } from "./page.js";

/** Cloudflare securing-MCP cookie names: __Host- blocks subdomain attacks on workers.dev. */
export const CSRF_COOKIE = "__Host-CSRF_TOKEN";
export const CONSENTED_STATE_COOKIE = "__Host-CONSENTED_STATE";

const COOKIE_ATTRS = "HttpOnly; Secure; Path=/; SameSite=Lax";
const STATE_TTL_SECONDS = 600;

export interface OauthKv {
  get(key: string): Promise<unknown>;
  put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

export function generateCSRFProtection(): { token: string; setCookie: string } {
  const token = crypto.randomUUID();
  return {
    token,
    setCookie: `${CSRF_COOKIE}=${token}; ${COOKIE_ATTRS}; Max-Age=${STATE_TTL_SECONDS}`,
  };
}

export function validateCSRFToken(
  formData: FormData,
  request: Request,
): { clearCookie: string } {
  const tokenFromForm = formData.get("csrf_token");
  if (!tokenFromForm || typeof tokenFromForm !== "string") {
    throw new Error("CSRF token missing from form");
  }
  const tokenFromCookie = cookieValue(request, CSRF_COOKIE);
  if (!tokenFromCookie) {
    throw new Error("CSRF token cookie missing");
  }
  if (tokenFromForm !== tokenFromCookie) {
    throw new Error("CSRF token mismatch");
  }
  return {
    clearCookie: `${CSRF_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`,
  };
}

export function renderConsentPage(opts: {
  clientName: string;
  csrfToken: string;
  state: string;
}): string {
  const clientName = escapeHtml(opts.clientName);
  const csrfToken = escapeHtml(opts.csrfToken);
  const state = escapeHtml(opts.state);
  // "Cancel" submits the same form with deny=1 so the gateway can return a
  // proper OAuth `access_denied` to the client. A consent screen whose only
  // options are Approve or close-the-tab leaves the waiting client hanging.
  return page({
    title: "Authorize",
    heading: "Connect to Wayform",
    body: `<p class="lead"><strong>${clientName}</strong> is asking to connect to your team's shared planning memory.</p>
    <ul class="scopes">
      <li>Read decisions and context your team has recorded</li>
      <li>Write new decisions, attributed to your GitHub account</li>
      <li>Sign in with GitHub to confirm who you are</li>
    </ul>
    <form method="post" action="/authorize">
      <input type="hidden" name="csrf_token" value="${csrfToken}">
      <input type="hidden" name="state" value="${state}">
      <div class="actions">
        <button type="submit">Continue with GitHub</button>
        <button type="submit" name="deny" value="1" class="btn-secondary">Cancel</button>
      </div>
    </form>`,
    note: "Only continue if you started this from your editor — Cursor, Claude Code, Codex, or another MCP client.",
  });
}

export function githubAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("state", opts.state);
  return url.toString();
}

export async function createOAuthState(
  oauthReqInfo: unknown,
  kv: OauthKv,
  ttl = STATE_TTL_SECONDS,
): Promise<{ stateToken: string }> {
  const stateToken = crypto.randomUUID();
  await kv.put(`oauth:state:${stateToken}`, JSON.stringify(oauthReqInfo), {
    expirationTtl: ttl,
  });
  return { stateToken };
}

export async function bindStateToSession(
  stateToken: string,
): Promise<{ setCookie: string }> {
  const hashHex = await sha256Hex(stateToken);
  return {
    setCookie: `${CONSENTED_STATE_COOKIE}=${hashHex}; ${COOKIE_ATTRS}; Max-Age=${STATE_TTL_SECONDS}`,
  };
}

export async function consumeOAuthState(
  kv: OauthKv,
  stateToken: string,
): Promise<unknown | null> {
  const key = `oauth:state:${stateToken}`;
  const raw = await kv.get(key);
  if (raw == null) return null;
  await kv.delete(key);
  return typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
}

/** Cookie must be the SHA-256 of the state token (confused-deputy bind). */
export async function validateConsentedState(
  request: Request,
  stateToken: string,
): Promise<void> {
  const cookie = cookieValue(request, CONSENTED_STATE_COOKIE);
  if (!cookie) throw new Error("consent cookie missing");
  const expected = await sha256Hex(stateToken);
  if (cookie !== expected) throw new Error("consent state mismatch");
}

export function clearConsentedCookie(): string {
  return `${CONSENTED_STATE_COOKIE}=; ${COOKIE_ATTRS}; Max-Age=0`;
}

export function renderPreviewPage(): string {
  return page({
    title: "Preview",
    heading: "Wayform is in design-partner preview",
    body: `<p class="lead">You're signed in with GitHub, but no team space was created and nothing was indexed yet.</p>
    <p>If a teammate already uses Wayform, ask them to invite your GitHub username from their agent. If you were told you should have access, contact whoever sent you the MCP URL.</p>`,
    note: "You can close this tab.",
  });
}

export function encodeAuthState(oauthReqInfo: unknown): string {
  return btoa(JSON.stringify(oauthReqInfo));
}

export function decodeAuthState(encoded: string): unknown {
  return JSON.parse(atob(encoded));
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    if (trimmed.startsWith(`${name}=`)) return trimmed.slice(name.length + 1);
  }
  return null;
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
