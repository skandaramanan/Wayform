/**
 * Workers AI is the only metered service that can bill past the $5/mo Workers
 * Paid subscription: the 10,000 neurons/day free allocation is identical on
 * Free and Paid, but Free BLOCKS at the cap while Paid BILLS past it at
 * $0.011/1k. Requests, CPU-ms, KV ops and D1 rows all have 40x+ headroom
 * against the Paid plan's included amounts at pilot scale, so they need no
 * guard — this counter is the whole overage story.
 *
 * Tripping the budget throws, which extract.ts already treats as fail-open
 * (entry lands in the ledger unindexed, logged non-silently) — the same
 * degradation the Free plan produced at the cap, just chosen instead of
 * imposed. Raise DAILY_NEURON_BUDGET deliberately if you'd rather pay.
 */
import type { Env } from "./env.js";

/** Free allocation is 10,000/day account-wide; the headroom covers embedding
 *  calls (bge-base, a few neurons each) which share the same allocation. */
export const DAILY_NEURON_BUDGET = 9500;

/** Measured ~77 neurons per llama-3.3-70b-fp8-fast extraction at
 *  EXTRACT_MAX_TOKENS=1024; rounded up so the estimate errs toward stopping
 *  early rather than into an overage. */
export const EXTRACT_NEURON_COST = 100;

const budgetKey = () => `neuron-budget:${new Date().toISOString().slice(0, 10)}`;

/**
 * Reserve `cost` neurons against today's budget. Returns false when the day's
 * budget is spent. Fails OPEN (true) on KV errors: a broken counter must not
 * halt indexing, and the ceiling it protects is a few dollars, not an outage.
 */
export async function reserveNeurons(env: Env, cost: number): Promise<boolean> {
  let spent = 0;
  try {
    const raw = await env.ROUTING.get(budgetKey());
    spent = raw ? Number.parseInt(raw, 10) || 0 : 0;
  } catch {
    return true;
  }
  if (spent + cost > DAILY_NEURON_BUDGET) {
    console.log(
      `neuron_budget: exhausted spent=${spent} cost=${cost} budget=${DAILY_NEURON_BUDGET} — extraction skipped, entry stored unindexed`,
    );
    return false;
  }
  try {
    // ponytail: read-modify-write races can under-count under concurrency, so
    // the true ceiling is budget + (concurrent writes x cost) — bounded by the
    // headroom above, worth cents. Use a Durable Object if exactness matters.
    await env.ROUTING.put(budgetKey(), String(spent + cost), {
      expirationTtl: 48 * 60 * 60,
    });
  } catch {
    // best-effort: an unrecorded spend just costs one entry's worth of budget
  }
  return true;
}
