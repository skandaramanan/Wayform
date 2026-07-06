import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import { resolveMember, newToken } from "../dist/gateway/src/tenancy.js";
import { makeEnv } from "./helpers.mjs";

const MEMBER = {
  space: "team-a",
  installationId: 777,
  owner: "acme",
  repo: "team-a-memory",
  author: "Ada",
  authorEmail: "ada@acme.io",
};

async function addMember(env, body = MEMBER, secret = "test-admin-secret") {
  return handleRequest(
    new Request("https://gw.test/admin/members", {
      method: "POST",
      headers: { "x-admin-secret": secret, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

test("admin mint: returns a token once; token resolves to the member; branch defaults to main", async () => {
  const env = makeEnv();
  const res = await addMember(env);
  assert.equal(res.status, 200);
  const { token, member } = await res.json();
  assert.match(token, /^mlk_/);
  assert.equal(member.branch, "main");

  const resolved = await resolveMember(
    new Request("https://gw.test/mcp", {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(resolved.space, "team-a");
  assert.equal(resolved.author, "Ada");

  // the raw token never lands in KV — only its hash key exists
  for (const key of env.ROUTING.map.keys()) {
    assert.ok(!key.includes(token), "raw token must not appear in any KV key");
  }
});

test("admin mint rejects a wrong secret and missing fields", async () => {
  const env = makeEnv();
  assert.equal((await addMember(env, MEMBER, "wrong")).status, 403);
  const { space: _drop, ...incomplete } = MEMBER;
  assert.equal((await addMember(env, incomplete)).status, 400);
});

test("resolveMember: absent/garbage/unknown bearer all resolve to null", async () => {
  const env = makeEnv();
  const mk = (headers) => new Request("https://gw.test/mcp", { headers });
  assert.equal(await resolveMember(mk({}), env), null);
  assert.equal(
    await resolveMember(mk({ authorization: "Basic abc" }), env),
    null,
  );
  assert.equal(
    await resolveMember(mk({ authorization: `Bearer ${newToken()}` }), env),
    null,
  );
});

test("two members in different spaces resolve to their own records", async () => {
  const env = makeEnv();
  const a = await (await addMember(env)).json();
  const b = await (
    await addMember(env, {
      ...MEMBER,
      space: "team-b",
      owner: "acme",
      repo: "team-b-memory",
      installationId: 888,
      author: "Bo",
    })
  ).json();
  const resolve = async (tok) =>
    resolveMember(
      new Request("https://gw.test/mcp", {
        headers: { authorization: `Bearer ${tok}` },
      }),
      env,
    );
  assert.equal((await resolve(a.token)).repo, "team-a-memory");
  assert.equal((await resolve(b.token)).repo, "team-b-memory");
});
