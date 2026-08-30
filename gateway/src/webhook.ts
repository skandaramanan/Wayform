/**
 * POST /webhook/github — GitHub App push webhook, the ingest path for
 * local-plane writes (§2): a member's `git push` lands here seconds later and
 * updates the one remote index. Signature-checked (HMAC SHA-256), branch- and
 * repo-filtered via the spaces registry, fail-open: every non-error outcome
 * is a 2xx so GitHub does not retry-storm, and ingest failures are swallowed
 * (the cron reconciler catches them via last_indexed_sha drift).
 */
import type { Env } from "./env.js";
import { getSpaceRepo, getProductRepo, listSpaceRepos } from "./tenancy.js";
import { deactivateInstallation, getSpaceByInstallation } from "./spaces.js";
import { indexDeps } from "./deps.js";
import { ingestFiles, ingestEntries } from "./ingest.js";
import { writeEntry, warmRecencyCache } from "./github-store.js";
import { hookCacheKey } from "./mcp.js";

export async function verifyGithubSignature(
  secret: string,
  body: string,
  sigHeader: string | null,
): Promise<boolean> {
  if (!sigHeader?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const given = sigHeader.slice("sha256=".length).toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

interface PushPayload {
  ref?: string;
  after?: string;
  repository?: { full_name?: string };
  commits?: { added?: string[]; modified?: string[] }[];
}

interface PrPayload {
  action?: string;
  repository?: { full_name?: string };
  pull_request?: {
    merged?: boolean;
    number?: number;
    title?: string;
    body?: string | null;
    user?: { login?: string };
    merged_by?: { login?: string } | null;
    head?: { ref?: string };
    base?: { ref?: string };
  };
}

/** Store identity for App-recorded entries — a bot author, never a member. */
const RECORDER_AUTHOR = "GitHub";
const RECORDER_EMAIL = "github-app[bot]@users.noreply.github.com";
const PR_BODY_EXCERPT_MAX = 600;

/**
 * `pull_request` events from PRODUCT repos the App is installed on: a merged
 * PR becomes one `context` entry in the mapped space+project — the App-based
 * successor to integrations/github-actions/record-merged-pr.yml. Same
 * fail-open contract as push: every non-error outcome is 2xx, the write runs
 * in waitUntil, and failures are swallowed (a missed PR record is tolerable;
 * a retry-storm or blocked webhook queue is not).
 */
async function handleMergedPr(
  body: string,
  env: Env,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  let payload: PrPayload;
  try {
    payload = JSON.parse(body) as PrPayload;
  } catch {
    return new Response("bad payload", { status: 400 });
  }
  const pr = payload.pull_request;
  if (payload.action !== "closed" || !pr?.merged) {
    return new Response("ignored pr event", { status: 200 });
  }
  const fullName = payload.repository?.full_name ?? "";
  const mapping = await getProductRepo(env, fullName);
  if (!mapping) return new Response("unmapped repo", { status: 200 });
  const sr = (await listSpaceRepos(env)).find((r) => r.space === mapping.space);
  if (!sr) return new Response("space has no context repo", { status: 200 });

  const author = pr.user?.login ?? "unknown";
  const merger = pr.merged_by?.login ?? author;
  // ponytail: no commit-subject fetch (title+body carry the value); add via
  // the product repo's installation token if trial teams miss it.
  let summary =
    `PR merged: ${pr.title ?? ""} (${fullName}#${pr.number ?? "?"})` +
    ` | author ${author}, merged by ${merger}` +
    ` | ${pr.base?.ref ?? "?"}←${pr.head?.ref ?? "?"}`;
  const excerpt = (pr.body ?? "").trim().slice(0, PR_BODY_EXCERPT_MAX);
  if (excerpt) summary += ` | ${excerpt}`;

  const member = {
    ...sr,
    author: RECORDER_AUTHOR,
    authorEmail: RECORDER_EMAIL,
  };
  const work = (async () => {
    const entry = await writeEntry(
      env,
      member,
      mapping.project,
      { type: "context", payload: summary },
      env.githubFetch ?? fetch,
    );
    // Mirrors write_context: rebuild hook projection; warm recency so the
    // next queryless read avoids a cold GitHub fan-out.
    try {
      await env.ROUTING.delete(hookCacheKey(sr.space, mapping.project));
      const { refresh } = await warmRecencyCache(
        env,
        member,
        mapping.project,
        entry,
        env.githubFetch ?? fetch,
      );
      await refresh;
    } catch {
      // swallow: stale cache expires via TTL
    }
    const deps = indexDeps(env);
    if (deps) {
      await ingestEntries(
        deps.db,
        deps.embed,
        deps.gen,
        sr.space,
        mapping.project,
        [entry],
      );
    }
  })().catch(() => {
    // swallowed: a missed PR record is tolerable; never 5xx GitHub
  });
  if (ctx) {
    ctx.waitUntil(work);
    return new Response("accepted", { status: 202 });
  }
  await work;
  return new Response("ok", { status: 200 });
}

interface InstallationPayload {
  action?: string;
  installation?: {
    id?: number;
    account?: { login?: string; id?: number; type?: string };
  };
  repositories?: {
    name?: string;
    full_name?: string;
    private?: boolean;
    default_branch?: string | null;
  }[];
  repositories_added?: {
    name?: string;
    full_name?: string;
    private?: boolean;
    default_branch?: string | null;
  }[];
  repositories_removed?: { name?: string; full_name?: string }[];
  sender?: { login?: string; id?: number };
}

async function handleInstallationEvent(
  body: string,
  env: Env,
): Promise<Response> {
  let payload: InstallationPayload;
  try {
    payload = JSON.parse(body) as InstallationPayload;
  } catch {
    return new Response("bad payload", { status: 400 });
  }
  const installationId = payload.installation?.id;
  if (!installationId) return new Response("ignored event", { status: 200 });
  if (payload.action === "deleted" || payload.action === "suspend") {
    const result = await deactivateInstallation(env, installationId);
    return new Response(result.deactivated ? "deactivated" : "ignored", {
      status: 200,
    });
  }
  if (payload.action === "removed" && payload.repositories_removed?.length) {
    const space = await getSpaceByInstallation(env, installationId);
    const memoryRepo = `${space?.owner}/${space?.repo}`;
    const removed = payload.repositories_removed.some(
      (repo) =>
        repo.full_name === memoryRepo ||
        (space != null && repo.name === space.repo),
    );
    if (removed) {
      await deactivateInstallation(env, installationId);
      return new Response("deactivated", { status: 200 });
    }
  }
  const repos = [
    ...(payload.repositories ?? []),
    ...(payload.repositories_added ?? []),
  ];
  const owner = payload.installation?.account?.login;
  await env.ROUTING.put(
    `installation:inventory:${installationId}`,
    JSON.stringify({
      installationId,
      owner,
      senderGithubId: payload.sender?.id,
      senderLogin: payload.sender?.login,
      repositories: repos,
      action: payload.action,
      updatedAt: Date.now(),
    }),
    { expirationTtl: 60 * 60 },
  );
  return new Response("recorded", { status: 200 });
}

export async function handleWebhook(
  req: Request,
  env: Env,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  const body = await req.text();
  if (
    !env.WEBHOOK_SECRET ||
    !(await verifyGithubSignature(
      env.WEBHOOK_SECRET,
      body,
      req.headers.get("x-hub-signature-256"),
    ))
  ) {
    return new Response("bad signature", { status: 401 });
  }
  const event = req.headers.get("x-github-event");
  if (event === "pull_request") return handleMergedPr(body, env, ctx);
  if (event === "installation" || event === "installation_repositories") {
    return handleInstallationEvent(body, env);
  }
  if (event !== "push") {
    return new Response("ignored event", { status: 200 });
  }

  let payload: PushPayload;
  try {
    payload = JSON.parse(body) as PushPayload;
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  const fullName = payload.repository?.full_name ?? "";
  const sr = await getSpaceRepo(env, fullName);
  if (!sr) return new Response("unknown repo", { status: 200 });
  if (payload.ref !== `refs/heads/${sr.branch}`) {
    return new Response("ignored ref", { status: 200 });
  }
  const deps = indexDeps(env);
  if (!deps || !payload.after) {
    return new Response("index disabled", { status: 200 });
  }

  const paths = [
    ...new Set(
      (payload.commits ?? []).flatMap((c) => [
        ...(c.added ?? []),
        ...(c.modified ?? []),
      ]),
    ),
  ];
  const after = payload.after;
  const work = ingestFiles(
    env,
    deps.db,
    deps.embed,
    deps.gen,
    sr,
    paths,
    after,
    env.githubFetch ?? fetch,
  ).catch(() => {
    // swallowed: reconcile cron detects the sha gap and reindexes
  });
  if (ctx) {
    ctx.waitUntil(work);
    return new Response("accepted", { status: 202 });
  }
  await work;
  return new Response("ok", { status: 200 });
}
