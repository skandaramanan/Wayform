import type { Env } from "./env.js";
import { b64url, appJwt } from "./github-auth.js";
import type { SpaceRepo } from "./ingest.js";

/**
 * One KV record per member token. `owner`/`repo`/`installationId` bind the
 * token to exactly one space's repo — tool calls carry no space parameters,
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

/** 32 random bytes, url-safe, prefixed so tokens are grep-able in configs. */
export function newToken(): string {
  return "mlk_" + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Pull the raw token off a request. Preferred form is the
 * `Authorization: Bearer mlk_...` header; but clients that only accept a URL
 * (e.g. ChatGPT's custom-connector UI has no header field) can carry it in the
 * path as `/mcp/mlk_...` or in a `?key=mlk_...` query param. Header wins when
 * present. A URL-borne token is more exposed (logs, history) than a header —
 * mint client-specific tokens for it so a leak is revocable in isolation.
 */
export function extractToken(req: Request): string | null {
  const match = (req.headers.get("authorization") ?? "").match(
    /^Bearer (.+)$/i,
  );
  if (match) return match[1];
  const url = new URL(req.url);
  const key = url.searchParams.get("key");
  if (key) return key;
  const seg = url.pathname.match(/^\/mcp\/(.+)$/);
  return seg ? decodeURIComponent(seg[1]) : null;
}

/** Bearer token -> member record, or null. KV stores only the token's hash. */
export async function resolveMember(
  req: Request,
  env: Env,
): Promise<SpaceMember | null> {
  const token = extractToken(req);
  if (!token) return null;
  const record = await env.ROUTING.get(`member:${await sha256Hex(token)}`);
  return record ? (JSON.parse(record) as SpaceMember) : null;
}

/** Single-key registry mapping "owner/repo" -> SpaceRepo, maintained on
 *  member mint. Powers webhook repo->space lookup and cron reconciliation.
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

const REQUIRED: (keyof SpaceMember)[] = [
  "space",
  "installationId",
  "owner",
  "repo",
  "author",
  "authorEmail",
];

/**
 * POST /admin/members — mint a member token for a space. Pilot-scale
 * provisioning: guarded by the ADMIN_SECRET Worker secret; the CLI onboarding
 * flow (Plan C) wraps this endpoint. Returns the raw token exactly once.
 */
export async function handleAdminAddMember(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  let body: Partial<SpaceMember>;
  try {
    body = (await req.json()) as Partial<SpaceMember>;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  for (const key of REQUIRED) {
    if (body[key] === undefined || body[key] === "") {
      return Response.json({ error: `missing ${key}` }, { status: 400 });
    }
  }
  const member = { branch: "main", ...body } as SpaceMember;
  const token = newToken();
  await env.ROUTING.put(
    `member:${await sha256Hex(token)}`,
    JSON.stringify(member),
  );
  await registerSpaceRepo(env, {
    space: member.space,
    installationId: member.installationId,
    owner: member.owner,
    repo: member.repo,
    branch: member.branch,
  });
  return Response.json({ token, member });
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
): Promise<Response> {
  if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
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
