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

/** MCP OAuth 2.1 wrapper: RFC 9728 metadata, DCR, CIMD, PKCE S256. */
export function createGatewayOAuthProvider(): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: "/mcp",
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
