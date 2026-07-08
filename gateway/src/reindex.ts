/**
 * Reindex + reconciliation: POST /admin/reindex rebuilds spaces from the
 * ledger on demand (disposability, §2.3); reconcileAll runs on the cron
 * trigger and catches dropped webhooks by comparing each space's HEAD commit
 * to last_indexed_sha (§2.1 — no Queues, cron bounds divergence). At pilot
 * corpus size a blunt full reindex on drift is cheaper than diffing.
 */
import type { Env } from "./env.js";
import { listSpaceRepos } from "./tenancy.js";
import { indexDeps } from "./deps.js";
import { reindexSpace, type SpaceRepo } from "./ingest.js";
import { installationToken } from "./github-auth.js";

const GH = "https://api.github.com";

export async function handleAdminReindex(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const deps = indexDeps(env);
  if (!deps) return Response.json({ error: "index disabled" }, { status: 503 });

  let body: {
    repo?: string;
    project?: string;
    offset?: number;
    limit?: number;
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
    const result = await reindexSpace(
      env,
      deps.db,
      deps.embed,
      null, // gen wired to deps.gen in Task 5
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

export async function reconcileAll(env: Env): Promise<void> {
  const deps = indexDeps(env);
  if (!deps) return;
  const fetchImpl = env.githubFetch ?? fetch;
  for (const sr of await listSpaceRepos(env)) {
    try {
      const head = await headSha(env, sr, fetchImpl);
      if (!head) continue;
      const indexed = await deps.db.getLastIndexedSha(sr.space);
      if (indexed === head) continue;
      await reindexSpace(env, deps.db, deps.embed, null, sr, fetchImpl);
    } catch {
      // fail-open per space; next cron tick retries
    }
  }
}
