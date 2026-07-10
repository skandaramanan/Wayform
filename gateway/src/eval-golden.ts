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

export interface Judged {
  score: number;
  relevant: boolean;
}

export interface TauRecommendation {
  tau: number | null;
  precision: number;
  buckets: { lo: number; hi: number; n: number; relevant: number }[];
}

/**
 * Sweep candidate thresholds ascending; return the lowest τ at which the facts
 * scoring ≥ τ hit the precision target (keeps the most facts while meeting the
 * bar). Recommend-only — a human edits the TAU constant. Buckets are for the
 * printed report. `null` τ means no threshold reached the target.
 */
export function recommendTau(
  judged: Judged[],
  target = 0.9,
  bucketWidth = 0.02,
): TauRecommendation {
  const thresholds = [...new Set(judged.map((j) => j.score))].sort(
    (a, b) => a - b,
  );
  let tau: number | null = null;
  let precision = 0;
  for (const t of thresholds) {
    const kept = judged.filter((j) => j.score >= t);
    if (kept.length === 0) continue;
    const p = kept.filter((j) => j.relevant).length / kept.length;
    if (p >= target) {
      tau = t;
      precision = p;
      break;
    }
  }
  const buckets: TauRecommendation["buckets"] = [];
  if (judged.length > 0) {
    const max = Math.max(...judged.map((j) => j.score));
    for (let lo = 0; lo <= max; lo += bucketWidth) {
      const hi = lo + bucketWidth;
      const inBucket = judged.filter((j) => j.score >= lo && j.score < hi);
      if (inBucket.length > 0) {
        buckets.push({
          lo,
          hi,
          n: inBucket.length,
          relevant: inBucket.filter((j) => j.relevant).length,
        });
      }
    }
  }
  return { tau, precision, buckets };
}
