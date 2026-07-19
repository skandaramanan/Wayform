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
// Cheaper-model swap evaluated and REJECTED 2026-07-20 (12-entry fixture,
// production prompt + parser, wrangler dev --remote): llama-3.1-8b-fp8-fast
// hallucinates entities and tags nearly everything canon (pollutes the
// session-start briefing); qwen3-30b-a3b-fp8's thinking chatter starves the
// token budget. Cheap models fail INTO the index; 70B failures floor safely.
// If the ~77-neurons/write ceiling binds at pilot load, the backstop is the
// $5/mo paid plan, not a model downgrade.
// Workers AI defaults max_tokens to 256, which truncates multi-fact JSON
// arrays mid-emission — the parser then floors the whole entry. 1024 covers
// the largest observed 5-fact output with headroom.
export const EXTRACT_MAX_TOKENS = 1024;

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
          (
            await env.AI!.run(EXTRACT_MODEL, {
              prompt,
              max_tokens: EXTRACT_MAX_TOKENS,
            })
          ).response
      : null);
  return { db, embed, gen };
}
