/**
 * Team invite codes: the operator mints one `wfi_` code per team
 * (POST /admin/invites); each dev exchanges it for their own personal
 * member token (public POST /join). Same hashed-secret KV pattern as
 * member tokens — a leaked KV dump reveals no usable codes.
 */
import type { Env } from "./env.js";
import { b64url } from "./github-auth.js";
import { mintMember, sha256Hex, type SpaceMember } from "./tenancy.js";

export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const INVITE_MAX_USES = 25;

export interface Invite {
  space: string;
  owner: string;
  repo: string;
  installationId: number;
  branch: string;
  expiresAt: number; // epoch ms
  usesLeft: number;
}

function newInviteCode(): string {
  return "wfi_" + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

const REQUIRED = ["space", "owner", "repo", "installationId"] as const;

/** POST /admin/invites — mint one team invite. Raw code returned exactly
 *  once. Revocation is a manual KV delete at pilot scale. */
export async function handleAdminCreateInvite(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  let body: Partial<Invite>;
  try {
    body = (await req.json()) as Partial<Invite>;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  for (const key of REQUIRED) {
    if (body[key] === undefined || body[key] === "") {
      return Response.json({ error: `missing ${key}` }, { status: 400 });
    }
  }
  const invite: Invite = {
    space: body.space!,
    owner: body.owner!,
    repo: body.repo!,
    installationId: body.installationId!,
    branch: body.branch ?? "main",
    expiresAt: Date.now() + INVITE_TTL_MS,
    usesLeft: INVITE_MAX_USES,
  };
  const code = newInviteCode();
  await env.ROUTING.put(
    `invite:${await sha256Hex(code)}`,
    JSON.stringify(invite),
  );
  return Response.json({
    invite: code,
    expiresAt: invite.expiresAt,
    usesLeft: invite.usesLeft,
  });
}

/** One generic rejection for every invite-side failure — no probing oracle. */
function rejectInvite(): Response {
  return Response.json({ error: "invalid or expired invite" }, { status: 400 });
}

/** POST /join — exchange a live invite for a fresh personal member token. */
export async function handleJoin(req: Request, env: Env): Promise<Response> {
  let body: { invite?: string; author?: string; authorEmail?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.invite) return rejectInvite();
  if (!body.author || !body.authorEmail) {
    return Response.json(
      { error: "missing author or authorEmail" },
      { status: 400 },
    );
  }
  const key = `invite:${await sha256Hex(body.invite)}`;
  const raw = await env.ROUTING.get(key);
  if (!raw) return rejectInvite();
  const invite = JSON.parse(raw) as Invite;
  if (invite.expiresAt < Date.now() || invite.usesLeft <= 0) {
    return rejectInvite();
  }
  // ponytail: KV read-modify-write — concurrent joins can over-admit by ~1;
  // move to a DO/atomic counter if invites ever guard anything scarce.
  await env.ROUTING.put(
    key,
    JSON.stringify({ ...invite, usesLeft: invite.usesLeft - 1 }),
  );
  const member: SpaceMember = {
    space: invite.space,
    installationId: invite.installationId,
    owner: invite.owner,
    repo: invite.repo,
    branch: invite.branch,
    author: body.author,
    authorEmail: body.authorEmail,
  };
  const token = await mintMember(env, member);
  // Operator ledger line: the hash IS the revoke handle. Never the raw token.
  console.log(
    `join: space=${invite.space} author=${JSON.stringify(body.author)} tokenHash=${await sha256Hex(token)}`,
  );
  return Response.json({ token, member });
}
