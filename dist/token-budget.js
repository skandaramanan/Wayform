/**
 * Cheap token estimate (chars/4) so the read path can budget context size
 * without a tokenizer dependency. Approximate by design: this is a soft
 * budget, not an exact accounting — over-estimating trims one entry short,
 * under-estimating is the failure mode that actually matters, so the ratio
 * errs conservative (4 chars/token is the standard rough English average).
 */
export function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
/** Default token budget for a read when the caller doesn't specify one. */
export const DEFAULT_BUDGET_TOKENS = 4000;
/** Approx fixed overhead per rendered entry block (header line + separator). */
export const ENTRY_OVERHEAD_TOKENS = 12;
//# sourceMappingURL=token-budget.js.map