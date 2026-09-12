import type { Env, HandlerCtx } from "./env.js";
import {
  handleAdminAddProductRepo,
  handleAdminListInstallations,
} from "./tenancy.js";
import { handleAdminAllowlist } from "./spaces.js";
import { handleMcp } from "./mcp.js";
import { handleHookRead } from "./hook-read.js";
import { handleHookPrompt } from "./hook-prompt.js";
import { handleHookGuard } from "./guard.js";
import { handleWebhook } from "./webhook.js";
import { handleAdminReindex } from "./reindex.js";
import {
  handleAdminClearSupersession,
  handleAdminSupersessionAudit,
} from "./admin-supersession.js";
import { handleApiRead } from "./api-read.js";
import {
  handleAdminGoldenCandidate,
  handleAdminRetrievalLog,
} from "./admin-eval.js";

/**
 * Browser-based MCP clients (ChatGPT's custom connector, Claude.ai web, etc.)
 * preflight any cross-origin POST with a JSON body via OPTIONS before sending
 * the real request. Without these headers the preflight 404s and the browser
 * blocks the real call — the token/route can be perfectly correct and the
 * client still fails. Stamped on every response, not just /mcp: OPTIONS is
 * answered generically and any actual request still enforces its own auth.
 */
const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
};

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/** Path routing only — each route's logic lives in its own module. */
export async function handleRequest(
  req: Request,
  env: Env,
  ctx?: HandlerCtx,
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return withCors(await route(req, env, ctx));
}

async function route(
  req: Request,
  env: Env,
  ctx?: HandlerCtx,
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json({ ok: true });
  }

  if (url.pathname === "/mcp/admin/installations" && req.method === "GET") {
    return handleAdminListInstallations(req, env, ctx);
  }

  if (url.pathname === "/mcp/admin/product-repos" && req.method === "POST") {
    return handleAdminAddProductRepo(req, env, ctx);
  }

  if (url.pathname === "/mcp/admin/allowlist") {
    return handleAdminAllowlist(req, env, ctx);
  }

  if (url.pathname === "/mcp/admin/reindex" && req.method === "POST") {
    return handleAdminReindex(req, env, ctx);
  }

  if (
    url.pathname === "/mcp/admin/supersession-audit" &&
    req.method === "GET"
  ) {
    return handleAdminSupersessionAudit(req, env, ctx);
  }

  if (
    url.pathname === "/mcp/admin/clear-supersession" &&
    req.method === "POST"
  ) {
    return handleAdminClearSupersession(req, env, ctx);
  }

  if (url.pathname === "/mcp/admin/golden-candidate" && req.method === "POST") {
    return handleAdminGoldenCandidate(req, env, ctx);
  }

  if (url.pathname === "/mcp/admin/retrieval-log" && req.method === "GET") {
    return handleAdminRetrievalLog(req, env, ctx);
  }

  if (url.pathname === "/webhook/github" && req.method === "POST") {
    return handleWebhook(req, env, ctx);
  }

  if (url.pathname === "/mcp/hook/read" && req.method === "GET") {
    return handleHookRead(req, env, ctx);
  }

  if (url.pathname === "/mcp/hook/prompt" && req.method === "POST") {
    return handleHookPrompt(req, env, ctx);
  }

  if (url.pathname === "/mcp/hook/guard" && req.method === "POST") {
    return handleHookGuard(req, env, ctx);
  }

  if (url.pathname === "/mcp/api/read" && req.method === "GET") {
    return handleApiRead(req, env, ctx);
  }

  if (url.pathname === "/mcp") {
    if (req.method === "POST") return handleMcp(req, env, ctx);
    return new Response("stateless server: POST one JSON-RPC message", {
      status: 405,
    });
  }

  const legacyPath = new Map([
    ["/hook/read", "/mcp/hook/read"],
    ["/hook/prompt", "/mcp/hook/prompt"],
    ["/api/read", "/mcp/api/read"],
    // Admin moved under /mcp on 2026-09-13 so operator tokens actually work:
    // the OAuth provider matches a token's audience against the REQUEST PATH,
    // and every token is minted with resource "<origin>/mcp", so nothing
    // outside that prefix can ever present a valid one.
    ["/admin/installations", "/mcp/admin/installations"],
    ["/admin/product-repos", "/mcp/admin/product-repos"],
    ["/admin/allowlist", "/mcp/admin/allowlist"],
    ["/admin/reindex", "/mcp/admin/reindex"],
    ["/admin/supersession-audit", "/mcp/admin/supersession-audit"],
    ["/admin/clear-supersession", "/mcp/admin/clear-supersession"],
    ["/admin/golden-candidate", "/mcp/admin/golden-candidate"],
    ["/admin/retrieval-log", "/mcp/admin/retrieval-log"],
  ]).get(url.pathname);
  if (legacyPath) {
    return new Response(`moved to ${legacyPath}`, { status: 410 });
  }

  return new Response("not found", { status: 404 });
}
