/**
 * The §5 pipeline, one code path for every trigger:
 * candidates (BM25 ∪ cosine) → RRF fusion → kind priors/decay → τ floor →
 * token-budget packing → render with provenance. Logs every run to
 * retrieval_log (§7) — the log is the training/calibration data every later
 * phase needs. No LLM on the read path (latency budget, §6).
 */
import type { IndexDb, IndexedDoc } from "./index-db.js";
import {
  bm25Rank,
  cosineTopK,
  rrfFuse,
  adjustScores,
  TAU,
  type Scored,
} from "./rank.js";
import {
  estimateTokens,
  ENTRY_OVERHEAD_TOKENS,
} from "../../src/token-budget.js";

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
}

export interface Retrieved {
  doc: IndexedDoc;
  score: number;
}

export async function retrieve(
  deps: RetrieveDeps,
  opts: RetrieveOpts,
): Promise<{ results: Retrieved[]; total: number }> {
  let docs = await deps.db.listDocs(opts.space, opts.project);
  if (opts.kinds && opts.kinds.length > 0) {
    docs = docs.filter((d) => opts.kinds!.includes(d.kind));
  }
  if (docs.length === 0) return { results: [], total: 0 };

  const lists: Scored[][] = [bm25Rank(docs, opts.query)];
  if (deps.embed) {
    try {
      const [queryVec] = await deps.embed([opts.query]);
      lists.push(cosineTopK(docs, queryVec ?? []));
    } catch {
      // fail-open: BM25 alone still rescues exact-term matches (§5.1)
    }
  }

  const byId = new Map(docs.map((d) => [d.id, d]));
  const scored = adjustScores(rrfFuse(lists), byId, opts.now ?? new Date())
    .filter((s) => s.score >= TAU);

  const results: Retrieved[] = [];
  let used = 0;
  for (const s of scored) {
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

  return { results, total: docs.length };
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
          `${r.doc.body}\n\n_(source: ${r.doc.sourceFile})_`,
      );
    return blocks.join("\n\n");
  });
  return `${header}\n\n${sections.join("\n\n")}`;
}
