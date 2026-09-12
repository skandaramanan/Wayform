import { requireOperator } from "./tenancy.js";
import type { Env, HandlerCtx } from "./env.js";
import { indexDeps } from "./deps.js";

/**
 * POST /admin/golden-candidate — capture a real observed retrieval miss for a
 * human to later promote into eval/golden.json. Admin-secret gated; never
 * mutates the deterministic CI fixture directly.
 */
export async function handleAdminGoldenCandidate(
  req: Request,
  env: Env,
  ctx?: HandlerCtx,
): Promise<Response> {
  const denied = requireOperator(req, env, ctx);
  if (denied) return denied;
  const deps = indexDeps(env);
  if (!deps) return Response.json({ error: "index disabled" }, { status: 503 });

  let body: {
    space?: string;
    project?: string;
    query?: string;
    expectedFactId?: string;
    note?: string;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const space = body.space?.trim() ?? "";
  const query = body.query?.trim() ?? "";
  const expectedFactId = body.expectedFactId?.trim() ?? "";
  if (!space || !query || !expectedFactId) {
    return Response.json(
      { error: "missing space, query, or expectedFactId" },
      { status: 400 },
    );
  }
  await deps.db.recordGoldenCandidate({
    space,
    project: body.project?.trim() ?? "",
    query,
    expectedFactId,
    note: body.note,
    ts: new Date().toISOString(),
  });
  return Response.json({ ok: true });
}

/**
 * GET /admin/retrieval-log?space=&since=&limit= — read-only export of logged
 * retrievals for the offline τ calibration script. retrieval_log already
 * exists (Phase A); this only reads it.
 */
export async function handleAdminRetrievalLog(
  req: Request,
  env: Env,
  ctx?: HandlerCtx,
): Promise<Response> {
  const denied = requireOperator(req, env, ctx);
  if (denied) return denied;
  const deps = indexDeps(env);
  if (!deps) return Response.json({ error: "index disabled" }, { status: 503 });

  const url = new URL(req.url);
  const space = url.searchParams.get("space")?.trim() ?? "";
  if (!space) return Response.json({ error: "missing space" }, { status: 400 });
  const since =
    url.searchParams.get("since")?.trim() || new Date(0).toISOString();
  const limit = Math.min(
    1000,
    Math.max(1, Number(url.searchParams.get("limit") ?? 200) || 200),
  );
  const trigger = url.searchParams.get("trigger")?.trim() ?? "";
  const all = await deps.db.listRetrievalLog(space, since, limit);
  // Filtered here rather than in SQL: listRetrievalLog is shared with the eval
  // harness, and the guard's fire count is a pilot-scale read.
  // ponytail: in-memory filter, push into the query if the log outgrows `limit`.
  const rows = trigger ? all.filter((r) => r.trigger === trigger) : all;
  // The Phase E headline metric: how often the guard actually asked.
  const fired = rows.filter((r) => r.injected).length;
  return Response.json({ space, rows, fired });
}
