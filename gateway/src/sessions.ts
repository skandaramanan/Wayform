/**
 * Self-serve session management: a member can see every client connected to
 * their account and disconnect any of them, without an operator.
 *
 * Exposed as MCP tools rather than a web page on purpose — the member is
 * already authenticated on the MCP connection, so this adds no new browser
 * auth surface (no login session, no cookie, no second place to get wrong).
 *
 * HARD ERRORS, never silent success (recorded preference, 2026-07-09:
 * "revocation should be a hard error if not possible, not silently fail").
 * Every path that cannot prove the revocation happened returns isError — the
 * one unacceptable outcome is telling someone a session is gone when it isn't.
 */
import type { Env } from "./env.js";
import type { SpaceMember } from "./tenancy.js";

export interface SessionsResult {
  text: string;
  isError: boolean;
}

/** The OAuth grant userId is the member's GitHub id (see completeAuthorization). */
function userId(member: SpaceMember): string | null {
  return member.githubId == null ? null : String(member.githubId);
}

/** Grant id backing the token this very request arrived on, when resolvable. */
async function currentGrantId(env: Env, req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token || !env.OAUTH_PROVIDER) return null;
  try {
    const summary = await env.OAUTH_PROVIDER.unwrapToken(token);
    return summary?.grantId ?? null;
  } catch {
    // Only used to annotate output; failing to resolve it is not an error.
    return null;
  }
}

function describe(
  grant: {
    id: string;
    clientId: string;
    createdAt: number;
    metadata?: unknown;
  },
  clientName: string | undefined,
  isCurrent: boolean,
): string {
  const when = new Date(grant.createdAt * 1000).toISOString().slice(0, 10);
  const name = clientName?.trim() || grant.clientId;
  return `- ${name} — connected ${when}${isCurrent ? " (this session)" : ""}\n  id: ${grant.id}`;
}

export async function listSessions(
  env: Env,
  member: SpaceMember,
  req: Request,
): Promise<SessionsResult> {
  const uid = userId(member);
  if (!uid) {
    return {
      text: "cannot list sessions: this connection has no GitHub identity attached",
      isError: true,
    };
  }
  if (!env.OAUTH_PROVIDER) {
    return {
      text: "cannot list sessions: the OAuth provider is unavailable on this gateway",
      isError: true,
    };
  }
  try {
    const { items } = await env.OAUTH_PROVIDER.listUserGrants(uid);
    if (items.length === 0) {
      return { text: "No active sessions for your account.", isError: false };
    }
    const current = await currentGrantId(env, req);
    const lines = await Promise.all(
      items.map(async (grant) => {
        let clientName: string | undefined;
        try {
          const client = await env.OAUTH_PROVIDER!.lookupClient(grant.clientId);
          clientName = client?.clientName ?? undefined;
        } catch {
          // Fall back to the raw client id in describe().
        }
        return describe(grant, clientName, grant.id === current);
      }),
    );
    return {
      text:
        `${items.length} active session${items.length === 1 ? "" : "s"} for your account:\n\n` +
        lines.join("\n") +
        `\n\nDisconnect one with revoke_session(session_id).`,
      isError: false,
    };
  } catch {
    return {
      text: "could not read your sessions right now (nothing was changed)",
      isError: true,
    };
  }
}

export async function revokeSession(
  env: Env,
  member: SpaceMember,
  req: Request,
  sessionId: string,
): Promise<SessionsResult> {
  const uid = userId(member);
  if (!uid) {
    return {
      text: "cannot revoke: this connection has no GitHub identity attached",
      isError: true,
    };
  }
  if (!env.OAUTH_PROVIDER) {
    return {
      text: "cannot revoke: the OAuth provider is unavailable on this gateway (nothing was revoked)",
      isError: true,
    };
  }
  const id = sessionId.trim();
  if (!id) {
    return { text: "missing required argument: session_id", isError: true };
  }
  try {
    // Ownership check before the call, so one member can never revoke another's
    // session by guessing an id. revokeGrant takes userId too, but failing
    // closed here keeps the error message honest about what happened.
    const { items } = await env.OAUTH_PROVIDER.listUserGrants(uid);
    if (!items.some((grant) => grant.id === id)) {
      return {
        text: `no session ${id} on your account (nothing was revoked)`,
        isError: true,
      };
    }
    const current = await currentGrantId(env, req);
    await env.OAUTH_PROVIDER.revokeGrant(id, uid);
    return {
      text:
        `Revoked session ${id}.` +
        (id === current
          ? " That was this session — this client will need to sign in again."
          : ""),
      isError: false,
    };
  } catch {
    return {
      text: `could not revoke session ${id} — it may still be active. Try again, or contact your space admin.`,
      isError: true,
    };
  }
}
