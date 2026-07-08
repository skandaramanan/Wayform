/**
 * Resolve the index plane's dependencies from bindings (production) or test
 * seams. Null means "no index configured" — every caller must fall back to
 * the recency path (fail-open invariant).
 */
import type { Env } from "./env.js";
import { d1IndexDb, type IndexDb } from "./index-db.js";
import type { Embedder } from "./retrieval.js";
import type { GenText } from "./extract.js";

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
// Non-deprecated as of 2026-07; the bare @cf/meta/llama-3.1-8b-instruct was
// deprecated 2026-05-30 (Workers AI error 5028). A 70B model also emits far
// cleaner JSON for extraction than an 8B. Still on the free-tier neuron
// allocation at pilot volume. If Workers AI deprecates it, the non-silent
// fail-open in extract.ts surfaces error 5028 in `wrangler tail`.
export const EXTRACT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export function indexDeps(
  env: Env,
): { db: IndexDb; embed: Embedder | null; gen: GenText | null } | null {
  const db = env.indexDb ?? (env.DB ? d1IndexDb(env.DB) : null);
  if (!db) return null;
  const embed =
    env.embedder ??
    (env.AI
      ? async (texts: string[]) =>
          (await env.AI!.run(EMBED_MODEL, { text: texts })).data
      : null);
  const gen: GenText | null =
    env.genText ??
    (env.AI
      ? async (prompt: string) =>
          (await env.AI!.run(EXTRACT_MODEL, { prompt })).response
      : null);
  return { db, embed, gen };
}
