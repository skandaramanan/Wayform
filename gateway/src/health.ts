/**
 * GET /health?deep=1 — production invariants a daily GitHub Action polls.
 *
 * Every check here is a bug that shipped green: on 2026-09-18 we found stored
 * vectors decoding to 3072 byte values (semantic retrieval silently off for
 * weeks) and a cron dying on memory every tick. Tests passed throughout; only
 * production data showed it. Aggregates only — no ids, bodies or spaces.
 */
import type { Env } from "./env.js";
import { decodeEmbedding } from "./index-db.js";
import { cosineTopK } from "./rank.js";

export const CRON_LAST_RUN_KEY = "cron-last-run";
const EMBED_DIMS = 768;
const HOUR_MS = 60 * 60_000;

export async function deepHealth(env: Env): Promise<Response> {
  const db = env.DB;
  if (!db)
    return Response.json({ ok: false, error: "no index" }, { status: 503 });
  const hourAgo = new Date(Date.now() - HOUR_MS).toISOString();

  const { results } = await db
    .prepare(
      "SELECT id, embedding FROM docs WHERE superseded_by IS NULL " +
        "ORDER BY created_at DESC LIMIT 20",
    )
    .all();
  const docs = results.map((r) => ({
    id: r.id as string,
    embedding: decodeEmbedding(r.embedding as ArrayBuffer | null),
  }));
  const stuck = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM ingest_state WHERE status = 'pending' AND updated_at < ?",
    )
    .bind(hourAgo)
    .first();
  const lastRun = await env.ROUTING.get(CRON_LAST_RUN_KEY);

  const checks = {
    embeddingsDecode:
      docs.length > 0 && docs.every((d) => d.embedding.length === EMBED_DIMS),
    cosineSelfMatch:
      docs.length > 0 &&
      cosineTopK(docs, docs[0].embedding, 1)[0]?.id === docs[0].id,
    noStuckPending: Number(stuck?.n ?? 0) === 0,
    cronRanLastHour: !!lastRun && lastRun > hourAgo,
  };
  const ok = Object.values(checks).every(Boolean);
  return Response.json(
    { ok, checks, lastCron: lastRun },
    { status: ok ? 200 : 503 },
  );
}
