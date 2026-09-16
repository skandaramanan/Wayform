/**
 * Index ingest (§2): the ledger is the source of truth; these functions derive
 * index docs from it. Callers: inline gateway writes (mcp.ts), the push webhook
 * and PR recorder (webhook.ts), and reindex/reconcile (reindex.ts).
 *
 * Every ledger file carries an ingest_state row — its git blob sha, the
 * extractor version, and whether extraction succeeded (ok), fell back to one
 * whole-entry fact (floored), or is mid-flight (pending). That row makes ingest
 * idempotent in COST, not just in result: unchanged content is never extracted
 * twice. Before it, every write_context was extracted and judged twice —
 * inline, then again when its own commit's push webhook arrived — and any sha
 * mismatch re-extracted the entire space.
 */
import { parseEntry, type ParsedEntry } from "../../src/frontmatter.js";
import { slug } from "../../src/slug.js";
import { installationToken } from "./github-auth.js";
import { gitBlobSha } from "./github-store.js";
import type { Env } from "./env.js";
import type { IndexDb, IndexedDoc, IngestState } from "./index-db.js";
import type { Embedder } from "./retrieval.js";
import {
  extractFactsDetailed,
  EXTRACTOR_VERSION,
  type GenText,
  type ExtractedFact,
} from "./extract.js";
import { applySupersession } from "./supersede.js";
import { remainingNeurons } from "./neuron-budget.js";

const GH = "https://api.github.com";

/**
 * Neurons an entry may need before ingest declines to start it. One entry can
 * cost up to MAX_CHUNKS_PER_ENTRY extractions plus supersession judging, so
 * reserve generously: stopping one entry early is cheap, half-extracting the
 * back half of a corpus is not.
 */
export const ENTRY_NEURON_RESERVE = 600;

/** A pending claim older than this is presumed dead (the Worker was evicted
 *  mid-extraction) and becomes retryable. */
export const PENDING_STALE_MS = 10 * 60_000;

/** A floored entry is retried at most once per window, so an entry the model
 *  can never parse costs one attempt a day, not one per cron tick. */
export const FLOORED_RETRY_MS = 24 * 60 * 60_000;

/**
 * Adoption threshold for entries indexed before ingest_state existed. A source
 * with several facts, or one short one, was extracted (or is too short for it
 * to matter); a single fact this long is a whole-entry floor worth another
 * try. Atomic facts in the live corpus measured avg ~60, max 175 chars
 * (2026-09-13).
 */
export const FLOOR_BODY_CHARS = 500;

export interface SpaceRepo {
  space: string;
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "memorylayer-gateway",
    "x-github-api-version": "2022-11-28",
  };
}

/** "context/<project>/**.md" -> "<project>", else null. */
export function projectFromPath(path: string): string | null {
  const m = path.match(/^context\/([^/]+)\/.+\.md$/);
  return m ? m[1] : null;
}

/**
 * Stable 32-bit FNV-1a, base36. Not cryptographic and does not need to be: the
 * digest only has to distinguish a handful of facts inside ONE entry's
 * namespace, and it must be synchronous (factToDoc runs inside a .map()).
 */
function factDigest(body: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, "0");
}

export function factToDoc(
  space: string,
  project: string,
  entry: ParsedEntry,
  fact: ExtractedFact,
  _idx: number,
  embedding: number[],
): IndexedDoc {
  const sourceId = entry.id || entry.file;
  return {
    // Keyed by CONTENT, not position. The old `#${idx}` was positional, so
    // re-extraction silently repointed a stored id at different text: on
    // 2026-09-13 `8481264b#0` meant a 3838-char blob in the morning and a
    // 103-char atomic fact by evening, and anything holding that id —
    // supersedes:[…], memory_feedback(fact_id), the planned
    // plan_decision(plan_id, fact_id) — resolved to the WRONG fact with
    // nothing reporting an error. A content digest makes the id change iff the
    // fact changes, so a stale reference DANGLES instead. Dangling is
    // detectable and recoverable; silently wrong is neither.
    //
    // The `sourceId` prefix stays stable across re-extraction (it derives from
    // the ledger file, which does not change), so provenance survives even when
    // a fact is rephrased.
    id: `${sourceId}#${factDigest(fact.body)}`,
    space,
    project: slug(project),
    kind: fact.kind,
    tier: fact.tier,
    body: fact.body,
    sourceFile: entry.file,
    sourceAuthor: entry.author,
    sourceTs: entry.timestamp,
    embedding,
    supersededBy: null,
    createdAt: new Date().toISOString(),
    sourceId,
    entities: fact.entities,
  };
}

/** An entry plus, when known, the git blob sha of its file. */
export type IngestEntry = ParsedEntry & { digest?: string };

export interface IngestOutcome {
  /** Docs written. */
  count: number;
  /** Entries left alone because their content was already indexed. */
  skipped: number;
  /** Entries that fell back to one whole-entry fact. */
  floored: number;
  /** True when ingest stopped early for lack of neuron budget. */
  stopped: boolean;
}

const emptyOutcome = (): IngestOutcome => ({
  count: 0,
  skipped: 0,
  floored: 0,
  stopped: false,
});

export interface IngestOpts {
  authorSupersedes?: string[];
  /** Neurons left today, or null if unknown. See ENTRY_NEURON_RESERVE. */
  budgetLeft?: () => Promise<number | null>;
  /** Re-extract even when the stored digest and version already match. */
  force?: boolean;
  /** Old fact ids the write-path conflict check already judged "relates". */
  skipJudgeOld?: string[];
}

/** True when `st` already covers exactly this content — nothing to spend. */
function isCurrent(
  st: IngestState | undefined,
  digest: string,
  gen: GenText | null,
  now: number,
): boolean {
  if (!st || st.digest !== digest || st.version !== EXTRACTOR_VERSION) {
    return false;
  }
  if (st.status === "ok") return true;
  // Another path (usually the inline write) is extracting it right now.
  if (st.status === "pending") {
    return now - Date.parse(st.updatedAt) < PENDING_STALE_MS;
  }
  // floored: only a model can improve it, and only the retry sweep may try
  // again once the cooldown passes. Tree walks used to re-extract floored
  // entries on every pass, burning the day's budget on the same failures and
  // holding the backfill cursor on their page (2026-09-15..17).
  return gen === null || now - Date.parse(st.updatedAt) < FLOORED_RETRY_MS;
}

async function putState(db: IndexDb, state: IngestState): Promise<void> {
  try {
    await db.putIngestState(state);
  } catch {
    // fail-open: a missing state only costs a re-check next time
  }
}

/** Digest for an entry whose file bytes are not at hand (legacy callers,
 *  tests). It differs from the blob sha, so a tree-driven pass re-checks such
 *  an entry once and records the real one. */
function entryDigest(e: IngestEntry): Promise<string> {
  return gitBlobSha(
    `${e.type}\n${e.payload}\n${JSON.stringify(e.facts ?? [])}`,
  );
}

export async function ingestEntriesDetailed(
  db: IndexDb,
  embed: Embedder | null,
  gen: GenText | null,
  space: string,
  project: string,
  entries: IngestEntry[],
  opts: IngestOpts = {},
): Promise<IngestOutcome> {
  const out = emptyOutcome();
  if (entries.length === 0) return out;
  const digests = await Promise.all(
    entries.map((e) => (e.digest ? Promise.resolve(e.digest) : entryDigest(e))),
  );
  let states = new Map<string, IngestState>();
  try {
    states = await db.getIngestStates(
      space,
      entries.map((e) => e.file),
    );
  } catch {
    // fail-open: no state means everything is (re)ingested, as before
  }
  const now = Date.now();
  // Loaded at most once per call, and only when something needs judging or
  // linking — it used to be a full-project scan with embeddings PER ENTRY.
  let live: IndexedDoc[] | null = null;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const digest = digests[i];
    if (!opts.force && isCurrent(states.get(entry.file), digest, gen, now)) {
      out.skipped += 1;
      continue;
    }
    const writerSplit = (entry.facts?.length ?? 0) > 0;
    // Stop DELIBERATELY when the day's allocation cannot cover this entry,
    // instead of letting every remaining one silently floor. The caller keeps
    // its cursor (and does not advance the indexed sha), so the next tick
    // resumes here with a fresh budget.
    if (gen && !writerSplit && opts.budgetLeft) {
      const left = await opts.budgetLeft();
      if (left !== null && left < ENTRY_NEURON_RESERVE) {
        console.log(
          JSON.stringify({
            evt: "ingest_budget_stop",
            space,
            project: slug(project),
            remaining: left,
            stoppedAt: entry.file,
            note: "resumes after the budget resets; entries from here on are NOT indexed yet",
          }),
        );
        out.stopped = true;
        break;
      }
    }
    const state = (status: IngestState["status"]): IngestState => ({
      space,
      sourceFile: entry.file,
      digest,
      version: EXTRACTOR_VERSION,
      status,
      updatedAt: new Date().toISOString(),
    });
    // Claim it, so a push webhook for the same commit skips instead of paying
    // for the same extraction concurrently.
    await putState(db, state("pending"));

    const { facts, floored } = await extractFactsDetailed(gen, entry);
    const sourceId = entry.id || entry.file;
    let prev: IndexedDoc[] = [];
    try {
      prev = await db.docsBySource(space, sourceId);
    } catch {
      // fail-open: without the previous docs every fact is embedded afresh
    }
    const prevById = new Map(prev.map((d) => [d.id, d]));
    const docs = facts.map((f, j) =>
      factToDoc(space, project, entry, f, j, []),
    );
    // Every previous fact superseded by the same fact means the entry as a
    // whole was replaced: its re-extracted facts stay replaced even though
    // their content-derived ids are new.
    const wholeEntryBy =
      prev.length > 0 &&
      prev.every(
        (d) => d.supersededBy && d.supersededBy === prev[0].supersededBy,
      )
        ? prev[0].supersededBy
        : null;
    for (const d of docs) {
      const before = prevById.get(d.id);
      if (!before) {
        d.supersededBy = wholeEntryBy;
        continue;
      }
      // Same content-derived id = same text: keep its vector, and keep it
      // superseded if it was — re-ingest used to resurrect superseded facts.
      d.embedding = before.embedding;
      d.supersededBy = before.supersededBy;
    }
    const unembedded = docs.filter((d) => d.embedding.length === 0);
    if (embed && unembedded.length > 0) {
      try {
        const vecs = await embed(unembedded.map((d) => d.body));
        unembedded.forEach((d, k) => {
          d.embedding = vecs[k] ?? [];
        });
      } catch {
        // fail-open: index facts without vectors — BM25 still serves recall
      }
    }
    // Facts THIS entry superseded point at ids re-extraction is about to
    // delete; clearing those pointers resurrected them (2026-09-14). Hand
    // them to the entry's first new fact instead.
    await db.replaceBySource(space, sourceId, docs, {
      repointTo: docs[0]?.id,
    });
    if (live) {
      live = live
        .filter((d) => d.sourceId !== sourceId)
        .concat(docs.filter((d) => !d.supersededBy));
    }

    // Only facts that did not exist before are judged: re-extracting the same
    // text must not re-buy verdicts already logged for it.
    const fresh = docs.filter((d) => !prevById.has(d.id));
    const linking = (opts.authorSupersedes?.length ?? 0) > 0;
    if ((gen && fresh.length > 0) || linking) {
      try {
        live ??= await db.listDocs(space, slug(project));
        await applySupersession(db, gen, space, slug(project), docs, {
          authorSupersedes: opts.authorSupersedes,
          judgeIds: new Set(fresh.map((d) => d.id)),
          skipOldIds: new Set(opts.skipJudgeOld ?? []),
          live,
        });
      } catch {
        // fail-open: an unjudged fact is still indexed and searchable
      }
    }
    await putState(db, state(floored ? "floored" : "ok"));
    out.count += docs.length;
    if (floored) out.floored += 1;
  }
  return out;
}

export async function ingestEntries(
  db: IndexDb,
  embed: Embedder | null,
  gen: GenText | null,
  space: string,
  project: string,
  entries: IngestEntry[],
  opts: IngestOpts = {},
): Promise<number> {
  return (
    await ingestEntriesDetailed(db, embed, gen, space, project, entries, opts)
  ).count;
}

export interface IngestFilesOpts {
  /** Advance last_indexed_sha on success (default true). Never advanced when
   *  ingest stopped for budget — the unindexed tail must stay visible as drift. */
  setSha?: boolean;
  /** path → git blob sha from a Trees listing: unchanged files are skipped
   *  without fetching their content. */
  digests?: Map<string, string>;
  /** Ledger files deleted upstream: their docs leave the index. */
  removed?: string[];
  force?: boolean;
}

/**
 * Fetch + parse the given ledger paths and ingest them, then advance the
 * space's indexed sha. Non-entry files are skipped; files that no longer exist
 * are removed from the index.
 */
export async function ingestFiles(
  env: Env,
  db: IndexDb,
  embed: Embedder | null,
  gen: GenText | null,
  sr: SpaceRepo,
  paths: string[],
  headSha: string,
  fetchImpl: typeof fetch,
  opts: IngestFilesOpts = {},
): Promise<IngestOutcome> {
  const out = emptyOutcome();
  const wanted = new Set(paths.filter((p) => projectFromPath(p) !== null));
  const removed = (opts.removed ?? []).filter(
    (p) => projectFromPath(p) !== null && !wanted.has(p),
  );
  if (removed.length > 0) await db.deleteBySourceFiles(sr.space, removed);

  let relevant = [...wanted];
  if (opts.digests && !opts.force && relevant.length > 0) {
    let states = new Map<string, IngestState>();
    let stats = new Map<string, { docs: number; maxBody: number }>();
    try {
      states = await db.getIngestStates(sr.space, relevant);
      const unrecorded = relevant.filter((p) => !states.has(p));
      if (unrecorded.length > 0) {
        stats = await db.docStatsByFile(sr.space, unrecorded);
      }
    } catch {
      // fail-open: fetch everything
    }
    const now = Date.now();
    const keep: string[] = [];
    for (const path of relevant) {
      const digest = opts.digests.get(path);
      const st = states.get(path);
      if (digest && isCurrent(st, digest, gen, now)) {
        out.skipped += 1;
        continue;
      }
      // Adopt docs indexed before ingest_state existed when they look
      // properly extracted: record them as current, with no fetch and no model.
      const s = stats.get(path);
      if (digest && !st && s && (s.docs > 1 || s.maxBody < FLOOR_BODY_CHARS)) {
        await putState(db, {
          space: sr.space,
          sourceFile: path,
          digest,
          version: EXTRACTOR_VERSION,
          status: "ok",
          updatedAt: new Date().toISOString(),
        });
        out.skipped += 1;
        continue;
      }
      keep.push(path);
    }
    relevant = keep;
  }

  if (relevant.length > 0) {
    const token = await installationToken(env, sr.installationId, fetchImpl);
    const gone: string[] = [];
    // In parallel: Workers runs 6 connections and queues the rest, so this is
    // a fraction of the sequential wall time.
    const fetched = await Promise.all(
      relevant.map(async (path): Promise<IngestEntry | null> => {
        const res = await fetchImpl(
          `${GH}/repos/${sr.owner}/${sr.repo}/contents/${path}?ref=${sr.branch}`,
          {
            headers: {
              ...ghHeaders(token),
              accept: "application/vnd.github.raw+json",
            },
          },
        );
        if (res.status === 404) gone.push(path);
        if (!res.ok) return null;
        const raw = await res.text();
        const parsed = parseEntry(raw, path);
        return parsed ? { ...parsed, digest: await gitBlobSha(raw) } : null;
      }),
    );
    if (gone.length > 0) await db.deleteBySourceFiles(sr.space, gone);

    const byProject = new Map<string, IngestEntry[]>();
    for (const entry of fetched) {
      if (!entry) continue;
      const project = projectFromPath(entry.file)!;
      const list = byProject.get(project) ?? [];
      list.push(entry);
      byProject.set(project, list);
    }
    for (const [project, entries] of byProject) {
      const r = await ingestEntriesDetailed(
        db,
        embed,
        gen,
        sr.space,
        project,
        entries,
        {
          budgetLeft: () => remainingNeurons(env),
          force: opts.force,
        },
      );
      out.count += r.count;
      out.skipped += r.skipped;
      out.floored += r.floored;
      if (r.stopped) {
        out.stopped = true;
        break;
      }
    }
  }
  if ((opts.setSha ?? true) && !out.stopped) {
    await db.setLastIndexedSha(sr.space, headSha);
  }
  return out;
}

export interface ReindexResult {
  count: number;
  total: number;
  /** Offset for the next call, or null when this call reached the end. A
   *  budget stop returns the same offset: done entries skip on the retry. */
  nextOffset: number | null;
  skipped: number;
  stopped: boolean;
}

/**
 * Reconcile a space's index with the whole ledger, one page at a time.
 *
 * Nothing is wiped unless `wipe` is set. Unchanged files are skipped using the
 * blob shas the tree listing already returns (no content fetch, no model);
 * entries indexed before ingest_state existed are adopted when they look
 * extracted; files gone from the tree are pruned on the first page. `force`
 * re-extracts everything in scope, for when the output is wrong rather than
 * stale — a new extractor should bump EXTRACTOR_VERSION instead.
 *
 * `last_indexed_sha` only advances once the last page completes without a
 * budget stop.
 */
export async function reindexSpace(
  env: Env,
  db: IndexDb,
  embed: Embedder | null,
  gen: GenText | null,
  sr: SpaceRepo,
  fetchImpl: typeof fetch,
  opts: {
    project?: string;
    offset?: number;
    limit?: number;
    wipe?: boolean;
    force?: boolean;
  } = {},
): Promise<ReindexResult> {
  const token = await installationToken(env, sr.installationId, fetchImpl);
  const headRes = await fetchImpl(
    `${GH}/repos/${sr.owner}/${sr.repo}/commits/${sr.branch}`,
    { headers: ghHeaders(token) },
  );
  if (!headRes.ok) throw new Error(`head read failed: ${headRes.status}`);
  const { sha } = (await headRes.json()) as { sha: string };

  const treeRes = await fetchImpl(
    `${GH}/repos/${sr.owner}/${sr.repo}/git/trees/${sr.branch}?recursive=1`,
    { headers: ghHeaders(token) },
  );
  if (!treeRes.ok) throw new Error(`tree read failed: ${treeRes.status}`);
  const tree = (await treeRes.json()) as {
    tree: { path: string; type: string; sha?: string }[];
  };
  const blobs = tree.tree.filter(
    (t) => t.type === "blob" && projectFromPath(t.path) !== null,
  );
  const wanted = opts.project ? slug(opts.project) : null;
  const inScope = (p: string) => !wanted || projectFromPath(p) === wanted;
  const paths = blobs
    .map((t) => t.path)
    .filter(inScope)
    .sort();
  const digests = new Map<string, string>();
  for (const t of blobs) if (t.sha) digests.set(t.path, t.sha);

  const total = paths.length;
  const offset = opts.offset ?? 0;
  const slice =
    opts.limit != null
      ? paths.slice(offset, offset + opts.limit)
      : paths.slice(offset);
  const nextOffset =
    offset + slice.length < total ? offset + slice.length : null;

  if (offset === 0) {
    if (opts.wipe) {
      await db.deleteSpace(sr.space);
    } else {
      // The one thing the old offset-0 wipe did that was worth keeping:
      // index rows for ledger files that no longer exist go away.
      const inTree = new Set(blobs.map((t) => t.path));
      const gone = (await db.listSourceFiles(sr.space)).filter(
        (f) => !inTree.has(f) && (!wanted || projectFromPath(f) === wanted),
      );
      if (gone.length > 0) await db.deleteBySourceFiles(sr.space, gone);
    }
  }
  const r = await ingestFiles(env, db, embed, gen, sr, slice, sha, fetchImpl, {
    setSha: nextOffset === null,
    digests,
    force: opts.force,
  });
  return {
    count: r.count,
    total,
    nextOffset: r.stopped ? offset : nextOffset,
    skipped: r.skipped,
    stopped: r.stopped,
  };
}
