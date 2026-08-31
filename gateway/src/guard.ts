/**
 * Phase E enforcement: judge a PROPOSED AGENT ACTION against live facts and ask
 * the human when it contradicts one.
 *
 * Zero new model code by design (spec decision 4): the action is phrased as the
 * NEW fact and handed to B2's existing judge, whose prompt already defines
 * "contradicts" as "both cannot be true". Only that verdict interrupts.
 *
 * FAIL-OPEN: every failure resolves to "allow". This sits on the hot path of
 * every edit — a guard that throws is worse than no guard.
 */
import { retrieve, type RetrieveDeps } from "./retrieval.js";
import { judgePair, SYNC_JUDGE_LIMIT } from "./supersede.js";
import type { GenText } from "./extract.js";

/**
 * Deliberately far below DEFAULT_BUDGET_TOKENS: retrieve() fills to budget, and
 * every returned fact is a potential judge call the user waits on.
 */
export const GUARD_BUDGET_TOKENS = 400;

export interface GuardResult {
  decision: "ask" | "allow";
  reason: string;
  factIds: string[];
}

const ALLOW: GuardResult = { decision: "allow", reason: "", factIds: [] };

export async function checkAction(
  deps: RetrieveDeps & { gen: GenText | null },
  opts: { space: string; project: string; action: string },
): Promise<GuardResult> {
  try {
    const { results } = await retrieve(deps, {
      space: opts.space,
      project: opts.project,
      query: opts.action,
      budgetTokens: GUARD_BUDGET_TOKENS,
      trigger: "hook_guard",
    });
    if (results.length === 0 || !deps.gen) return ALLOW;

    for (const hit of results.slice(0, SYNC_JUDGE_LIMIT)) {
      const verdict = await judgePair(
        deps.gen,
        { body: `The agent is about to: ${opts.action}`, kind: "decision" },
        { id: hit.doc.id, body: hit.doc.body, kind: hit.doc.kind },
      );
      // Only "contradicts" interrupts (spec decision 5): B2 already settled
      // that uncertainty must never act.
      if (verdict.verdict === "contradicts") {
        return {
          decision: "ask",
          reason: `${hit.doc.body} — ${hit.doc.sourceAuthor}, ${hit.doc.sourceTs.slice(0, 10)}. ${verdict.reason}`,
          factIds: [hit.doc.id],
        };
      }
    }
    return ALLOW;
  } catch {
    return ALLOW;
  }
}
