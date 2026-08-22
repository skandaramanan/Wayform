import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./env.js";
import { handleAuthorize } from "./oauth-handler.js";
import { handleRequest } from "./router.js";

type WaitCtx = { waitUntil(p: Promise<unknown>): void };

const apiHandler = {
  fetch(request: Request, env: Env, ctx: WaitCtx): Promise<Response> {
    return handleRequest(request, env, ctx);
  },
};

const defaultHandler = {
  fetch(request: Request, env: Env, ctx: WaitCtx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/authorize") return handleAuthorize(request, env);
    return handleRequest(request, env, ctx);
  },
};

/** MCP OAuth 2.1 wrapper: RFC 9728 metadata, DCR, CIMD, PKCE S256. */
export function createGatewayOAuthProvider(): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: ["/mcp", "/hook/read", "/hook/prompt", "/api/read"],
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
