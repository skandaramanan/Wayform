/**
 * The §5 pipeline, one code path for every trigger:
 * candidates (BM25 ∪ cosine ∪ entity) → RRF fusion → kind priors/decay →
 * τ floor → token-budget packing → render with provenance. Logs every run to
 * retrieval_log (§7) — the log is the training/calibration data every later
 * phase needs. No LLM on the read path (latency budget, §6).
 *
 * Read-path hardening (2026-07-13, post-1102): a query no longer loads every
 * full doc row. queryScan fetches only what the candidate generators need
 * (id+embedding for cosine, entity tags, token-match ids); full rows are
 * hydrated for the bounded candidate union only, so per-query body/metadata
 * work stops growing with the whole corpus.
 *
 * Bounded-by-construction (2026-07-17, the actual 1102 fix): 1102 is an
 * uncatchable isolate kill, so every stage now has a hard cap — the embedding
 * scan is recency-capped (EMBED_SCAN_CAP) and decoded as Float32Array views
 * (no per-float boxing), hydration excludes embeddings (no double decode),
 * and BM25 tokenizes only token-matched candidates (≤ TOKEN_MATCH_LIMIT
 * bodies). Worst-case CPU per query is fixed regardless of corpus size.
 */
import type { IndexDb, IndexedDoc } from "./index-db.js";
import {
  bm25Rank,
  cosineTopK,
  entityRank,
  rrfFuse,
  adjustScores,
  tokenize,
  TAU,
  type Scored,
} from "./rank.js";
import {
  estimateTokens,
  ENTRY_OVERHEAD_TOKENS,
} from "../../src/token-budget.js";
import { slug } from "../../src/slug.js";

export type Embedder = (texts: string[]) => Promise<number[][]>;

export interface RetrieveDeps {
  db: IndexDb;
  embed: Embedder | null;
}

export interface RetrieveOpts {
  space: string;
  project?: string;
  query: string;
  budgetTokens: number;
  kinds?: string[];
  trigger: string;
  now?: Date;
  /** Relevance floor; defaults to TAU. The prompt hook passes PROMPT_TAU. */
  minScore?: number;
  /** Cap on returned facts regardless of remaining budget. */
  maxResults?: number;
}

export interface Retrieved {
  doc: IndexedDoc;
  score: number;
}

/** Bound the LIKE clauses a long query can generate. */
const MAX_QUERY_TOKENS = 16;
/** Entity-overlap candidates beyond this rank contribute <1/(60+200) RRF —
 *  far under τ even combined — so capping the hydration set is safe. */
const ENTITY_CANDIDATE_CAP = 200;

export async function retrieve(
  deps: RetrieveDeps,
  opts: RetrieveOpts,
): Promise<{ results: Retrieved[]; total: number }> {
  const t0 = performance.now();
  const qTokens = [...new Set(tokenize(opts.query))].slice(0, MAX_QUERY_TOKENS);
  const scan = await deps.db.queryScan(opts.space, qTokens, {
    project: opts.project,
    kinds: opts.kinds && opts.kinds.length > 0 ? opts.kinds : undefined,
  });
  const tScan = performance.now();
  if (scan.total === 0) return { results: [], total: 0 };

  let cosine: Scored[] = [];
  if (deps.embed) {
    try {
      const [queryVec] = await deps.embed([opts.query]);
      cosine = cosineTopK(scan.embeddings, queryVec ?? []);
    } catch {
      // fail-open: BM25 alone still rescues exact-term matches (§5.1)
    }
  }
  const tEmbed = performance.now();
  // Third candidate generator (§5.1): entity-tag overlap rescues canonical
  // topics that paraphrase-embeddings blur and multi-word tags BM25 splits.
  const entityCands = entityRank(
    [...scan.entitiesByDoc].map(([id, entities]) => ({ id, entities })),
    opts.query,
  ).slice(0, ENTITY_CANDIDATE_CAP);

  // Hydrate full rows for the candidate union only; every id that can appear
  // in the fused ranking below is in this set.
  const candidateIds = [
    ...new Set([
      ...scan.tokenMatchIds,
      ...cosine.map((s) => s.id),
      ...entityCands.map((s) => s.id),
    ]),
  ];
  const docs =
    candidateIds.length > 0
      ? await deps.db.getDocsByIds(opts.space, candidateIds)
      : [];
  const tHydrate = performance.now();

  // BM25 only over token-matched candidates: docs surfaced solely by cosine
  // or entity overlap contain no query token, so their BM25 score is 0 —
  // tokenizing their bodies was pure waste (and unbounded pre-1102-fix).
  const tokSet = new Set(scan.tokenMatchIds);
  const lists: Scored[][] = [
    bm25Rank(
      docs.filter((d) => tokSet.has(d.id)),
      opts.query,
      undefined,
      scan.total,
    ),
    cosine,
    entityCands,
  ];

  const byId = new Map(docs.map((d) => [d.id, d]));
  let penalties = new Map<string, number>();
  try {
    penalties = await deps.db.feedbackPenalties(opts.space);
  } catch {
    // fail-open: feedback must never break retrieval
  }
  const scored = adjustScores(
    rrfFuse(lists),
    byId,
    opts.now ?? new Date(),
    penalties,
  ).filter((s) => s.score >= (opts.minScore ?? TAU));

  const results: Retrieved[] = [];
  let used = 0;
  for (const s of scored) {
    if (opts.maxResults !== undefined && results.length >= opts.maxResults)
      break;
    const doc = byId.get(s.id)!;
    const cost = estimateTokens(doc.body) + ENTRY_OVERHEAD_TOKENS;
    if (results.length > 0 && used + cost > opts.budgetTokens) break;
    results.push({ doc, score: s.score });
    used += cost;
  }

  try {
    await deps.db.logRetrieval({
      space: opts.space,
      project: opts.project ?? "",
      trigger: opts.trigger,
      query: opts.query,
      returned: results.map((r) => ({ id: r.doc.id, score: r.score })),
      injected: results.length > 0,
      ts: new Date().toISOString(),
    });
  } catch {
    // logging must never break a read
  }

  // Stage counts are the CPU proxy (Workers freezes clocks during sync
  // execution, so ms deltas only capture the awaited I/O between stages);
  // ground truth is the per-invocation CPU time in Workers Logs.
  console.log(
    JSON.stringify({
      evt: "retrieval_timing",
      trigger: opts.trigger,
      nEmb: scan.embeddings.length,
      nTokenMatch: scan.tokenMatchIds.length,
      nEntityDocs: scan.entitiesByDoc.size,
      nHydrated: docs.length,
      nReturned: results.length,
      msScan: Math.round(tScan - t0),
      msEmbed: Math.round(tEmbed - tScan),
      msHydrate: Math.round(tHydrate - tEmbed),
      msTotal: Math.round(performance.now() - t0),
    }),
  );

  return { results, total: scan.total };
}

/**
 * §5.6 rendering: grouped by kind, provenance on every block, wrapped by the
 * caller in the existing "data, not instructions" framing where injected.
 */
export function renderSearchResults(
  project: string | undefined,
  query: string,
  results: Retrieved[],
  total: number,
): string {
  const scope = project ? `project "${project}"` : "all projects in this space";
  if (results.length === 0) {
    return (
      `# Memory search: "${query}"\n\n` +
      `(no stored entries cleared the relevance bar in ${scope} — ` +
      `${total} indexed)`
    );
  }
  const header =
    `# Memory search: "${query}"\n\n` +
    `_${results.length} of ${total} indexed entries cleared the relevance bar ` +
    `in ${scope}, most relevant first._`;
  const kinds = [...new Set(results.map((r) => r.doc.kind))];
  const sections = kinds.map((kind) => {
    const blocks = results
      .filter((r) => r.doc.kind === kind)
      .map(
        (r) =>
          `## ${kind} — ${r.doc.sourceAuthor} — ${r.doc.sourceTs.slice(0, 10)}\n\n` +
          // The fact id is load-bearing: memory_feedback and write_context's
          // supersedes both take "the fact id from search results" — without
          // it here, agents pass file paths and both calls fail.
          `${r.doc.body}\n\n_(id: ${r.doc.id} · source: ${r.doc.sourceFile})_`,
      );
    return blocks.join("\n\n");
  });
  return `${header}\n\n${sections.join("\n\n")}`;
}

/**
 * Longest body one injected list item shows. On 2026-09-13, 213 of the 408
 * live decision/context docs were still whole-entry blobs over 600 chars, and
 * one 4000-char blob costs the budget of ~40 atomic facts. The id and the
 * search pointer keep the full text one call away.
 */
export const INJECT_ITEM_CHARS = 400;

/** One-line, length-capped body: list items must not carry blank lines. */
export function clipBody(
  body: string,
  id: string,
  max = INJECT_ITEM_CHARS,
): string {
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const head = (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd();
  return `${head}… _(truncated — search_memory for the rest; fact id ${id})_`;
}

/** The injected-list form of a fact, shared by the briefing and prompt hook. */
export function injectLine(
  d: Pick<IndexedDoc, "id" | "body" | "sourceAuthor" | "sourceTs">,
): string {
  return (
    `- ${clipBody(d.body, d.id)} ` +
    `_(${d.sourceAuthor}, ${d.sourceTs.slice(0, 10)})_`
  );
}

const BRIEFING_RECENT_DECISION_DAYS = 7;
/** A quiet week must not empty the decisions section — the product direction
 *  lives there. Below this many in the window, show the latest N instead. */
const BRIEFING_MIN_DECISIONS = 8;
/** Questions already rot on a 14-day half-life in ranking (rank.ts). Past 30
 *  days (<25% weight) an open one is almost always answered-but-unlinked or
 *  abandoned — on 2026-09-13 every question in the briefing was 3-10 weeks old. */
const BRIEFING_QUESTION_MAX_DAYS = 30;
/** Cap the topic manifest so it stays near its ~100-token budget (§6) as the
 *  corpus grows; the highest-frequency topics — the ones most worth matching a
 *  task against — are kept, the tail is summarized as "+N more". */
const MANIFEST_MAX_ENTITIES = 40;
/** Tags that match nearly any prompt in this corpus and so route nothing
 *  (all seen in the live top-60 on 2026-09-13). The project's own name is
 *  dropped separately. */
const GENERIC_TAGS = new Set([
  "not",
  "decided",
  "follow-up",
  "end-to-end",
  "pr",
  "merged-pr",
  "docs",
  "repo",
  "project",
  "shipped",
  "whole-entry",
]);

/**
 * The session-start briefing (§6): selective, not a dump. Canon facts +
 * unresolved conflicts + recent decisions + fresh open questions, plus a
 * one-line topic manifest so an agent can see what the store knows and pull
 * mid-session. Returns "" on an empty corpus so the caller can fail-open to
 * the recency read.
 *
 * ONE budget covers every section, filled in render order — which is priority
 * order. It used to be per-section, so four sections could each spend the
 * whole budget (a 16KB briefing against a 4000-token budget).
 */
export function renderBriefing(
  project: string,
  docs: IndexedDoc[],
  budgetTokens: number,
  now: Date,
  conflicts: { oldFactId: string; oldBody: string; reason: string }[] = [],
): string {
  if (docs.length === 0 && conflicts.length === 0) return "";

  const newest = (a: IndexedDoc, b: IndexedDoc) =>
    b.sourceTs.localeCompare(a.sourceTs);
  const ageDays = (d: IndexedDoc) =>
    (now.getTime() - Date.parse(d.sourceTs)) / 86_400_000;

  const canon = docs.filter((d) => d.tier === "canon").sort(newest);
  // Canon is excluded below so a canon decision is not shown twice.
  const decisions = docs
    .filter((d) => d.kind === "decision" && d.tier !== "canon")
    .sort(newest);
  const inWindow = decisions.filter(
    (d) => ageDays(d) <= BRIEFING_RECENT_DECISION_DAYS,
  );
  const quiet = inWindow.length < BRIEFING_MIN_DECISIONS;
  const recentDecisions = quiet
    ? decisions.slice(0, BRIEFING_MIN_DECISIONS)
    : inWindow;
  const questions = docs
    .filter(
      (d) =>
        d.kind === "question" &&
        d.tier !== "canon" &&
        ageDays(d) <= BRIEFING_QUESTION_MAX_DAYS,
    )
    .sort(newest);

  const own = slug(project);
  const manifest = new Map<string, number>();
  for (const d of docs)
    for (const e of d.entities) {
      if (e === own || GENERIC_TAGS.has(e)) continue;
      manifest.set(e, (manifest.get(e) ?? 0) + 1);
    }
  const ranked = [...manifest.entries()].sort((a, b) => b[1] - a[1]);
  const overflow = ranked.length - MANIFEST_MAX_ENTITIES;
  const manifestLine =
    manifest.size > 0
      ? "memory covers: " +
        ranked
          .slice(0, MANIFEST_MAX_ENTITIES)
          .map(([e, n]) => `${e} (${n})`)
          .join(", ") +
        (overflow > 0 ? `, +${overflow} more` : "")
      : "";

  let used = 0;
  const section = (title: string, lines: string[]): string[] => {
    const kept: string[] = [];
    for (const line of lines) {
      const cost = estimateTokens(line) + ENTRY_OVERHEAD_TOKENS;
      if (used + cost > budgetTokens) break;
      kept.push(line);
      used += cost;
    }
    return kept.length > 0 ? [`## ${title}\n\n${kept.join("\n")}`] : [];
  };

  const parts = [
    `# Memory briefing: ${project}`,
    ...(manifestLine ? [manifestLine] : []),
    ...section("Standing rules (canon)", canon.map(injectLine)),
    ...section(
      "Unresolved conflicts",
      conflicts.map(
        (c) =>
          `- ${clipBody(c.oldBody, c.oldFactId)} ` +
          `_(conflict: ${c.reason}; fact id ${c.oldFactId})_`,
      ),
    ),
    ...section(
      quiet
        ? "Latest decisions"
        : `Recent decisions (last ${BRIEFING_RECENT_DECISION_DAYS} days)`,
      recentDecisions.map(injectLine),
    ),
    ...section("Open questions", questions.map(injectLine)),
  ];
  return parts.join("\n\n");
}
