import type { Env } from "./env.js";
import { handleAdminAddMember } from "./tenancy.js";
import { handleMcp } from "./mcp.js";

/** Path routing only — each route's logic lives in its own module. */
export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json({ ok: true });
  }

  if (url.pathname === "/admin/members" && req.method === "POST") {
    return handleAdminAddMember(req, env);
  }

  if (url.pathname === "/mcp") {
    if (req.method === "POST") return handleMcp(req, env);
    return new Response("stateless server: POST one JSON-RPC message", {
      status: 405,
    });
  }

  return new Response("not found", { status: 404 });
}
