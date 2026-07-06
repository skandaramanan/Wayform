/**
 * Cheap token estimate (chars/4) so the read path can budget context size
 * without a tokenizer dependency. Approximate by design: this is a soft
 * budget, not an exact accounting — over-estimating trims one entry short,
 * under-estimating is the failure mode that actually matters, so the ratio
 * errs conservative (4 chars/token is the standard rough English average).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Default token budget for a read when the caller doesn't specify one. */
export const DEFAULT_BUDGET_TOKENS = 4000;

/** Approx fixed overhead per rendered entry block (header line + separator). */
export const ENTRY_OVERHEAD_TOKENS = 12;

import type { ParsedEntry } from "./frontmatter.js";

/**
 * Select the most recent entries that fit `budgetTokens`, walking newest to
 * oldest. Always keeps at least the single most recent entry — an oversized
 * entry beats an empty read. `budgetTokens <= 0` means unlimited (returns
 * every entry), preserving the old count-cap's `limit <= 0` escape hatch.
 */
export function packToBudget(
  entries: ParsedEntry[],
  budgetTokens: number,
): ParsedEntry[] {
  if (budgetTokens <= 0 || entries.length === 0) return entries;

  const selected: ParsedEntry[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = estimateTokens(entries[i].payload) + ENTRY_OVERHEAD_TOKENS;
    if (selected.length > 0 && used + cost > budgetTokens) break;
    selected.push(entries[i]);
    used += cost;
  }
  return selected.reverse();
}
