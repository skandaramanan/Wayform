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
  await inviteGithubUser(env, "dberquist", {
    space: "team-a",
    installationId: 777,
    owner: "acme",
    repo: "team-a-memory",
    branch: "main",
    invitedByGithubId: 101,
  });
  const invite = await getGithubInvite(env, "dberquist");
  assert.equal(invite.space, "team-a");
  assert.ok(env.ROUTING.map.has("invite:github:dberquist"));
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
      body: JSON.stringify({ invite: "wfi_nope", author: "A", authorEmail: "a@x.io" }),
    }),
    env,
  );
  assert.equal(join.status, 404);
  const admin = await handleRequest(
    new Request("https://gw.test/admin/invites", {
      method: "POST",
      headers: {
        "x-admin-secret": "test-admin-secret",
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
  await inviteGithubUser(env, "casey", {
    space: "team-a",
    installationId: 777,
    owner: "acme",
    repo: "mem",
    branch: "main",
    invitedByGithubId: 1,
  });
  await revokeGithubUser(env, "bo");
  await revokeGithubUser(env, "casey");
  assert.equal(await env.ROUTING.get("member:github:2"), null);
  assert.equal(await getGithubInvite(env, "casey"), null);
});
