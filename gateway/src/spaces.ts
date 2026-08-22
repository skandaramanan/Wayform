import type { Env } from "./env.js";
import { registerSpaceRepo, type SpaceMember } from "./tenancy.js";

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
  await env.ROUTING.put(memberGithubKey(member.githubId), JSON.stringify(member));
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
  login: string,
  invite: Omit<GithubInvite, "invitedAt">,
): Promise<GithubInvite> {
  const record: GithubInvite = { ...invite, invitedAt: Date.now() };
  await env.ROUTING.put(inviteGithubKey(login), JSON.stringify(record));
  return record;
}

export async function revokeGithubUser(
  env: Env,
  login: string,
): Promise<void> {
  const invite = await getGithubInvite(env, login);
  if (invite) await env.ROUTING.delete(inviteGithubKey(login));
  const idRaw = await env.ROUTING.get(loginIndexKey(login));
  if (idRaw) {
    await env.ROUTING.delete(memberGithubKey(Number(idRaw)));
    await env.ROUTING.delete(loginIndexKey(login));
  }
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
): Promise<"active" | "preview"> {
  const existing = await getSpaceByInstallation(env, input.installationId);
  if (existing?.status === "active") return "active";
  if (!(await isAllowlisted(env, input.owner))) return "preview";

  const branch = input.branch ?? "main";
  const space: SpaceRecord = {
    space: spaceNameFor(input.owner, input.repo),
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
  await upsertGithubMember(env, memberFromIdentity(space, {
    id: input.actorGithubId,
    login: input.actorLogin,
  }, "admin"));
  return "active";
}

export async function deactivateInstallation(
  env: Env,
  installationId: number,
): Promise<void> {
  const space = await getSpaceByInstallation(env, installationId);
  if (!space) return;
  await env.ROUTING.delete(spaceInstKey(installationId));
  const raw = await env.ROUTING.get("spaces:registry");
  if (!raw) return;
  const reg = JSON.parse(raw) as Record<string, unknown>;
  delete reg[`${space.owner}/${space.repo}`];
  await env.ROUTING.put("spaces:registry", JSON.stringify(reg));
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

export type RepoLookup = (
  installationId: number,
) => Promise<{ owner: string; repo: string }[]>;

/**
 * Bind a GitHub user to a space: existing membership, username invite,
 * org/installation access, or first-time allowlisted install.
 */
export async function placeGithubUser(
  env: Env,
  user: GithubIdentity,
  installations: GithubInstallation[],
  reposFor?: RepoLookup,
): Promise<PlaceResult> {
  const existing = await getMemberByGithubId(env, user.id);
  if (existing) return { kind: "member", member: existing };

  const invite = await getGithubInvite(env, user.login);
  if (invite) {
    const space =
      (await getSpaceByInstallation(env, invite.installationId)) ?? {
        space: invite.space,
        installationId: invite.installationId,
        owner: invite.owner,
        repo: invite.repo,
        branch: invite.branch,
        plan: "pilot" as const,
        createdByGithubId: invite.invitedByGithubId,
        status: "active" as const,
      };
    const member = memberFromIdentity(space, user, "member");
    await upsertGithubMember(env, member);
    await env.ROUTING.delete(inviteGithubKey(user.login));
    return { kind: "member", member };
  }

  for (const inst of installations) {
    const space = await getSpaceByInstallation(env, inst.id);
    if (space?.status === "active") {
      const isInstaller = space.createdByGithubId === user.id;
      const orgJoin = (inst.account.type ?? "").toLowerCase() === "organization";
      if (!isInstaller && !orgJoin) continue;
      const member = memberFromIdentity(
        space,
        user,
        isInstaller ? "admin" : "member",
      );
      await upsertGithubMember(env, member);
      return { kind: "member", member };
    }
  }

  for (const inst of installations) {
    const repos = reposFor ? await reposFor(inst.id) : [];
    const repo = repos[0];
    if (!repo) continue;
    const result = await activateInstallation(env, {
      installationId: inst.id,
      owner: repo.owner,
      repo: repo.repo,
      actorGithubId: user.id,
      actorLogin: user.login,
    });
    if (result === "active") {
      const member = await getMemberByGithubId(env, user.id);
      if (member) return { kind: "member", member };
    }
  }

  return { kind: "preview" };
}

export async function handleAdminAllowlist(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
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
