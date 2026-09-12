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
 * EVERY identity-gated path must sit under one of these. The provider only
 * validates the bearer token and populates `ctx.props` for these prefixes —
 * and, crucially, it also matches the token's AUDIENCE against the request
 * path (`audienceMatches`: same origin, and the request path must equal the
 * audience path or start with it). Every token is minted with
 * `resource=<origin>/mcp`, so a path outside /mcp can never present a valid
 * one, no matter how apiRoute is configured. That is why the admin routes live
 * at /mcp/admin/* rather than /admin/* — see the 2026-09-13 "Invalid audience"
 * failure.
 */
export const API_ROUTES = ["/mcp"] as const;

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
