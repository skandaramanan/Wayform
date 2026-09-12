import type { Env, HandlerCtx } from "./env.js";
import { registerSpaceRepo, type SpaceMember, requireOperator } from "./tenancy.js";
import { indexDeps } from "./deps.js";
import { membershipClaims } from "./membership-claims.js";

export const ALLOWLIST_KEY = "signup:allowlist";

export interface SpaceRecord {
  space: string;
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
  plan: "pilot";
  createdByGithubId: number;
  status: "active";
}

export interface GithubInvite {
  space: string;
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
  invitedByGithubId: number;
  invitedAt: number;
}

export interface GithubIdentity {
  id: number;
  login: string;
  email?: string | null;
}

export interface GithubInstallation {
  id: number;
  account: { login: string; id?: number; type?: string };
}

export type PlaceResult =
  | { kind: "member"; member: SpaceMember }
  | { kind: "space_conflict"; existingSpace: string }
  | { kind: "preview" };

export function spaceInstKey(installationId: number): string {
  return `space:inst:${installationId}`;
}

export function memberGithubKey(githubId: number): string {
  return `member:github:${githubId}`;
}

export function loginIndexKey(login: string): string {
  return `github:login:${login.toLowerCase()}`;
}

export function inviteGithubKey(login: string): string {
  return `invite:github:${login.toLowerCase()}`;
}

export function spaceMembersKey(space: string): string {
  return `space:members:${space}`;
}

export function spaceInvitesKey(space: string): string {
  return `space:invites:${space}`;
}

async function readIndex<T extends string | number>(
  env: Env,
  key: string,
): Promise<T[]> {
  const raw = await env.ROUTING.get(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function addToIndex<T extends string | number>(
  env: Env,
  key: string,
  value: T,
): Promise<void> {
  const values = await readIndex<T>(env, key);
  if (!values.includes(value)) values.push(value);
  await env.ROUTING.put(key, JSON.stringify(values));
}

async function removeFromIndex<T extends string | number>(
  env: Env,
  key: string,
  value: T,
): Promise<void> {
  const values = (await readIndex<T>(env, key)).filter(
    (item) => item !== value,
  );
  if (values.length === 0) await env.ROUTING.delete(key);
  else await env.ROUTING.put(key, JSON.stringify(values));
}

export function githubNoreply(id: number, login: string): string {
  return `${id}+${login}@users.noreply.github.com`;
}

export function spaceNameFor(owner: string, repo: string): string {
  return `${owner}-${repo}`.toLowerCase();
}

export function allowlistMatches(list: string[], login: string): boolean {
  if (list.includes("*")) return true;
  const needle = login.toLowerCase();
  return list.some((x) => x.toLowerCase() === needle);
}

export async function getAllowlist(env: Env): Promise<string[]> {
  const raw = await env.ROUTING.get(ALLOWLIST_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export async function addToAllowlist(
  env: Env,
  names: string[],
): Promise<string[]> {
  const current = await getAllowlist(env);
  const seen = new Set(current.map((n) => n.toLowerCase()));
  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed.toLowerCase())) continue;
    current.push(trimmed);
    seen.add(trimmed.toLowerCase());
  }
  await env.ROUTING.put(ALLOWLIST_KEY, JSON.stringify(current));
  return current;
}

export async function isAllowlisted(env: Env, login: string): Promise<boolean> {
  return allowlistMatches(await getAllowlist(env), login);
}

export async function getSpaceByInstallation(
  env: Env,
  installationId: number,
): Promise<SpaceRecord | null> {
  const raw = await env.ROUTING.get(spaceInstKey(installationId));
  return raw ? (JSON.parse(raw) as SpaceRecord) : null;
}

export async function getMemberByGithubId(
  env: Env,
  githubId: number,
): Promise<SpaceMember | null> {
  const raw = await env.ROUTING.get(memberGithubKey(githubId));
  return raw ? (JSON.parse(raw) as SpaceMember) : null;
}

export async function getGithubInvite(
  env: Env,
  login: string,
): Promise<GithubInvite | null> {
  const raw = await env.ROUTING.get(inviteGithubKey(login));
  return raw ? (JSON.parse(raw) as GithubInvite) : null;
}

export async function upsertGithubMember(
  env: Env,
  member: SpaceMember,
): Promise<void> {
  if (member.githubId == null) {
    throw new Error("githubId is required");
  }
  const existing = await getMemberByGithubId(env, member.githubId);
  if (existing && existing.space !== member.space) {
    throw new Error(
      `@${member.githubLogin ?? member.githubId} already belongs to another Wayform space. ` +
        "Multi-space membership is not available yet.",
    );
  }
  const claimedSpace = await membershipClaims(env).claimUser(
    member.githubId,
    member.space,
  );
  if (claimedSpace !== member.space) {
    throw new Error(
      `@${member.githubLogin ?? member.githubId} already belongs to another Wayform space. ` +
        "Multi-space membership is not available yet.",
    );
  }
  await env.ROUTING.put(
    memberGithubKey(member.githubId),
    JSON.stringify(member),
  );
  await addToIndex(env, spaceMembersKey(member.space), member.githubId);
  if (member.githubLogin) {
    await env.ROUTING.put(
      loginIndexKey(member.githubLogin),
      String(member.githubId),
    );
  }
  await registerSpaceRepo(env, {
    space: member.space,
    installationId: member.installationId,
    owner: member.owner,
    repo: member.repo,
    branch: member.branch,
  });
}

export async function inviteGithubUser(
  env: Env,
  caller: SpaceMember,
  login: string,
): Promise<GithubInvite> {
  const normalized = login.trim().toLowerCase();
  const targetId = await env.ROUTING.get(loginIndexKey(normalized));
  if (targetId) {
    const target = await getMemberByGithubId(env, Number(targetId));
    if (target?.space !== caller.space) {
      throw new Error(
        `@${normalized} already belongs to another Wayform space. ` +
          "Multi-space membership is not available yet.",
      );
    }
    throw new Error(`@${normalized} is already a member of this space.`);
  }
  const existing = await getGithubInvite(env, normalized);
  if (existing && existing.space !== caller.space) {
    throw new Error(
      `@${normalized} already has an invitation to another Wayform space. ` +
        "Multi-space membership is not available yet.",
    );
  }
  const claimedSpace = await membershipClaims(env).claimInvite(
    normalized,
    caller.space,
  );
  if (claimedSpace !== caller.space) {
    throw new Error(
      `@${normalized} already has an invitation to another Wayform space. ` +
        "Multi-space membership is not available yet.",
    );
  }
  const record: GithubInvite = {
    space: caller.space,
    installationId: caller.installationId,
    owner: caller.owner,
    repo: caller.repo,
    branch: caller.branch,
    invitedByGithubId: caller.githubId ?? 0,
    invitedAt: Date.now(),
  };
  await env.ROUTING.put(inviteGithubKey(normalized), JSON.stringify(record));
  await addToIndex(env, spaceInvitesKey(caller.space), normalized);
  return record;
}

export async function revokeGithubUser(
  env: Env,
  caller: SpaceMember,
  login: string,
): Promise<"revoked" | "not_found"> {
  const normalized = login.trim().toLowerCase();
  let revoked = false;
  const invite = await getGithubInvite(env, normalized);
  if (invite?.space === caller.space) {
    await membershipClaims(env).releaseInvite(normalized, caller.space);
    await env.ROUTING.delete(inviteGithubKey(normalized));
    await removeFromIndex(env, spaceInvitesKey(caller.space), normalized);
    revoked = true;
  }
  const idRaw = await env.ROUTING.get(loginIndexKey(normalized));
  if (idRaw) {
    const githubId = Number(idRaw);
    const member = await getMemberByGithubId(env, githubId);
    const tombstoneKey = `revocation:github:${githubId}`;
    const tombstoneRaw = await env.ROUTING.get(tombstoneKey);
    const tombstone = tombstoneRaw
      ? (JSON.parse(tombstoneRaw) as { space?: string })
      : null;
    if (member?.space === caller.space || tombstone?.space === caller.space) {
      await env.ROUTING.put(
        tombstoneKey,
        JSON.stringify({ space: caller.space, login: normalized }),
      );
      await env.ROUTING.delete(memberGithubKey(githubId));
      await revokeUserGrants(env, githubId);
      await removeFromIndex(env, spaceMembersKey(caller.space), githubId);
      await membershipClaims(env).releaseUser(githubId, caller.space);
      await env.ROUTING.delete(loginIndexKey(normalized));
      await env.ROUTING.delete(tombstoneKey);
      revoked = true;
    }
  }
  return revoked ? "revoked" : "not_found";
}

export interface ActivateInput {
  installationId: number;
  owner: string;
  repo: string;
  actorGithubId: number;
  actorLogin: string;
  branch?: string;
}

export async function activateInstallation(
  env: Env,
  input: ActivateInput,
): Promise<"active" | "preview" | "space_conflict"> {
  const existing = await getSpaceByInstallation(env, input.installationId);
  if (existing?.status === "active") return "active";
  const actorMembership = await getMemberByGithubId(env, input.actorGithubId);
  if (
    actorMembership &&
    actorMembership.installationId !== input.installationId
  ) {
    return "space_conflict";
  }
  if (!(await isAllowlisted(env, input.owner))) return "preview";

  const branch = input.branch ?? "main";
  const spaceName = spaceNameFor(input.owner, input.repo);
  const claimedSpace = await membershipClaims(env).claimUser(
    input.actorGithubId,
    spaceName,
  );
  if (claimedSpace !== spaceName) return "space_conflict";
  const space: SpaceRecord = {
    space: spaceName,
    installationId: input.installationId,
    owner: input.owner,
    repo: input.repo,
    branch,
    plan: "pilot",
    createdByGithubId: input.actorGithubId,
    status: "active",
  };
  await env.ROUTING.put(
    spaceInstKey(input.installationId),
    JSON.stringify(space),
  );
  await upsertGithubMember(
    env,
    memberFromIdentity(
      space,
      {
        id: input.actorGithubId,
        login: input.actorLogin,
      },
      "admin",
    ),
  );
  return "active";
}

export async function deactivateInstallation(
  env: Env,
  installationId: number,
): Promise<{ deactivated: boolean; space?: string }> {
  const space = await getSpaceByInstallation(env, installationId);
  if (!space) return { deactivated: false };
  const tombstoneKey = `deactivation:inst:${installationId}`;
  const tombstoneRaw = await env.ROUTING.get(tombstoneKey);
  const tombstone = tombstoneRaw
    ? (JSON.parse(tombstoneRaw) as {
        memberIds?: number[];
        startedAt?: number;
      })
    : {};
  await env.ROUTING.put(
    tombstoneKey,
    JSON.stringify({
      ...tombstone,
      space: space.space,
      startedAt: tombstone.startedAt ?? Date.now(),
    }),
  );

  const listedMemberIds = await readIndex<number>(
    env,
    spaceMembersKey(space.space),
  );
  const memberIds = new Set([
    ...listedMemberIds,
    ...(tombstone.memberIds ?? []),
  ]);
  for (const key of await listKeys(env, "member:github:")) {
    const raw = await env.ROUTING.get(key);
    if (!raw) continue;
    const member = JSON.parse(raw) as SpaceMember;
    if (member.space === space.space && member.githubId != null) {
      memberIds.add(member.githubId);
    }
  }
  await env.ROUTING.put(
    tombstoneKey,
    JSON.stringify({
      space: space.space,
      memberIds: [...memberIds],
      startedAt: tombstone.startedAt ?? Date.now(),
    }),
  );
  for (const githubId of memberIds) {
    const member = await getMemberByGithubId(env, githubId);
    await env.ROUTING.delete(memberGithubKey(githubId));
    if (member?.githubLogin) {
      const loginKey = loginIndexKey(member.githubLogin);
      if ((await env.ROUTING.get(loginKey)) === String(githubId)) {
        await env.ROUTING.delete(loginKey);
      }
    }
  }
  for (const githubId of memberIds) {
    await revokeUserGrants(env, githubId);
    await membershipClaims(env).releaseUser(githubId, space.space);
  }

  const listedInvites = await readIndex<string>(
    env,
    spaceInvitesKey(space.space),
  );
  const inviteLogins = new Set(listedInvites);
  for (const key of await listKeys(env, "invite:github:")) {
    const raw = await env.ROUTING.get(key);
    if (!raw) continue;
    const invite = JSON.parse(raw) as GithubInvite;
    if (invite.space === space.space) {
      inviteLogins.add(key.slice("invite:github:".length));
    }
  }
  for (const login of inviteLogins) {
    await membershipClaims(env).releaseInvite(login, space.space);
    await env.ROUTING.delete(inviteGithubKey(login));
  }

  await env.ROUTING.delete(spaceMembersKey(space.space));
  await env.ROUTING.delete(spaceInvitesKey(space.space));
  await deletePrefixes(env, [
    `recency:${space.space}:`,
    `hookread:${space.space}:`,
    `oauth:setup-space:${space.space}:`,
    `reindex-cursor:${space.space}`,
  ]);
  await env.ROUTING.delete(`ghtok:${installationId}`);
  await env.ROUTING.delete(`installation:inventory:${installationId}`);
  await env.ROUTING.delete(spaceInstKey(installationId));

  const raw = await env.ROUTING.get("spaces:registry");
  if (raw) {
    const reg = JSON.parse(raw) as Record<string, unknown>;
    delete reg[`${space.owner}/${space.repo}`];
    await env.ROUTING.put("spaces:registry", JSON.stringify(reg));
  }

  const productRaw = await env.ROUTING.get("product-repos:registry");
  if (productRaw) {
    const products = JSON.parse(productRaw) as Record<
      string,
      { space?: string }
    >;
    for (const [name, product] of Object.entries(products)) {
      if (product.space === space.space) delete products[name];
    }
    await env.ROUTING.put("product-repos:registry", JSON.stringify(products));
  }

  const deps = indexDeps(env);
  if (deps) await deps.db.deleteSpace(space.space);
  await env.ROUTING.delete(tombstoneKey);
  return { deactivated: true, space: space.space };
}

async function listKeys(env: Env, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.ROUTING.list({ prefix, limit: 1000, cursor });
    keys.push(...page.keys.map((key) => key.name));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

async function deletePrefixes(env: Env, prefixes: string[]): Promise<void> {
  for (const prefix of prefixes) {
    for (const key of await listKeys(env, prefix)) {
      await env.ROUTING.delete(key);
    }
  }
}

async function revokeUserGrants(env: Env, githubId: number): Promise<void> {
  if (!env.OAUTH_PROVIDER) return;
  let cursor: string | undefined;
  do {
    const page = await env.OAUTH_PROVIDER.listUserGrants(String(githubId), {
      limit: 1000,
      cursor,
    });
    for (const grant of page.items) {
      await env.OAUTH_PROVIDER.revokeGrant(grant.id, String(githubId));
    }
    cursor = page.cursor;
  } while (cursor);
}

function memberFromIdentity(
  space: Pick<
    SpaceRecord,
    "space" | "installationId" | "owner" | "repo" | "branch"
  >,
  user: GithubIdentity,
  role: "admin" | "member",
): SpaceMember {
  return {
    space: space.space,
    installationId: space.installationId,
    owner: space.owner,
    repo: space.repo,
    branch: space.branch,
    author: user.login,
    authorEmail: user.email?.trim() || githubNoreply(user.id, user.login),
    githubId: user.id,
    githubLogin: user.login,
    role,
  };
}

/**
 * Bind a GitHub user to an existing space through membership, an invitation,
 * or access to an active organization installation. New installations are
 * activated only by the cookie-bound repository-selection flow.
 */
export async function placeGithubUser(
  env: Env,
  user: GithubIdentity,
  installations: GithubInstallation[],
): Promise<PlaceResult> {
  const existing = await getMemberByGithubId(env, user.id);
  const invite = await getGithubInvite(env, user.login);
  if (existing) {
    if (invite && invite.space !== existing.space) {
      return { kind: "space_conflict", existingSpace: existing.space };
    }
    const claimedSpace = await membershipClaims(env).claimUser(
      user.id,
      existing.space,
    );
    if (claimedSpace !== existing.space) {
      return { kind: "space_conflict", existingSpace: claimedSpace };
    }
    return { kind: "member", member: existing };
  }

  if (invite) {
    const space = (await getSpaceByInstallation(
      env,
      invite.installationId,
    )) ?? {
      space: invite.space,
      installationId: invite.installationId,
      owner: invite.owner,
      repo: invite.repo,
      branch: invite.branch,
      plan: "pilot" as const,
      createdByGithubId: invite.invitedByGithubId,
      status: "active" as const,
    };
    const claimedSpace = await membershipClaims(env).claimUser(
      user.id,
      space.space,
    );
    if (claimedSpace !== space.space) {
      return { kind: "space_conflict", existingSpace: claimedSpace };
    }
    const member = memberFromIdentity(space, user, "member");
    await upsertGithubMember(env, member);
    await membershipClaims(env).releaseInvite(
      user.login.toLowerCase(),
      invite.space,
    );
    await env.ROUTING.delete(inviteGithubKey(user.login));
    await removeFromIndex(
      env,
      spaceInvitesKey(invite.space),
      user.login.toLowerCase(),
    );
    return { kind: "member", member };
  }

  for (const inst of installations) {
    const space = await getSpaceByInstallation(env, inst.id);
    if (space?.status === "active") {
      const isInstaller = space.createdByGithubId === user.id;
      const orgJoin =
        (inst.account.type ?? "").toLowerCase() === "organization";
      if (!isInstaller && !orgJoin) continue;
      const member = memberFromIdentity(
        space,
        user,
        isInstaller ? "admin" : "member",
      );
      const claimedSpace = await membershipClaims(env).claimUser(
        user.id,
        space.space,
      );
      if (claimedSpace !== space.space) {
        return { kind: "space_conflict", existingSpace: claimedSpace };
      }
      await upsertGithubMember(env, member);
      return { kind: "member", member };
    }
  }

  return { kind: "preview" };
}

export async function handleAdminAllowlist(
  req: Request,
  env: Env,
  ctx?: HandlerCtx,
): Promise<Response> {
  const denied = requireOperator(req, env, ctx);
  if (denied) return denied;
  if (req.method === "GET") {
    return Response.json({ allowlist: await getAllowlist(env) });
  }
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  let body: { add?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const names = Array.isArray(body.add)
    ? body.add.filter((n): n is string => typeof n === "string")
    : [];
  if (names.length === 0) {
    return Response.json({ error: "missing add" }, { status: 400 });
  }
  const allowlist = await addToAllowlist(env, names);
  return Response.json({ allowlist });
}
