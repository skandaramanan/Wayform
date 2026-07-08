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
export const EXTRACT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

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
