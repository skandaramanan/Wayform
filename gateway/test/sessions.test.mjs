import { test } from "node:test";
import assert from "node:assert/strict";
import { listSessions, revokeSession } from "../dist/gateway/src/sessions.js";

const MEMBER = { space: "team-a", githubId: 101, githubLogin: "ada" };

function grant(id, clientId, createdAt = 1_780_000_000) {
  return {
    id,
    clientId,
    userId: "101",
    scope: ["mcp"],
    metadata: {},
    createdAt,
  };
}

/** Minimal OAuthHelpers surface these two functions actually touch. */
function provider({ grants = [], revoke, currentGrantId = null } = {}) {
  return {
    revoked: [],
    async listUserGrants() {
      return { items: grants };
    },
    async lookupClient(clientId) {
      return { clientName: clientId === "cli-1" ? "wayform-cli" : null };
    },
    async unwrapToken() {
      return currentGrantId ? { grantId: currentGrantId } : null;
    },
    async revokeGrant(id, userId) {
      if (revoke) return revoke(id, userId);
      this.revoked.push({ id, userId });
    },
  };
}

const req = (token = "tok") =>
  new Request("https://gw.test/mcp", {
    headers: { authorization: `Bearer ${token}` },
  });

test("listing with no grants is a clean empty answer, not an error", async () => {
  const out = await listSessions({ OAUTH_PROVIDER: provider() }, MEMBER, req());
  assert.equal(out.isError, false);
  assert.match(out.text, /No active sessions/);
});

test("listing names the client and marks the session you are using", async () => {
  const env = {
    OAUTH_PROVIDER: provider({
      grants: [grant("g1", "cli-1"), grant("g2", "cli-2")],
      currentGrantId: "g2",
    }),
  };
  const out = await listSessions(env, MEMBER, req());
  assert.equal(out.isError, false);
  assert.match(out.text, /wayform-cli/);
  assert.match(out.text, /g1/);
  // Without this marker a user cannot tell which session they are about to cut.
  assert.match(out.text, /\(this session\)/);
});

test("revoking someone else's session id is refused and revokes nothing", async () => {
  const p = provider({ grants: [grant("mine", "cli-1")] });
  const out = await revokeSession(
    { OAUTH_PROVIDER: p },
    MEMBER,
    req(),
    "theirs",
  );
  assert.equal(out.isError, true);
  assert.match(out.text, /nothing was revoked/);
  assert.equal(p.revoked.length, 0);
});

test("a successful revoke reports the id it revoked", async () => {
  const p = provider({ grants: [grant("g1", "cli-1")] });
  const out = await revokeSession({ OAUTH_PROVIDER: p }, MEMBER, req(), "g1");
  assert.equal(out.isError, false);
  assert.match(out.text, /Revoked session g1/);
  assert.deepEqual(p.revoked, [{ id: "g1", userId: "101" }]);
});

test("revoking your own current session warns that this client is cut off", async () => {
  const p = provider({ grants: [grant("g1", "cli-1")], currentGrantId: "g1" });
  const out = await revokeSession({ OAUTH_PROVIDER: p }, MEMBER, req(), "g1");
  assert.equal(out.isError, false);
  assert.match(out.text, /this session/i);
});

test("a failing revoke is a HARD error, never a false success", async () => {
  // Recorded preference (2026-07-09): revocation must be a hard error if not
  // possible, not a silent failure. Telling someone a session is gone when it
  // is still live is the one outcome this must never produce.
  const p = provider({
    grants: [grant("g1", "cli-1")],
    revoke: () => {
      throw new Error("KV write failed");
    },
  });
  const out = await revokeSession({ OAUTH_PROVIDER: p }, MEMBER, req(), "g1");
  assert.equal(out.isError, true);
  assert.match(out.text, /may still be active/);
  assert.equal(out.text.includes("KV write failed"), false);
});

test("a missing OAuth provider is an error on both tools, not an empty list", async () => {
  const list = await listSessions({}, MEMBER, req());
  assert.equal(list.isError, true);
  const revoked = await revokeSession({}, MEMBER, req(), "g1");
  assert.equal(revoked.isError, true);
  assert.match(revoked.text, /nothing was revoked/);
});

test("a member with no GitHub identity cannot list or revoke", async () => {
  const env = { OAUTH_PROVIDER: provider({ grants: [grant("g1", "cli-1")] }) };
  const anon = { space: "team-a" };
  assert.equal((await listSessions(env, anon, req())).isError, true);
  assert.equal((await revokeSession(env, anon, req(), "g1")).isError, true);
});

test("a blank session id is refused before any provider call", async () => {
  const p = provider({ grants: [grant("g1", "cli-1")] });
  const out = await revokeSession({ OAUTH_PROVIDER: p }, MEMBER, req(), "   ");
  assert.equal(out.isError, true);
  assert.match(out.text, /session_id/);
  assert.equal(p.revoked.length, 0);
});
