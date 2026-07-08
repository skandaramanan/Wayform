import type { Env } from "./env.js";
import { handleAdminAddMember } from "./tenancy.js";
import { handleMcp } from "./mcp.js";
import { handleHookRead } from "./hook-read.js";
import { handleWebhook } from "./webhook.js";
import { handleAdminReindex } from "./reindex.js";
import { handleApiRead } from "./api-read.js";

/** Path routing only — each route's logic lives in its own module. */
export async function handleRequest(
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

  if (url.pathname === "/admin/reindex" && req.method === "POST") {
    return handleAdminReindex(req, env);
  }

  if (url.pathname === "/webhook/github" && req.method === "POST") {
    return handleWebhook(req, env, ctx);
  }

  if (url.pathname === "/mcp") {
    if (req.method === "POST") return handleMcp(req, env);
    return new Response("stateless server: POST one JSON-RPC message", {
      status: 405,
    });
  }

  if (url.pathname === "/hook/read" && req.method === "GET") {
    return handleHookRead(req, env);
  }

  if (url.pathname === "/api/read" && req.method === "GET") {
    return handleApiRead(req, env);
  }

  return new Response("not found", { status: 404 });
}
