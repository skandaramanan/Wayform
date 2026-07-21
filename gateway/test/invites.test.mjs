import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleAdminCreateInvite,
  handleJoin,
  INVITE_MAX_USES,
} from "../dist/gateway/src/invites.js";
import { resolveMember, sha256Hex } from "../dist/gateway/src/tenancy.js";
import { makeEnv } from "./helpers.mjs";

const INVITE_BODY = {
  space: "team-a",
  owner: "acme",
  repo: "team-a-memory",
  installationId: 777,
};

function post(url, body, headers = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function createInvite(
  env,
  body = INVITE_BODY,
  secret = "test-admin-secret",
) {
  return handleAdminCreateInvite(
    post("https://gw.test/admin/invites", body, { "x-admin-secret": secret }),
    env,
  );
}

async function join(env, body) {
  return handleJoin(post("https://gw.test/join", body), env);
}

test("admin invite mint: returns a wfi_ code once; only the hash lands in KV", async () => {
  const env = makeEnv();
  const res = await createInvite(env);
  assert.equal(res.status, 200);
  const { invite, usesLeft } = await res.json();
  assert.match(invite, /^wfi_/);
  assert.equal(usesLeft, INVITE_MAX_USES);
  for (const key of env.ROUTING.map.keys()) {
    assert.ok(
      !key.includes(invite),
      "raw invite code must not appear in KV keys",
    );
  }
});

test("admin invite mint rejects wrong secret and missing fields", async () => {
  const env = makeEnv();
  assert.equal((await createInvite(env, INVITE_BODY, "wrong")).status, 403);
  const { space: _drop, ...incomplete } = INVITE_BODY;
  assert.equal((await createInvite(env, incomplete)).status, 400);
});

test("join: mints a working member token and decrements usesLeft", async () => {
  const env = makeEnv();
  const { invite } = await (await createInvite(env)).json();
  const res = await join(env, {
    invite,
    author: "David",
    authorEmail: "d@spear.ai",
  });
  assert.equal(res.status, 200);
  const { token, member } = await res.json();
  assert.match(token, /^mlk_/);
  assert.equal(member.space, "team-a");
  assert.equal(member.branch, "main");
  assert.equal(member.author, "David");

  const resolved = await resolveMember(
    new Request("https://gw.test/mcp", {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(resolved.space, "team-a");

  const record = JSON.parse(
    await env.ROUTING.get(`invite:${await sha256Hex(invite)}`),
  );
  assert.equal(record.usesLeft, INVITE_MAX_USES - 1);
});

test("join: unknown, expired, and exhausted invites all fail with the same generic 400", async () => {
  const env = makeEnv();
  const who = { author: "Eve", authorEmail: "e@x.io" };

  const unknown = await join(env, { invite: "wfi_nope", ...who });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error, "invalid or expired invite");

  const { invite } = await (await createInvite(env)).json();
  const key = `invite:${await sha256Hex(invite)}`;

  const live = JSON.parse(await env.ROUTING.get(key));
  await env.ROUTING.put(
    key,
    JSON.stringify({ ...live, expiresAt: Date.now() - 1 }),
  );
  const expired = await join(env, { invite, ...who });
  assert.equal(expired.status, 400);
  assert.equal((await expired.json()).error, "invalid or expired invite");

  await env.ROUTING.put(key, JSON.stringify({ ...live, usesLeft: 0 }));
  const exhausted = await join(env, { invite, ...who });
  assert.equal(exhausted.status, 400);
  assert.equal((await exhausted.json()).error, "invalid or expired invite");
});

test("join: missing author/email is a distinct 400 (caller bug, not invite probing)", async () => {
  const env = makeEnv();
  const { invite } = await (await createInvite(env)).json();
  const res = await join(env, { invite, author: "NoEmail" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /missing/);
});
