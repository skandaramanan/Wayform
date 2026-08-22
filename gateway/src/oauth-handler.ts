import {
  AuthorizationError,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env.js";
import {
  bindStateToSession,
  createOAuthState,
  decodeAuthState,
  encodeAuthState,
  generateCSRFProtection,
  githubAuthorizeUrl,
  renderConsentPage,
  validateCSRFToken,
  consumeOAuthState,
  validateConsentedState,
  clearConsentedCookie,
  renderPreviewPage,
} from "./oauth-consent.js";
import {
  exchangeGithubCode,
  fetchGithubInstallations,
  fetchGithubUser,
  fetchInstallationRepos,
} from "./github-oauth.js";
import { placeGithubUser } from "./spaces.js";

interface AuthorizeEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

export async function handleAuthorize(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.OAUTH_PROVIDER) {
    return new Response("oauth provider missing", { status: 500 });
  }
  const oauthEnv = env as AuthorizeEnv;
  if (request.method === "POST") return postAuthorize(request, oauthEnv);
  if (request.method === "GET") return getAuthorize(request, oauthEnv);
  return new Response("method not allowed", { status: 405 });
}

async function getAuthorize(
  request: Request,
  env: AuthorizeEnv,
): Promise<Response> {
  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (error) {
    return authorizationErrorResponse(error);
  }

  const client = await env.OAUTH_PROVIDER.lookupClient(oauthReqInfo.clientId);
  if (!client) {
    return new Response("Unknown OAuth client", { status: 400 });
  }

  const { token, setCookie } = generateCSRFProtection();
  const html = renderConsentPage({
    clientName: client.clientName ?? "an MCP client",
    csrfToken: token,
    state: encodeAuthState(oauthReqInfo),
  });
  return new Response(html, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "set-cookie": setCookie,
    },
  });
}

async function postAuthorize(
  request: Request,
  env: AuthorizeEnv,
): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID) {
    return new Response("GitHub OAuth is not configured", { status: 503 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return new Response("invalid form", { status: 400 });
  }

  let clearCsrf: string;
  try {
    clearCsrf = validateCSRFToken(formData, request).clearCookie;
  } catch {
    return new Response("CSRF validation failed", { status: 400 });
  }

  const encodedState = formData.get("state");
  if (!encodedState || typeof encodedState !== "string") {
    return new Response("missing state", { status: 400 });
  }

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = decodeAuthState(encodedState) as AuthRequest;
  } catch {
    return new Response("invalid state", { status: 400 });
  }
  if (!oauthReqInfo?.clientId) {
    return new Response("invalid state", { status: 400 });
  }

  const { stateToken } = await createOAuthState(oauthReqInfo, env.OAUTH_KV);
  const { setCookie: consented } = await bindStateToSession(stateToken);
  const location = githubAuthorizeUrl({
    clientId: env.GITHUB_CLIENT_ID,
    redirectUri: new URL("/callback", request.url).href,
    state: stateToken,
  });

  const headers = new Headers({ Location: location });
  headers.append("Set-Cookie", clearCsrf);
  headers.append("Set-Cookie", consented);
  return new Response(null, { status: 302, headers });
}

export async function handleGithubCallback(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.OAUTH_PROVIDER) {
    return new Response("oauth provider missing", { status: 500 });
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  if (!code || !stateToken) {
    return new Response("missing code or state", { status: 400 });
  }
  try {
    await validateConsentedState(request, stateToken);
  } catch {
    return new Response("consent state mismatch", { status: 400 });
  }
  const oauthReqInfo = (await consumeOAuthState(
    env.OAUTH_KV,
    stateToken,
  )) as AuthRequest | null;
  if (!oauthReqInfo?.clientId) {
    return new Response("expired or unknown state", { status: 400 });
  }

  const fetchImpl = env.githubFetch ?? fetch;
  try {
    const ghToken = await exchangeGithubCode(
      env,
      code,
      new URL("/callback", request.url).href,
    );
    const user = await fetchGithubUser(ghToken, fetchImpl);
    const installations = await fetchGithubInstallations(ghToken, fetchImpl);
    const placed = await placeGithubUser(
      env,
      user,
      installations,
      (installationId) =>
        fetchInstallationRepos(ghToken, installationId, fetchImpl),
    );
    if (placed.kind === "preview") {
      return new Response(renderPreviewPage(), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": clearConsentedCookie(),
        },
      });
    }

    const oauthEnv = env as AuthorizeEnv;
    const { redirectTo } = await oauthEnv.OAUTH_PROVIDER.completeAuthorization({
      request: oauthReqInfo,
      userId: String(user.id),
      metadata: { githubLogin: user.login },
      scope: oauthReqInfo.scope?.length ? oauthReqInfo.scope : ["mcp"],
      props: { githubId: user.id, githubLogin: user.login },
    });
    const headers = new Headers({ Location: redirectTo });
    headers.append("Set-Cookie", clearConsentedCookie());
    return new Response(null, { status: 302, headers });
  } catch (err) {
    return new Response(
      err instanceof Error ? err.message : "github oauth failed",
      { status: 502 },
    );
  }
}

function authorizationErrorResponse(error: unknown): Response {
  if (!(error instanceof AuthorizationError)) throw error;
  if (!error.redirectUri) {
    return new Response(error.description, { status: 400 });
  }
  const redirect = new URL(error.redirectUri);
  redirect.searchParams.set("error", error.code);
  redirect.searchParams.set("error_description", error.description);
  if (error.state) redirect.searchParams.set("state", error.state);
  if (error.issuer) redirect.searchParams.set("iss", error.issuer);
  return Response.redirect(redirect, 302);
}
