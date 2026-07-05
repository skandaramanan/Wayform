import type { Env } from "./env.js";
import { handleAdminAddMember } from "./tenancy.js";

/** Path routing only — each route's logic lives in its own module. */
export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json({ ok: true });
  }

  if (url.pathname === "/admin/members" && req.method === "POST") {
    return handleAdminAddMember(req, env);
  }

  return new Response("not found", { status: 404 });
}
