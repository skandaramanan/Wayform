/**
 * Index ingest (§2): the ledger is the source of truth; these functions
 * derive index docs from it. Three callers: inline gateway writes (mcp.ts),
 * the push webhook (webhook.ts), and reindex/reconcile (reindex.ts).
 * Phase B1: ingestEntries extracts N atomic facts per ledger entry (LLM, §3)
 * and writes them with delete-then-insert idempotency (replaceBySource). The
 * three callers pass a `gen` text-gen seam; when it is null (or extraction
 * fails) each entry degrades to a single whole-entry fact — Phase A behavior.
 */
import { parseEntry, type ParsedEntry } from "../../src/frontmatter.js";
import { slug } from "../../src/slug.js";
import { installationToken } from "./github-auth.js";
import type { Env } from "./env.js";
import type { IndexDb, IndexedDoc } from "./index-db.js";
import type { Embedder } from "./retrieval.js";
import { extractFacts, type GenText, type ExtractedFact } from "./extract.js";
import { applySupersession } from "./supersede.js";

const GH = "https://api.github.com";

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

export async function ingestEntries(
  db: IndexDb,
  embed: Embedder | null,
  gen: GenText | null,
  space: string,
  project: string,
  entries: ParsedEntry[],
  opts: { authorSupersedes?: string[] } = {},
): Promise<number> {
  if (entries.length === 0) return 0;
  let count = 0;
  for (const entry of entries) {
    const facts = await extractFacts(gen, entry);
    let vecs: number[][] = facts.map(() => []);
    if (embed) {
      try {
        vecs = await embed(facts.map((f) => f.body));
      } catch {
        // fail-open: index facts without vectors — BM25 still serves recall
      }
    }
    const docs = facts.map((f, i) =>
      factToDoc(space, project, entry, f, i, vecs[i] ?? []),
    );
    await db.replaceBySource(space, entry.id || entry.file, docs);
    await applySupersession(db, gen, space, slug(project), docs, {
      authorSupersedes: opts.authorSupersedes,
    });
    count += docs.length;
  }
  return count;
}

/**
 * Fetch + parse the given ledger paths and ingest them, then advance the
 * space's indexed sha. Non-entry/missing files are skipped, matching the
 * per-entry tolerance of readEntries.
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
  opts: { setSha?: boolean } = {},
): Promise<number> {
  const relevant = paths.filter((p) => projectFromPath(p) !== null);
  let count = 0;
  if (relevant.length > 0) {
    const token = await installationToken(env, sr.installationId, fetchImpl);
    const byProject = new Map<string, ParsedEntry[]>();
    for (const path of relevant) {
      const res = await fetchImpl(
        `${GH}/repos/${sr.owner}/${sr.repo}/contents/${path}?ref=${sr.branch}`,
        {
          headers: {
            ...ghHeaders(token),
            accept: "application/vnd.github.raw+json",
          },
        },
      );
      if (!res.ok) continue;
      const parsed = parseEntry(await res.text(), path);
      if (!parsed) continue;
      const project = projectFromPath(path)!;
      const list = byProject.get(project) ?? [];
      list.push(parsed);
      byProject.set(project, list);
    }
    for (const [project, entries] of byProject) {
      count += await ingestEntries(db, embed, gen, sr.space, project, entries);
    }
  }
  if (opts.setSha ?? true) {
    await db.setLastIndexedSha(sr.space, headSha);
  }
  return count;
}

export interface ReindexResult {
  count: number;
  total: number;
  /** Offset for the next call, or null when this call reached the end. */
  nextOffset: number | null;
}

/**
 * Rebuild a space's index from the ledger from scratch — the disposability
 * guarantee (§2.3), and the one-time backfill of pre-existing entries.
 *
 * Paginated via `opts.offset`/`opts.limit`: each content file is one outbound
 * GitHub API request, and Workers' free plan caps a single invocation at 50
 * subrequests (1 token exchange + 1 HEAD commit + 1 tree + N content fetches).
 * A space with more than ~45 total ledger entries — or several projects
 * combined in one repo — can exceed that budget in an unpaginated call. The
 * default (no `limit`) preserves the original single-call full-rebuild
 * behavior for existing callers (webhook ingest, cron reconcile) where the
 * changed-file count is normally small; a caller backfilling a large/old
 * space should pass `limit` and repeat with the returned `nextOffset` until
 * it comes back null. Only the first page (`offset` 0/undefined) wipes the
 * space; `last_indexed_sha` only advances once the last page completes, so a
 * reindex interrupted mid-pagination is retried from scratch rather than
 * silently marked complete.
 */
export async function reindexSpace(
  env: Env,
  db: IndexDb,
  embed: Embedder | null,
  gen: GenText | null,
  sr: SpaceRepo,
  fetchImpl: typeof fetch,
  opts: { project?: string; offset?: number; limit?: number } = {},
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
    tree: { path: string; type: string }[];
  };
  let paths = tree.tree
    .filter((t) => t.type === "blob" && projectFromPath(t.path) !== null)
    .map((t) => t.path)
    .sort();
  if (opts.project) {
    const wanted = slug(opts.project);
    paths = paths.filter((p) => projectFromPath(p) === wanted);
  }

  const total = paths.length;
  const offset = opts.offset ?? 0;
  const slice =
    opts.limit != null
      ? paths.slice(offset, offset + opts.limit)
      : paths.slice(offset);
  const nextOffset =
    offset + slice.length < total ? offset + slice.length : null;

  if (offset === 0) {
    await db.deleteSpace(sr.space);
  }
  const count = await ingestFiles(
    env,
    db,
    embed,
    gen,
    sr,
    slice,
    sha,
    fetchImpl,
    {
      setSha: nextOffset === null,
    },
  );
  return { count, total, nextOffset };
}
