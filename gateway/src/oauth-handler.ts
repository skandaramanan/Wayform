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
} from "./oauth-consent.js";
import {
  exchangeGithubCode,
  fetchGithubInstallations,
  fetchGithubUser,
  fetchInstallationRepositories,
} from "./github-oauth.js";
import { placeGithubUser } from "./spaces.js";
import { beginInstallSetup, type SetupRepository } from "./setup.js";
import { errorPage } from "./page.js";

interface AuthorizeEnv extends Env {
  OAUTH_PROVIDER: OAuthHelpers;
}

export async function handleAuthorize(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.OAUTH_PROVIDER) {
    return notConfigured();
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
    return errorPage({
      status: 400,
      title: "Unrecognized app",
      message:
        "The app that sent you here is not registered with Wayform, so we cannot show you what it is asking for.",
    });
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
  const githubClientId = env.GITHUB_CLIENT_ID?.trim();
  if (!githubClientId) {
    return notConfigured();
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorPage({
      status: 400,
      title: "Could not read that request",
      message: "The authorization form did not arrive in a readable form.",
    });
  }

  let clearCsrf: string;
  try {
    clearCsrf = validateCSRFToken(formData, request).clearCookie;
  } catch {
    return errorPage({
      status: 400,
      title: "This page expired",
      message:
        "For your security, the authorization page is only valid for a few minutes and can only be submitted once.",
      hint: "Start the connection again from your editor — it takes a few seconds.",
    });
  }

  const encodedState = formData.get("state");
  if (!encodedState || typeof encodedState !== "string") {
    return expiredPage();
  }

  let oauthReqInfo: AuthRequest;
  try {
    oauthReqInfo = decodeAuthState(encodedState) as AuthRequest;
  } catch {
    return expiredPage();
  }
  if (!oauthReqInfo?.clientId) {
    return expiredPage();
  }

  // Explicit decline: hand the waiting client a real OAuth `access_denied`
  // rather than leaving it to time out on a closed tab.
  if (formData.get("deny")) {
    const denied = oauthErrorResponse(
      oauthReqInfo,
      "access_denied",
      "The user declined the authorization request.",
    );
    denied.headers.append("Set-Cookie", clearCsrf);
    return denied;
  }

  const { stateToken } = await createOAuthState(oauthReqInfo, env.OAUTH_KV);
  const { setCookie: consented } = await bindStateToSession(stateToken);
  const location = githubAuthorizeUrl({
    clientId: githubClientId,
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
    return notConfigured();
  }
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateToken = url.searchParams.get("state");
  if (!code || !stateToken) {
    return errorPage({
      status: 400,
      title: "Incomplete sign-in",
      message:
        "GitHub sent you back without the details Wayform needs to finish connecting.",
    });
  }
  try {
    await validateConsentedState(request, stateToken);
  } catch {
    return errorPage({
      status: 400,
      title: "This sign-in could not be verified",
      message:
        "The response from GitHub does not match the browser that started this authorization. This protects you from a link that tries to connect an app on your behalf.",
      hint: "Start the connection again from your editor, in this same browser.",
    });
  }
  const oauthReqInfo = (await consumeOAuthState(
    env.OAUTH_KV,
    stateToken,
  )) as AuthRequest | null;
  if (!oauthReqInfo?.clientId) {
    return expiredPage();
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
    const placed = await placeGithubUser(env, user, installations);
    if (placed.kind === "preview") {
      let installationId: number | undefined;
      let repositories: SetupRepository[] | undefined;
      for (const installation of installations) {
        try {
          const discovered = await fetchInstallationRepositories(
            env,
            installation.id,
            fetchImpl,
          );
          if (discovered.length > 0) {
            installationId = installation.id;
            repositories = discovered;
            break;
          }
        } catch {
          // Offer App installation when no accessible repository can resume.
        }
      }
      const response = await beginInstallSetup(request, env, {
        oauthRequest: oauthReqInfo,
        user,
        installationId,
        repositories,
        allowedInstallationIds: installations.map(
          (installation) => installation.id,
        ),
      });
      response.headers.append("set-cookie", clearConsentedCookie());
      return response;
    }
    if (placed.kind === "space_conflict") {
      const response = oauthErrorResponse(
        oauthReqInfo,
        "access_denied",
        `This GitHub user already belongs to ${placed.existingSpace}. ` +
          "Multi-space membership is not available yet.",
      );
      response.headers.append("set-cookie", clearConsentedCookie());
      return response;
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
  } catch {
    // Deliberately NOT err.message: internal exception text means nothing to
    // the person reading it and can disclose gateway internals. The detail
    // belongs in the Workers log, which is where operators look.
    return errorPage({
      status: 502,
      title: "GitHub could not complete the sign-in",
      message:
        "Wayform reached GitHub but the sign-in did not finish. This is usually temporary.",
      hint: "Try connecting again in a moment. If it keeps failing, contact whoever sent you the Wayform URL.",
    });
  }
}

/** The gateway is missing its OAuth configuration — an operator problem. */
function notConfigured(): Response {
  return errorPage({
    status: 503,
    title: "Sign-in is unavailable",
    message:
      "This Wayform gateway is not fully configured for GitHub sign-in yet.",
    hint: "Nothing is wrong on your end. Contact whoever runs this gateway.",
  });
}

/** Shared copy for every expired / replayed / unreadable authorization state. */
function expiredPage(): Response {
  return errorPage({
    status: 400,
    title: "This sign-in expired",
    message:
      "Authorization requests are valid for a few minutes and can only be used once.",
    hint: "Start the connection again from your editor — it takes a few seconds.",
  });
}

/**
 * Built with `new Response`, NOT `Response.redirect`: the latter returns an
 * IMMUTABLE response, so every caller that appends a cookie-clearing header to
 * an OAuth error redirect threw `TypeError: immutable` and fell through to the
 * generic 502 instead of returning a clean `access_denied` to the client.
 */
function oauthErrorResponse(
  request: AuthRequest,
  code: string,
  description: string,
): Response {
  const redirect = new URL(request.redirectUri);
  redirect.searchParams.set("error", code);
  redirect.searchParams.set("error_description", description);
  if (request.state) redirect.searchParams.set("state", request.state);
  if (request.issuer) redirect.searchParams.set("iss", request.issuer);
  return new Response(null, {
    status: 302,
    headers: { Location: redirect.href },
  });
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
  // Mutable for the same reason as oauthErrorResponse above.
  return new Response(null, {
    status: 302,
    headers: { Location: redirect.href },
  });
}
