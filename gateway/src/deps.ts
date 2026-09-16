/**
 * Resolve the index plane's dependencies from bindings (production) or test
 * seams. Null means "no index configured" — every caller must fall back to
 * the recency path (fail-open invariant).
 */
import type { Env } from "./env.js";
import { d1IndexDb, type IndexDb } from "./index-db.js";
import type { Embedder } from "./retrieval.js";
import type { GenText } from "./extract.js";
import { reserveNeurons, adjustNeurons } from "./neuron-budget.js";
import { estimateTokens } from "../../src/token-budget.js";

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

/** A verdict is one JSON object with a one-sentence reason (~40 tokens). It
 *  used to inherit the 1024 extraction ceiling, so a rambling judge could
 *  bill ~20x what the answer needs. */
export const JUDGE_MAX_TOKENS = 160;

/** EXTRACT_MODEL list price in neurons per million tokens (Workers AI pricing
 *  page, retrieved 2026-09-13). Output costs ~8x input, so what a call is FOR
 *  decides what it costs. */
export const NEURONS_PER_M_INPUT = 26_668;
export const NEURONS_PER_M_OUTPUT = 204_805;

/** Typical completion lengths, used only to RESERVE before a call; the model's
 *  reported usage settles the counter after. Extraction measured ~77 neurons
 *  (~285 output tokens); a verdict is ~40 tokens. */
const EXPECTED_OUTPUT_TOKENS = { extract: 350, judge: 48 } as const;

export function neuronsFor(inputTokens: number, outputTokens: number): number {
  return Math.ceil(
    (inputTokens * NEURONS_PER_M_INPUT + outputTokens * NEURONS_PER_M_OUTPUT) /
      1_000_000,
  );
}

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
      ? async (prompt, opts = {}) => {
          const purpose = opts.purpose ?? "extract";
          // Every call used to reserve a flat 100 neurons, so a judge (~13
          // real neurons) cost the budget as much as an extraction and the
          // self-imposed cap tripped long before the real bill did.
          const estimate = neuronsFor(
            estimateTokens(prompt),
            EXPECTED_OUTPUT_TOKENS[purpose],
          );
          if (!(await reserveNeurons(env, estimate))) {
            throw new Error("neuron budget exhausted for today");
          }
          const out = await env.AI!.run(EXTRACT_MODEL, {
            prompt,
            max_tokens:
              purpose === "judge" ? JUDGE_MAX_TOKENS : EXTRACT_MAX_TOKENS,
          });
          const u = out.usage;
          if (
            u &&
            Number.isFinite(u.prompt_tokens) &&
            Number.isFinite(u.completion_tokens)
          ) {
            const delta =
              neuronsFor(u.prompt_tokens, u.completion_tokens) - estimate;
            if (delta !== 0) await adjustNeurons(env, delta);
          }
          // Workers AI parses the completion itself when it is valid JSON, so
          // `response` arrives as an OBJECT exactly when the model did its job.
          // Every parser downstream calls string methods on it, threw, and
          // fell back: clean extractions floored and clean verdicts became
          // "uncertain" (found 2026-09-17 replaying floored entries).
          return typeof out.response === "string"
            ? out.response
            : JSON.stringify(out.response);
        }
      : null);
  return { db, embed, gen };
}
