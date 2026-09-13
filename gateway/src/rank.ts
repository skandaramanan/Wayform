/**
 * Pure scoring for the retrieval pipeline (§5 of the 2026-07-07 roadmap).
 * BM25 and cosine both run as exact scans in the Worker: a space holds
 * hundreds to low-thousands of docs, so exact scoring is single-digit ms and
 * needs no FTS5/ANN infrastructure (same rationale as §2.1's brute-force
 * cosine). Everything here is deterministic and dependency-free.
 */

export interface Scored {
  id: string;
  score: number;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const DEFAULT_TOP_K = 50;

export function bm25Rank(
  docs: { id: string; body: string }[],
  query: string,
  topK: number = DEFAULT_TOP_K,
  corpusDocCount?: number,
): Scored[] {
  const qTerms = [...new Set(tokenize(query))];
  if (qTerms.length === 0 || docs.length === 0) return [];

  // When the caller passes a bounded candidate set instead of the whole
  // corpus (§5.1 read-path hardening), `corpusDocCount` keeps idf's N at the
  // true corpus size. df stays exact because every doc containing a query
  // token is in the candidate set; avgLen over candidates is an accepted
  // approximation (RRF fuses by rank, not magnitude).
  const nTotal = Math.max(corpusDocCount ?? docs.length, docs.length);

  const docTokens = docs.map((d) => tokenize(d.body));
  const avgLen =
    docTokens.reduce((sum, t) => sum + t.length, 0) / docs.length || 1;

  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    const seen = new Set(tokens);
    for (const q of qTerms) if (seen.has(q)) df.set(q, (df.get(q) ?? 0) + 1);
  }

  const scored: Scored[] = [];
  docs.forEach((d, i) => {
    const tokens = docTokens[i];
    const tf = new Map<string, number>();
    for (const t of tokens) {
      if (qTerms.includes(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    let score = 0;
    for (const q of qTerms) {
      const f = tf.get(q) ?? 0;
      if (f === 0) continue;
      const n = df.get(q) ?? 0;
      const idf = Math.log(1 + (nTotal - n + 0.5) / (n + 0.5));
      score +=
        (idf * f * (BM25_K1 + 1)) /
        (f + BM25_K1 * (1 - BM25_B + (BM25_B * tokens.length) / avgLen));
    }
    if (score > 0) scored.push({ id: d.id, score });
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

export function cosineTopK(
  // ArrayLike so decoded Float32Array embeddings score without being spread
  // into boxed number[] (the pre-1102-fix hot spot).
  docs: { id: string; embedding: ArrayLike<number> }[],
  queryVec: ArrayLike<number>,
  topK: number = DEFAULT_TOP_K,
): Scored[] {
  const out: Scored[] = [];
  for (const d of docs) {
    if (queryVec.length === 0 || d.embedding.length !== queryVec.length)
      continue;
    let dot = 0;
    let a = 0;
    let b = 0;
    for (let i = 0; i < queryVec.length; i++) {
      dot += d.embedding[i] * queryVec[i];
      a += d.embedding[i] * d.embedding[i];
      b += queryVec[i] * queryVec[i];
    }
    if (a === 0 || b === 0) continue;
    out.push({ id: d.id, score: dot / Math.sqrt(a * b) });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, topK);
}

/**
 * RRF damping. 60 is the constant from the original RRF paper, tuned for
 * TREC-scale runs of thousands of documents per list. Our lists are capped at
 * DEFAULT_TOP_K=50, so K=60 exceeded the list length and flattened everything:
 * rank 0 and rank 9 differed by 13%, which meant the `decision` kind prior
 * (1.2x) outweighed THIRTEEN ranks of real relevance and `canon` (1.5x)
 * outweighed thirty-one. Priors beat the signal they were meant to nudge.
 *
 * 5 measured best over the real 425-doc corpus (eval harness, rank-based):
 * MRR 0.3058 -> 0.7667 together with the extraction floor-tag fix, top-3 1/5
 * -> 5/5. K=2 is worse (0.6667), so this is an optimum and not a limit.
 */
export const RRF_K = 5;

/**
 * How deep a single-generator hit may sit and still clear TAU. Holding this
 * fixed is what keeps TAU meaningful when RRF_K changes: at the old K=60 the
 * hardcoded TAU of 0.01 admitted a lone hit down to rank 39, and a bare K
 * change would silently have moved that to rank 94.
 */
export const TAU_RANK_DEPTH = 39;

/** Reciprocal rank fusion: parameter-free, robust with zero training data (§5.2). */
export function rrfFuse(lists: Scored[][]): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.forEach((s, rank) => {
      fused.set(s.id, (fused.get(s.id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return fused;
}

/**
 * Relevance floor on the adjusted score: candidates below τ are dropped even
 * when budget remains — returning nothing is a first-class outcome (§5.4).
 *
 * DERIVED from RRF_K rather than hardcoded, because the two are the same
 * calibration: τ only means anything relative to the score scale RRF_K sets.
 * This evaluates to 0.01 at the historical K=60 — byte-identical behaviour —
 * and rescales automatically with K. It stays below a single-generator top-1
 * (1/(K+1)) by construction, so an exact keyword hit always survives.
 */
export const TAU = 1 / (RRF_K + TAU_RANK_DEPTH + 1);

/** Canon tier boost (§5.3): a standing rule relevant to the query should
 *  essentially always clear a slot, so this sits above the strongest kind
 *  prior (1.2). Calibration target once retrieval_log accumulates data (§7). */
export const CANON_BOOST = 1.5;

/** Soft-demote multiplier for feedback (§ Phase C). A fact flagged net-negative
 *  by member feedback is multiplied by FEEDBACK_PENALTY once per net-negative
 *  vote: it ranks lower but is never removed — a nudge, not a silence. Start
 *  conservative; recalibrate once the feedback log has data. */
export const FEEDBACK_PENALTY = 0.8;

/**
 * Entity candidate generator (§5.1, the third generator alongside BM25 and
 * cosine): a doc is a candidate when any token of any of its entity tags
 * appears in the query. Rescues canonical topics that paraphrase-embeddings
 * blur and multi-word tags BM25 splits. Score = overlap count (RRF only uses
 * rank, so exact magnitude is irrelevant).
 */
export function entityRank(
  docs: { id: string; entities: string[] }[],
  query: string,
): Scored[] {
  const qTerms = new Set(tokenize(query));
  if (qTerms.size === 0) return [];
  const out: Scored[] = [];
  for (const d of docs) {
    let overlap = 0;
    for (const e of d.entities ?? []) {
      if (tokenize(e).some((t) => qTerms.has(t))) overlap += 1;
    }
    if (overlap > 0) out.push({ id: d.id, score: overlap });
  }
  return out.sort((a, b) => b.score - a.score);
}

const STATUS_HALF_LIFE_DAYS = 14;

/**
 * Kind priors (§5.3). Decisions/constraints do not decay by clock — only by
 * supersession (§4); status/question rot with a ~14-day half-life.
 */
const KIND_PRIOR: Record<string, number> = {
  decision: 1.2,
  constraint: 1.2,
  preference: 1.0,
  reference: 1.0,
  context: 1.0,
  status: 0.9,
  question: 0.9,
};

export function adjustScores(
  fused: Map<string, number>,
  docsById: Map<string, { kind: string; sourceTs: string; tier: string }>,
  now: Date,
  penalties?: Map<string, number>,
): Scored[] {
  const out: Scored[] = [];
  for (const [id, score] of fused) {
    const doc = docsById.get(id);
    if (!doc) continue;
    let s = score * (KIND_PRIOR[doc.kind] ?? 1.0);
    if (doc.tier === "canon") s *= CANON_BOOST;
    if (doc.kind === "status" || doc.kind === "question") {
      const ageMs = now.getTime() - Date.parse(doc.sourceTs);
      const ageDays = Number.isFinite(ageMs)
        ? Math.max(0, ageMs / 86_400_000)
        : 0;
      s *= Math.pow(0.5, ageDays / STATUS_HALF_LIFE_DAYS);
    }
    const net = penalties?.get(id) ?? 0;
    if (net > 0) s *= Math.pow(FEEDBACK_PENALTY, net);
    out.push({ id, score: s });
  }
  return out.sort((a, b) => b.score - a.score);
}
