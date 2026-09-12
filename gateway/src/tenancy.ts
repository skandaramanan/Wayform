import type { Env, HandlerCtx } from "./env.js";
import { appJwt } from "./github-auth.js";
import type { SpaceRepo } from "./ingest.js";
import { getMemberByGithubId } from "./spaces.js";

/**
 * One KV record per GitHub user. `owner`/`repo`/`installationId` bind the
 * member to exactly one space's repo — tool calls carry no space parameters,
 * so a routing bug cannot cross tenants: the credential itself can't.
 */
export interface SpaceMember {
  space: string;
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
  author: string;
  authorEmail: string;
  githubId?: number;
  githubLogin?: string;
  role?: "admin" | "member";
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Gateway OPERATORS: GitHub numeric ids permitted to call /admin/* routes.
 *
 * Deliberately distinct from a SpaceMember's `role: "admin"`, which is admin
 * *of one space*. These routes are gateway-wide — allowlist any owner, register
 * any product repo, reindex any space — so space admins must not inherit them.
 *
 * Fails closed: an unset or empty ADMIN_GITHUB_IDS makes nobody an operator.
 */
export function isOperator(env: Env, githubId?: number): boolean {
  if (githubId == null) return false;
  return (env.ADMIN_GITHUB_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(String(githubId));
}

/**
 * Guard for /admin/* handlers: returns a 403 Response to return as-is, or null
 * when the caller is an operator.
 *
 * Both outcomes log. A guard that is silent when it rejects is
 * indistinguishable from one that never ran (see the 2026-08-31 WEBHOOK_SECRET
 * post-mortem), and the grant line is the audit trail that the old shared
 * x-admin-secret could never provide.
 */
export function requireOperator(
  req: Request,
  env: Env,
  ctx?: HandlerCtx,
): Response | null {
  const githubId = ctx?.props?.githubId ?? env.oauthProps?.githubId;
  const path = new URL(req.url).pathname;
  if (!isOperator(env, githubId)) {
    console.log(
      JSON.stringify({
        evt: "admin_denied",
        path,
        githubId: githubId ?? null,
        reason: githubId == null ? "no_identity" : "not_operator",
      }),
    );
    return new Response("forbidden", { status: 403 });
  }
  console.log(JSON.stringify({ evt: "admin_ok", path, githubId }));
  return null;
}

/** Bearer identity -> member record, or null. Identity is github_id from OAuth props. */
export async function resolveMember(
  req: Request,
  env: Env,
  ctx?: HandlerCtx,
): Promise<SpaceMember | null> {
  const githubId = ctx?.props?.githubId ?? env.oauthProps?.githubId;
  if (githubId == null) return null;
  return getMemberByGithubId(env, githubId);
}

/** Single-key registry mapping "owner/repo" -> SpaceRepo, maintained on
 *  member placement. Powers webhook repo->space lookup and cron reconciliation.
 *  One JSON blob is fine at pilot scale (a handful of spaces). */
const REGISTRY_KEY = "spaces:registry";

export async function registerSpaceRepo(
  env: Env,
  sr: SpaceRepo,
): Promise<void> {
  const raw = await env.ROUTING.get(REGISTRY_KEY);
  const reg = raw ? (JSON.parse(raw) as Record<string, SpaceRepo>) : {};
  reg[`${sr.owner}/${sr.repo}`] = sr;
  await env.ROUTING.put(REGISTRY_KEY, JSON.stringify(reg));
}

export async function getSpaceRepo(
  env: Env,
  fullName: string,
): Promise<SpaceRepo | null> {
  const raw = await env.ROUTING.get(REGISTRY_KEY);
  if (!raw) return null;
  return (JSON.parse(raw) as Record<string, SpaceRepo>)[fullName] ?? null;
}

export async function listSpaceRepos(env: Env): Promise<SpaceRepo[]> {
  const raw = await env.ROUTING.get(REGISTRY_KEY);
  return raw ? Object.values(JSON.parse(raw) as Record<string, SpaceRepo>) : [];
}

/** Product-repo registry: maps a team's PRODUCT repo ("owner/repo") to the
 *  space+project its merged-PR summaries are recorded into. Distinct from
 *  spaces:registry (context repos). Same single-blob pattern — fine at pilot
 *  scale. Filled by POST /admin/product-repos at team provisioning. */
const PRODUCT_REPOS_KEY = "product-repos:registry";

export interface ProductRepo {
  space: string;
  project: string;
}

export async function getProductRepo(
  env: Env,
  fullName: string,
): Promise<ProductRepo | null> {
  const raw = await env.ROUTING.get(PRODUCT_REPOS_KEY);
  if (!raw) return null;
  return (JSON.parse(raw) as Record<string, ProductRepo>)[fullName] ?? null;
}

/**
 * POST /admin/product-repos — register a product repo for merged-PR
 * recording. Body: { owner, repo, space, project }. Re-POST overwrites;
 * removal is a manual KV edit at pilot scale.
 */
export async function handleAdminAddProductRepo(
  req: Request,
  env: Env,
  ctx?: HandlerCtx,
): Promise<Response> {
  const denied = requireOperator(req, env, ctx);
  if (denied) return denied;
  let body: { owner?: string; repo?: string; space?: string; project?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  for (const key of ["owner", "repo", "space", "project"] as const) {
    if (!body[key]) {
      return Response.json({ error: `missing ${key}` }, { status: 400 });
    }
  }
  const fullName = `${body.owner}/${body.repo}`;
  const raw = await env.ROUTING.get(PRODUCT_REPOS_KEY);
  const reg = raw ? (JSON.parse(raw) as Record<string, ProductRepo>) : {};
  reg[fullName] = { space: body.space!, project: body.project! };
  await env.ROUTING.put(PRODUCT_REPOS_KEY, JSON.stringify(reg));
  return Response.json({ repo: fullName, ...reg[fullName] });
}

/**
 * GET /admin/installations?owner=<owner> — resolve a GitHub App
 * installation ID for an owner, so the CLI onboarding flow (Plan C) can
 * detect "the operator finished installing the App" without ever holding
 * GITHUB_APP_PRIVATE_KEY itself. Pilot-scale assumption: one installation
 * per account — two-plus matches is a 409, resolved manually.
 */
export async function handleAdminListInstallations(
  req: Request,
  env: Env,
  ctx?: HandlerCtx,
): Promise<Response> {
  const denied = requireOperator(req, env, ctx);
  if (denied) return denied;
  const owner = new URL(req.url).searchParams.get("owner");
  if (!owner) {
    return Response.json({ error: "missing owner" }, { status: 400 });
  }
  const fetchImpl = env.githubFetch ?? fetch;
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const res = await fetchImpl(
    "https://api.github.com/app/installations?per_page=100",
    {
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": "memorylayer-gateway",
      },
    },
  );
  if (!res.ok) {
    return Response.json(
      { error: `github installations list failed: ${res.status}` },
      { status: 502 },
    );
  }
  const installations = (await res.json()) as {
    id: number;
    account: { login: string };
  }[];
  const matches = installations.filter(
    (i) => i.account?.login?.toLowerCase() === owner.toLowerCase(),
  );
  if (matches.length === 0) {
    return Response.json(
      { error: `no installation found for owner "${owner}"` },
      { status: 404 },
    );
  }
  if (matches.length > 1) {
    return Response.json(
      {
        error: `multiple installations found for owner "${owner}"`,
        installationIds: matches.map((m) => m.id),
      },
      { status: 409 },
    );
  }
  return Response.json({ installationId: matches[0].id });
}
