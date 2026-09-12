import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env, HandlerCtx } from "./env.js";
import { handleAuthorize, handleGithubCallback } from "./oauth-handler.js";
import { handleInstallCallback, handleRepositorySelection } from "./setup.js";
import { handleRequest } from "./router.js";

type WaitCtx = HandlerCtx;

const apiHandler = {
  fetch(request: Request, env: Env, ctx: WaitCtx): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};

const defaultHandler = {
  fetch(request: Request, env: Env, ctx: WaitCtx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    if (url.pathname === "/callback") return handleGithubCallback(request, env);
    if (url.pathname === "/install/callback") {
      return handleInstallCallback(request, env);
    }
    if (url.pathname === "/install/select") {
      return handleRepositorySelection(request, env);
    }
    return handleRequest(request, env, ctx);
  },
};

/**
 * Path prefixes the OAuth provider treats as API routes.
 *
 * EVERY prefix whose handlers check caller identity must appear here. The
 * provider only validates the bearer token and populates `ctx.props` for these
 * paths; anything else falls through to `defaultHandler` with the raw
 * Cloudflare ctx and NO props.
 *
 * This list was "/mcp" alone when /admin/* was moved onto operator identity,
 * so every admin request reached requireOperator with an undefined githubId
 * and 403'd for everyone, always — while the gateway suite stayed green,
 * because those tests inject env.oauthProps as a seam and never exercise the
 * provider. Exported so a test can assert the wiring the seam hides.
 */
export const API_ROUTES = ["/mcp", "/admin"] as const;

/** MCP OAuth 2.1 wrapper: RFC 9728 metadata, DCR, CIMD, PKCE S256. */
export function createGatewayOAuthProvider(): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: [...API_ROUTES],
    apiHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: ["mcp"],
    resourceMetadata: {
      resource_name: "Wayform",
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    },
  });
}
