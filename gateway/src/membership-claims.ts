import type { Env, MembershipClaimStore } from "./env.js";

export function membershipClaims(env: Env): MembershipClaimStore {
  if (env.membershipClaims) return env.membershipClaims;
  if (!env.DB) {
    throw new Error("D1 membership claims are not configured");
  }
  const db = env.DB;
  return {
    async claimUser(githubId, space) {
      await db
        .prepare(
          "INSERT OR IGNORE INTO membership_claims (github_id, space) VALUES (?, ?)",
        )
        .bind(githubId, space)
        .run();
      const row = await db
        .prepare("SELECT space FROM membership_claims WHERE github_id = ?")
        .bind(githubId)
        .first();
      if (typeof row?.space !== "string") {
        throw new Error("failed to claim GitHub identity");
      }
      return row.space;
    },
    async releaseUser(githubId, space) {
      await db
        .prepare(
          "DELETE FROM membership_claims WHERE github_id = ? AND space = ?",
        )
        .bind(githubId, space)
        .run();
    },
    async claimInvite(login, space) {
      await db
        .prepare(
          "INSERT OR IGNORE INTO invite_claims (github_login, space) VALUES (?, ?)",
        )
        .bind(login, space)
        .run();
      const row = await db
        .prepare("SELECT space FROM invite_claims WHERE github_login = ?")
        .bind(login)
        .first();
      if (typeof row?.space !== "string") {
        throw new Error("failed to claim GitHub invitation");
      }
      return row.space;
    },
    async releaseInvite(login, space) {
      await db
        .prepare(
          "DELETE FROM invite_claims WHERE github_login = ? AND space = ?",
        )
        .bind(login, space)
        .run();
    },
  };
}
