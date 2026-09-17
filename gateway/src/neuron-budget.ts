/**
 * Workers AI is the only metered service that can bill past the $5/mo Workers
 * Paid subscription: the 10,000 neurons/day free allocation is identical on
 * Free and Paid, but Free BLOCKS at the cap while Paid BILLS past it at
 * $0.011/1k. Requests, CPU-ms, KV ops and D1 rows all have 40x+ headroom
 * against the Paid plan's included amounts at pilot scale, so they need no
 * guard — this counter is the whole overage story.
 *
 * Each model call reserves an estimate sized by what the call is for, then
 * settles against the token usage the model reports (deps.ts), so the counter
 * tracks the real bill instead of a flat per-call guess.
 *
 * Tripping the budget throws, which extract.ts already treats as fail-open
 * (entry lands in the ledger unindexed, logged non-silently) — the same
 * degradation the Free plan produced at the cap, just chosen instead of
 * imposed. Raise the limit for ONE day with a dated KV key (below) if you'd
 * rather pay to finish a job sooner.
 */
import type { Env } from "./env.js";

/** Free allocation is 10,000/day account-wide; the headroom covers embedding
 *  calls (bge-base, a few neurons each) which share the same allocation. */
export const DAILY_NEURON_BUDGET = 9500;

/**
 * Ceiling on any one-day raise, whatever the KV key says: 90,000 neurons is
 * at most (90,000 - 10,000 free) x $0.011/1k = $0.88 of overage. A typo in the
 * key can therefore never unlock a real bill.
 */
export const NEURON_BUDGET_HARD_MAX = 90_000;

const today = () => new Date().toISOString().slice(0, 10);
const budgetKey = () => `neuron-budget:${today()}`;
/** `neuron-budget-limit:<YYYY-MM-DD>` = a number. It only ever applies to its
 *  own UTC date, so a raise expires by itself at midnight. */
export const budgetLimitKey = (date = today()) => `neuron-budget-limit:${date}`;

const TTL = { expirationTtl: 48 * 60 * 60 };

async function readSpent(env: Env): Promise<number> {
  const raw = await env.ROUTING.get(budgetKey());
  return raw ? Number.parseInt(raw, 10) || 0 : 0;
}

/** Today's limit: the dated raise if one is set, never above the hard max. */
export async function dailyNeuronLimit(env: Env): Promise<number> {
  try {
    const raw = await env.ROUTING.get(budgetLimitKey());
    const raised = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(raised) && raised > DAILY_NEURON_BUDGET) {
      return Math.min(raised, NEURON_BUDGET_HARD_MAX);
    }
  } catch {
    // fall through to the default
  }
  return DAILY_NEURON_BUDGET;
}

/**
 * Reserve `cost` neurons against today's budget. Returns false when the day's
 * budget is spent. Fails OPEN (true) on KV errors: a broken counter must not
 * halt indexing, and the ceiling it protects is a few dollars, not an outage.
 */
export async function reserveNeurons(env: Env, cost: number): Promise<boolean> {
  let spent = 0;
  try {
    spent = await readSpent(env);
  } catch {
    return true;
  }
  const limit = await dailyNeuronLimit(env);
  if (spent + cost > limit) {
    // Structured like every other control-path signal (webhook_rejected,
    // pr_drop, admin_denied) so it is greppable in `wrangler tail`. This
    // fired all day on 2026-09-12 AND 2026-09-13 and nothing surfaced it: a
    // reindex reported success while quietly indexing the back half of the
    // corpus with no model at all.
    console.log(
      JSON.stringify({
        evt: "neuron_budget_exhausted",
        spent,
        cost,
        budget: limit,
        impact:
          "model call skipped — extraction floors and is retried after the reset; judging is skipped",
      }),
    );
    return false;
  }
  try {
    // ponytail: read-modify-write races can under-count under concurrency, so
    // the true ceiling is budget + (concurrent calls x cost) — bounded by the
    // headroom above, worth cents. Use a Durable Object if exactness matters.
    await env.ROUTING.put(budgetKey(), String(spent + cost), TTL);
  } catch {
    // best-effort: an unrecorded spend just costs one call's worth of budget
  }
  return true;
}

/**
 * Settle a reservation against what the call actually used. Without this the
 * counter drifts from the real bill in whichever direction the estimate errs.
 * Best-effort and never below zero.
 */
export async function adjustNeurons(env: Env, delta: number): Promise<void> {
  try {
    const spent = await readSpent(env);
    await env.ROUTING.put(budgetKey(), String(Math.max(0, spent + delta)), TTL);
  } catch {
    // best-effort: the next reservation reads whatever did land
  }
}

/**
 * Neurons still available today, or null when the counter cannot be read
 * (fail-open: a broken counter must not halt indexing).
 *
 * Exists so a BULK operation can stop deliberately instead of discovering
 * exhaustion one throw at a time. On 2026-09-13 a reindex of 202 entries ran
 * against a 95-call/day allocation: it spent the budget partway, then every
 * remaining entry silently took the floor path, and the reindex still reported
 * success while leaving the index WORSE than the one it replaced.
 */
export async function remainingNeurons(env: Env): Promise<number | null> {
  try {
    const limit = await dailyNeuronLimit(env);
    return Math.max(0, limit - (await readSpent(env)));
  } catch {
    return null;
  }
}
