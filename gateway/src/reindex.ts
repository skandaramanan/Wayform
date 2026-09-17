/**
 * Reindex + reconciliation. Nothing here wipes a space unless an operator asks
 * for it (`wipe: true`): the index knows each ledger file's blob sha and
 * extractor version (ingest_state), so every path re-extracts ONLY what
 * changed, failed, or predates the current extractor.
 *
 * reconcileAll runs on the 15-minute cron. Per space:
 *  1. a rebuild cursor in flight → continue it. Rebuilds no longer wipe, so a
 *     cursor stays safe to resume after a webhook moves the head;
 *  2. never indexed, or indexed before ingest_state existed → one paged pass
 *     that adopts properly extracted entries without a fetch or model call;
 *  3. HEAD moved → GitHub compare API: ingest changed files, drop removed ones.
 *     A paged pass only when compare cannot answer (force-push, too many files);
 *  4. retry sweep → re-extract a few floored, stale-pending or old-version
 *     entries.
 * A tick whose neuron budget cannot cover one entry does no model work; it
 * resumes after the UTC reset instead of flooring.
 *
 * History: the cron used to wipe the space and re-extract EVERYTHING on any
 * sha mismatch — ~44k neurons for a 440-entry space, 4.6 days of budget
 * (2026-08-31) — and a multi-day rebuild was abandoned half-wiped the moment a
 * webhook caught the sha up.
 */
import type { Env, HandlerCtx } from "./env.js";
import { listSpaceRepos, requireOperator } from "./tenancy.js";
import { indexDeps } from "./deps.js";
import {
  reindexSpace,
  ingestFiles,
  ENTRY_NEURON_RESERVE,
  PENDING_STALE_MS,
  FLOORED_RETRY_MS,
  type SpaceRepo,
} from "./ingest.js";
import { EXTRACTOR_VERSION } from "./extract.js";
import { installationToken } from "./github-auth.js";
import { remainingNeurons } from "./neuron-budget.js";

const GH = "https://api.github.com";

function ghHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "memorylayer-gateway",
    "x-github-api-version": "2022-11-28",
  };
}

export async function handleAdminReindex(
  req: Request,
  env: Env,
  ctx?: HandlerCtx,
): Promise<Response> {
  const denied = requireOperator(req, env, ctx);
  if (denied) return denied;
  const deps = indexDeps(env);
  if (!deps) return Response.json({ error: "index disabled" }, { status: 503 });

  let body: {
    repo?: string;
    project?: string;
    offset?: number;
    limit?: number;
    clearSupersession?: boolean;
    /** Delete the space's index before rebuilding. Almost never needed. */
    wipe?: boolean;
    /** Re-extract entries even when their content is unchanged. */
    force?: boolean;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    body = {};
  }
  const repos = (await listSpaceRepos(env)).filter(
    (sr) => !body.repo || `${sr.owner}/${sr.repo}` === body.repo,
  );
  const reindexed: Record<string, number> = {};
  const skipped: Record<string, number> = {};
  let stopped = false;
  // Pagination info is only surfaced when the caller opts in via `limit`, so
  // the response shape for an ordinary (unpaginated) call is unchanged.
  let pagination:
    Record<string, { total: number; nextOffset: number | null }> | undefined;
  for (const sr of repos) {
    if (body.clearSupersession) {
      await deps.db.clearAllSupersession(sr.space);
    }
    const result = await reindexSpace(
      env,
      deps.db,
      deps.embed,
      deps.gen,
      sr,
      env.githubFetch ?? fetch,
      {
        project: body.project,
        offset: body.offset,
        limit: body.limit,
        wipe: body.wipe === true,
        force: body.force === true,
      },
    );
    reindexed[sr.space] = result.count;
    skipped[sr.space] = result.skipped;
    stopped ||= result.stopped;
    if (body.limit != null) {
      pagination = pagination ?? {};
      pagination[sr.space] = {
        total: result.total,
        nextOffset: result.nextOffset,
      };
    }
  }
  // Report the day's remaining allocation alongside the count. A reindex that
  // outruns the budget stops and says so, rather than returning a plausible
  // count over a degraded index as it did on 2026-09-13.
  const neuronsLeft = await remainingNeurons(env);
  const budget =
    neuronsLeft === null
      ? undefined
      : {
          neuronsLeft,
          note: stopped
            ? "day's allocation spent — remaining entries were NOT extracted; the cron finishes them after the UTC reset"
            : "sufficient for further pages today",
        };
  return Response.json({
    reindexed,
    skipped,
    ...(stopped ? { stopped: true } : {}),
    ...(pagination ? { pagination } : {}),
    ...(budget ? { budget } : {}),
  });
}

async function headSha(
  env: Env,
  sr: SpaceRepo,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const token = await installationToken(env, sr.installationId, fetchImpl);
    const res = await fetchImpl(
      `${GH}/repos/${sr.owner}/${sr.repo}/commits/${sr.branch}`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) return null;
    return ((await res.json()) as { sha: string }).sha;
  } catch {
    return null;
  }
}

/** GitHub's compare response lists at most 300 files with no pagination
 *  signal, so a list that long cannot be trusted to be complete. */
export const COMPARE_FILE_CAP = 300;

/**
 * Ledger files changed and removed between two commits, or null when compare
 * cannot answer reliably (base gone after a force-push, truncated list, API
 * error) — the caller then falls back to a paged pass.
 */
async function compareFiles(
  env: Env,
  sr: SpaceRepo,
  base: string,
  head: string,
  fetchImpl: typeof fetch,
): Promise<{ changed: string[]; removed: string[] } | null> {
  try {
    const token = await installationToken(env, sr.installationId, fetchImpl);
    const res = await fetchImpl(
      `${GH}/repos/${sr.owner}/${sr.repo}/compare/${base}...${head}`,
      { headers: ghHeaders(token) },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      files?: {
        filename: string;
        status: string;
        previous_filename?: string;
      }[];
    };
    const files = body.files ?? [];
    if (files.length >= COMPARE_FILE_CAP) return null;
    const changed: string[] = [];
    const removed: string[] = [];
    for (const f of files) {
      if (f.status === "removed") {
        removed.push(f.filename);
        continue;
      }
      changed.push(f.filename);
      if (f.previous_filename) removed.push(f.previous_filename);
    }
    return { changed, removed };
  } catch {
    return null;
  }
}

/** Entries per paged pass. Unchanged files cost no fetch and no model, so a
 *  page is mostly skips once a space has ingest_state. */
export const CRON_REINDEX_PAGE = 50;

/** Entries the retry sweep re-extracts per space per tick. */
export const RETRY_SWEEP_LIMIT = 10;

const reindexCursorKey = (space: string) => `reindex-cursor:${space}`;

/**
 * Set to EXTRACTOR_VERSION when a full paged pass over the space completes.
 * Until it matches, the cron walks the whole tree once: entries indexed before
 * ingest_state existed, or under an older extractor, have no row the retry
 * sweep could find, so only a tree walk reaches them. It replaced a "no
 * ingest_state rows yet" check that went false the moment ANY write landed —
 * on 2026-09-14 three fresh writes hid 102 floored legacy entries from it.
 */
const backfillKey = (space: string) => `index-backfill:${space}`;

export async function reconcileAll(env: Env): Promise<void> {
  const deps = indexDeps(env);
  if (!deps) return;
  const fetchImpl = env.githubFetch ?? fetch;
  for (const sr of await listSpaceRepos(env)) {
    try {
      const head = await headSha(env, sr, fetchImpl);
      if (!head) continue;
      // Costs no neurons, so it runs even on days the budget is spent.
      await deps.db.repairDanglingSupersession(sr.space).catch(() => {});
      if (deps.gen) {
        const left = await remainingNeurons(env);
        if (left !== null && left < ENTRY_NEURON_RESERVE) continue;
      }

      const key = reindexCursorKey(sr.space);
      const raw = await env.ROUTING.get(key);
      // Cursor format stays `<head>:<offset>`; only the offset matters now.
      const resumeAt = raw
        ? Number.parseInt(raw.slice(raw.lastIndexOf(":") + 1), 10)
        : Number.NaN;
      const pagedPass = async (offset: number) => {
        const r = await reindexSpace(
          env,
          deps.db,
          deps.embed,
          deps.gen,
          sr,
          fetchImpl,
          { offset, limit: CRON_REINDEX_PAGE },
        );
        if (r.nextOffset === null) {
          await env.ROUTING.delete(key);
          await env.ROUTING.put(backfillKey(sr.space), EXTRACTOR_VERSION);
        } else {
          await env.ROUTING.put(key, `${head}:${r.nextOffset}`);
        }
      };

      const indexed = await deps.db.getLastIndexedSha(sr.space);
      const backfilled =
        (await env.ROUTING.get(backfillKey(sr.space))) === EXTRACTOR_VERSION;
      if (Number.isFinite(resumeAt)) {
        await pagedPass(resumeAt);
      } else if (indexed === null || !backfilled) {
        await pagedPass(0);
      } else if (indexed !== head) {
        const diff = await compareFiles(env, sr, indexed, head, fetchImpl);
        if (diff) {
          await ingestFiles(
            env,
            deps.db,
            deps.embed,
            deps.gen,
            sr,
            diff.changed,
            head,
            fetchImpl,
            { removed: diff.removed },
          );
        } else {
          await pagedPass(0);
        }
      }

      if (deps.gen) {
        const now = Date.now();
        const retry = await deps.db.listRetryable(
          sr.space,
          EXTRACTOR_VERSION,
          new Date(now - PENDING_STALE_MS).toISOString(),
          new Date(now - FLOORED_RETRY_MS).toISOString(),
          RETRY_SWEEP_LIMIT,
        );
        if (retry.length > 0) {
          await ingestFiles(
            env,
            deps.db,
            deps.embed,
            deps.gen,
            sr,
            retry,
            head,
            fetchImpl,
            { setSha: false },
          );
        }
      }
    } catch {
      // fail-open per space; the next tick resumes from the saved cursor/state
    }
  }
}
