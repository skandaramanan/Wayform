import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import {
  inviteGithubUser,
  getGithubInvite,
  revokeGithubUser,
} from "../dist/gateway/src/spaces.js";
import { makeEnv, seedGithubMember } from "./helpers.mjs";

test("in-agent GitHub-username invite is stored by login, not as a wfi_ secret", async () => {
  const env = makeEnv();
  const admin = await seedGithubMember(env, {
    space: "team-a",
    installationId: 777,
    owner: "acme",
    repo: "team-a-memory",
    branch: "main",
    author: "ada",
    authorEmail: "a@x.io",
    githubId: 101,
    githubLogin: "ada",
    role: "admin",
  });
  await inviteGithubUser(env, admin, "dberquist");
  const invite = await getGithubInvite(env, "dberquist");
  assert.equal(invite.space, "team-a");
  assert.ok(env.ROUTING.map.has("invite:github:dberquist"));
  assert.deepEqual(JSON.parse(await env.ROUTING.get("space:invites:team-a")), [
    "dberquist",
  ]);
  for (const key of env.ROUTING.map.keys()) {
    assert.doesNotMatch(key, /^invite:[0-9a-f]{64}$/);
  }
});

test("POST /join and POST /admin/invites are retired", async () => {
  const env = makeEnv();
  const join = await handleRequest(
    new Request("https://gw.test/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invite: "wfi_nope",
        author: "A",
        authorEmail: "a@x.io",
      }),
    }),
    env,
  );
  assert.equal(join.status, 404);
  const admin = await handleRequest(
    new Request("https://gw.test/admin/invites", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{}",
    }),
    env,
  );
  assert.equal(admin.status, 404);
});

test("revoke drops both a pending invite and a live github member", async () => {
  const env = makeEnv();
  const admin = await seedGithubMember(env, {
    space: "team-a",
    installationId: 777,
    owner: "acme",
    repo: "mem",
    author: "ada",
    authorEmail: "a@x.io",
    githubId: 1,
    githubLogin: "ada",
    role: "admin",
  });
  await seedGithubMember(env, {
    space: "team-a",
    installationId: 777,
    owner: "acme",
    repo: "mem",
    author: "bo",
    authorEmail: "b@x.io",
    githubId: 2,
    githubLogin: "bo",
    role: "member",
  });
  await inviteGithubUser(env, admin, "casey");
  assert.equal(await revokeGithubUser(env, admin, "bo"), "revoked");
  assert.equal(await revokeGithubUser(env, admin, "casey"), "revoked");
  assert.equal(await env.ROUTING.get("member:github:2"), null);
  assert.equal(await getGithubInvite(env, "casey"), null);
  assert.deepEqual(
    JSON.parse(await env.ROUTING.get("space:members:team-a")),
    [1],
  );
  assert.equal(await env.ROUTING.get("space:invites:team-a"), null);
});

test("admins cannot overwrite invitations or revoke members in another space", async () => {
  const env = makeEnv();
  const adminA = await seedGithubMember(env, {
    space: "team-a",
    installationId: 1,
    owner: "acme",
    repo: "a-memory",
    author: "ada",
    authorEmail: "a@x.io",
    githubId: 1,
    githubLogin: "ada",
    role: "admin",
  });
  const adminB = await seedGithubMember(env, {
    space: "team-b",
    installationId: 2,
    owner: "beta",
    repo: "b-memory",
    author: "bea",
    authorEmail: "b@x.io",
    githubId: 2,
    githubLogin: "bea",
    role: "admin",
  });
  await seedGithubMember(env, {
    ...adminB,
    author: "casey",
    authorEmail: "c@x.io",
    githubId: 3,
    githubLogin: "casey",
    role: "member",
  });
  await inviteGithubUser(env, adminB, "devon");

  await assert.rejects(
    inviteGithubUser(env, adminA, "devon"),
    /another Wayform space/,
  );
  assert.equal((await getGithubInvite(env, "devon")).space, "team-b");
  assert.equal(await revokeGithubUser(env, adminA, "casey"), "not_found");
  assert.notEqual(await env.ROUTING.get("member:github:3"), null);
});

test("concurrent cross-space invitations have one strongly consistent winner", async () => {
  const env = makeEnv();
  const adminA = await seedGithubMember(env, {
    space: "team-a",
    installationId: 1,
    owner: "acme",
    repo: "a-memory",
    author: "ada",
    authorEmail: "a@x.io",
    githubId: 1,
    githubLogin: "ada",
    role: "admin",
  });
  const adminB = await seedGithubMember(env, {
    space: "team-b",
    installationId: 2,
    owner: "beta",
    repo: "b-memory",
    author: "bea",
    authorEmail: "b@x.io",
    githubId: 2,
    githubLogin: "bea",
    role: "admin",
  });
  const results = await Promise.allSettled([
    inviteGithubUser(env, adminA, "casey"),
    inviteGithubUser(env, adminB, "casey"),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
  );
  assert.ok(
    ["team-a", "team-b"].includes((await getGithubInvite(env, "casey")).space),
  );
});
