import type { Env } from "./env.js";
import { indexDeps } from "./deps.js";

export async function handleAdminSupersessionAudit(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const deps = indexDeps(env);
  if (!deps) return Response.json({ error: "index disabled" }, { status: 503 });

  const url = new URL(req.url);
  const space = url.searchParams.get("space")?.trim() ?? "";
  if (!space) return Response.json({ error: "missing space" }, { status: 400 });
  const limit = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get("limit") ?? 20) || 20),
  );
  const autoLinkedOnly = url.searchParams.get("auto_linked_only") !== "0";

  const rows = await deps.db.listSupersessionAudit(
    space,
    limit,
    autoLinkedOnly,
  );
  return Response.json({ space, rows });
}

export async function handleAdminClearSupersession(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const deps = indexDeps(env);
  if (!deps) return Response.json({ error: "index disabled" }, { status: 503 });

  let body: { space?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const space = body.space?.trim() ?? "";
  if (!space) return Response.json({ error: "missing space" }, { status: 400 });

  const cleared = await deps.db.clearAllSupersession(space);
  return Response.json({ space, cleared });
}
