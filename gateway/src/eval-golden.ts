/**
 * Pure evaluation helpers (roadmap §7). No I/O, no LLM — unit-testable with
 * synthetic data. The golden harness and the calibration script import these.
 */

export interface GoldenCase {
  query: string;
  expectedIds: string[];
  note?: string;
}

export interface RecallResult {
  recall: number;
  perCase: { query: string; recall: number; missing: string[] }[];
}

/** Mean recall@k across cases, with per-case misses named for a loud CI failure. */
export function recallAtK(
  cases: GoldenCase[],
  retrievedByCase: string[][],
  k: number,
): RecallResult {
  const perCase = cases.map((c, i) => {
    const topK = (retrievedByCase[i] ?? []).slice(0, k);
    const inTop = new Set(topK);
    const found = c.expectedIds.filter((id) => inTop.has(id));
    const recall =
      c.expectedIds.length === 0 ? 1 : found.length / c.expectedIds.length;
    return {
      query: c.query,
      recall,
      missing: c.expectedIds.filter((id) => !inTop.has(id)),
    };
  });
  const recall =
    perCase.length === 0
      ? 1
      : perCase.reduce((s, p) => s + p.recall, 0) / perCase.length;
  return { recall, perCase };
}
