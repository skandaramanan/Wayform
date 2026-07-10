import type { Env } from "./env.js";
import {
  handleAdminAddMember,
  handleAdminListInstallations,
} from "./tenancy.js";
import { handleMcp } from "./mcp.js";
import { handleHookRead } from "./hook-read.js";
import { handleHookPrompt } from "./hook-prompt.js";
import { handleWebhook } from "./webhook.js";
import { handleAdminReindex } from "./reindex.js";
import {
  handleAdminClearSupersession,
  handleAdminSupersessionAudit,
} from "./admin-supersession.js";
import { handleApiRead } from "./api-read.js";

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
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return withCors(await route(req, env, ctx));
}

async function route(
  req: Request,
  env: Env,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json({ ok: true });
  }

  if (url.pathname === "/admin/members" && req.method === "POST") {
    return handleAdminAddMember(req, env);
  }

  if (url.pathname === "/admin/installations" && req.method === "GET") {
    return handleAdminListInstallations(req, env);
  }

  if (url.pathname === "/admin/reindex" && req.method === "POST") {
    return handleAdminReindex(req, env);
  }

  if (url.pathname === "/admin/supersession-audit" && req.method === "GET") {
    return handleAdminSupersessionAudit(req, env);
  }

  if (url.pathname === "/admin/clear-supersession" && req.method === "POST") {
    return handleAdminClearSupersession(req, env);
  }

  if (url.pathname === "/webhook/github" && req.method === "POST") {
    return handleWebhook(req, env, ctx);
  }

  // `/mcp` (token in header/query) or `/mcp/<token>` (token in path, for
  // header-less clients like ChatGPT's connector).
  if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
    if (req.method === "POST") return handleMcp(req, env, ctx);
    return new Response("stateless server: POST one JSON-RPC message", {
      status: 405,
    });
  }

  if (url.pathname === "/hook/read" && req.method === "GET") {
    return handleHookRead(req, env);
  }

  if (url.pathname === "/hook/prompt" && req.method === "POST") {
    return handleHookPrompt(req, env);
  }

  if (url.pathname === "/api/read" && req.method === "GET") {
    return handleApiRead(req, env);
  }

  return new Response("not found", { status: 404 });
}
