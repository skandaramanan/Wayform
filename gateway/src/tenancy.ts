import type { Env } from "./env.js";
import { b64url } from "./github-auth.js";

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

/** Bearer token -> member record, or null. KV stores only the token's hash. */
export async function resolveMember(
  req: Request,
  env: Env,
): Promise<SpaceMember | null> {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer (.+)$/i);
  if (!match) return null;
  const record = await env.ROUTING.get(`member:${await sha256Hex(match[1])}`);
  return record ? (JSON.parse(record) as SpaceMember) : null;
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
  return Response.json({ token, member });
}
