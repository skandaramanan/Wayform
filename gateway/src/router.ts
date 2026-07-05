import type { Env } from "./env.js";

/** Path routing only — each route's logic lives in its own module. */
export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json({ ok: true });
  }

  return new Response("not found", { status: 404 });
}
