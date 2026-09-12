/**
 * Reindex + reconciliation: POST /admin/reindex rebuilds spaces from the
 * ledger on demand (disposability, §2.3); reconcileAll runs on the cron
 * trigger and catches dropped webhooks by comparing each space's HEAD commit
 * to last_indexed_sha (§2.1 — no Queues, cron bounds divergence).
 *
 * The cron rebuild is PAGINATED (2026-07-13, post-incident): Phase B made
 * ingest cost ~3 subrequests per entry (content fetch + extract + embed), so
 * an unpaginated rebuild of a space beyond ~15 entries blows the Workers
 * free-plan 50-subrequest cap AFTER the offset-0 wipe — leaving the space
 * empty with no indexed sha, which re-drifts and re-wipes on every later
 * tick (confirmed live: docs/index_state emptied, fact_entities orphaned).
 * reconcileAll now processes one CRON_REINDEX_PAGE per tick, persisting the
 * resume offset in KV, so a full rebuild self-heals across ticks.
 */
import type { Env, HandlerCtx } from "./env.js";
import { listSpaceRepos, requireOperator } from "./tenancy.js";
import { indexDeps } from "./deps.js";
import { reindexSpace, type SpaceRepo } from "./ingest.js";
import { installationToken } from "./github-auth.js";

const GH = "https://api.github.com";

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
      },
    );
    reindexed[sr.space] = result.count;
    if (body.limit != null) {
      pagination = pagination ?? {};
      pagination[sr.space] = {
        total: result.total,
        nextOffset: result.nextOffset,
      };
    }
  }
  return Response.json(pagination ? { reindexed, pagination } : { reindexed });
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
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "memorylayer-gateway",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!res.ok) return null;
    return ((await res.json()) as { sha: string }).sha;
  } catch {
    return null;
  }
}

/** Entries per cron reindex page. Ingest costs ~3 subrequests/entry plus
 *  token/head/tree/D1 overhead; 10 was proven live under the Free plan's
 *  50-subrequest cap (2026-07-13 manual limit=10 backfill) where 40 was fatally
 *  over. The Paid plan raises that cap to 10,000, so the binding constraint is
 *  now the per-invocation CPU limit, not subrequests: 50 entries (~150
 *  subrequests) converges a full rebuild in ~3 ticks instead of ~13, shrinking
 *  the window where a space serves a half-built index. Total neuron spend is
 *  unchanged — the same entries get extracted either way, just sooner. */
export const CRON_REINDEX_PAGE = 50;

const reindexCursorKey = (space: string) => `reindex-cursor:${space}`;

export async function reconcileAll(env: Env): Promise<void> {
  const deps = indexDeps(env);
  if (!deps) return;
  const fetchImpl = env.githubFetch ?? fetch;
  for (const sr of await listSpaceRepos(env)) {
    try {
      const head = await headSha(env, sr, fetchImpl);
      if (!head) continue;
      const indexed = await deps.db.getLastIndexedSha(sr.space);
      if (indexed === head) {
        // A rebuild abandoned mid-flight (a webhook ingest caught the sha up
        // first) leaves its cursor behind; resuming that cursor later against
        // a DIFFERENT head would skip the wiped 0..offset range. Delete it.
        await env.ROUTING.delete(reindexCursorKey(sr.space));
        continue;
      }
      // Resume a rebuild already in flight, else start one at offset 0 (the
      // only offset that wipes). The cursor is tagged with the head it was
      // rebuilding toward: a cursor for any other head restarts at 0 rather
      // than resuming into a stale, never-wiped index. One page per tick keeps
      // every invocation under the subrequest cap; last_indexed_sha only
      // advances when the final page completes, so an interrupted rebuild
      // resumes, not lies.
      const raw = await env.ROUTING.get(reindexCursorKey(sr.space));
      const [curHead, curOff] = raw?.split(":") ?? [];
      const offset =
        curHead === head ? Number.parseInt(curOff ?? "", 10) || 0 : 0;
      const r = await reindexSpace(
        env,
        deps.db,
        deps.embed,
        deps.gen,
        sr,
        fetchImpl,
        {
          offset,
          limit: CRON_REINDEX_PAGE,
        },
      );
      if (r.nextOffset === null) {
        await env.ROUTING.delete(reindexCursorKey(sr.space));
      } else {
        await env.ROUTING.put(
          reindexCursorKey(sr.space),
          `${head}:${r.nextOffset}`,
        );
      }
    } catch {
      // fail-open per space; next cron tick resumes from the saved cursor
    }
  }
}
