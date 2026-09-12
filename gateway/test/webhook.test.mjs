import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import {
  verifyGithubSignature,
  handleWebhook,
} from "../dist/gateway/src/webhook.js";
import {
  registerSpaceRepo,
  handleAdminAddProductRepo,
} from "../dist/gateway/src/tenancy.js";
import { inviteGithubUser } from "../dist/gateway/src/spaces.js";
import { makeEnv, ghFetch, fakeEmbed, seedGithubMember } from "./helpers.mjs";

const SECRET = "hooksecret";
const sign = (body) =>
  "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

const entryMd =
  "---\nauthor: Skanda\ntype: decision\ntimestamp: 2026-07-08T00:00:00Z\nid: web1\nproject: memorylayer\n---\n\nwebhook-ingested decision\n";

function pushEnv(indexDb) {
  const calls = [];
  const env = makeEnv(
    ghFetch(calls, [
      [
        "/app/installations/",
        () =>
          Response.json({
            token: "ghs_test",
            expires_at: "2099-01-01T00:00:00Z",
          }),
      ],
      [
        "/contents/context/memorylayer/skanda/new.md",
        () => new Response(entryMd),
      ],
    ]),
    { WEBHOOK_SECRET: SECRET, indexDb, embedder: fakeEmbed },
  );
  return env;
}

function pushReq(payload, { badSig = false, event = "push" } = {}) {
  const body = JSON.stringify(payload);
  return new Request("https://gw/webhook/github", {
    method: "POST",
    headers: {
      "x-hub-signature-256": badSig ? "sha256=" + "0".repeat(64) : sign(body),
      "x-github-event": event,
    },
    body,
  });
}

const PAYLOAD = {
  ref: "refs/heads/main",
  after: "pushsha",
  repository: { full_name: "o/r" },
  commits: [
    { added: ["context/memorylayer/skanda/new.md"], modified: [], removed: [] },
  ],
};

test("verifyGithubSignature accepts a valid HMAC and rejects a forged one", async () => {
  const body = JSON.stringify(PAYLOAD);
  assert.equal(await verifyGithubSignature(SECRET, body, sign(body)), true);
  assert.equal(
    await verifyGithubSignature(SECRET, body, "sha256=" + "0".repeat(64)),
    false,
  );
  assert.equal(await verifyGithubSignature(SECRET, body, null), false);
});

test("push webhook ingests new ledger files for a registered repo", async () => {
  const db = new MemoryIndexDb();
  const env = pushEnv(db);
  await registerSpaceRepo(env, {
    space: "s1",
    installationId: 7,
    owner: "o",
    repo: "r",
    branch: "main",
  });
  const res = await handleWebhook(pushReq(PAYLOAD), env);
  assert.equal(res.status, 200);
  const docs = await db.listDocs("s1", "memorylayer");
  assert.equal(docs.length, 1);
  assert.equal(docs[0].body, "webhook-ingested decision");
  assert.equal(await db.getLastIndexedSha("s1"), "pushsha");
});

// --- merged-PR recorder (pull_request events from product repos) ---

const PR_PAYLOAD = {
  action: "closed",
  repository: { full_name: "acme/webapp" },
  pull_request: {
    merged: true,
    number: 12,
    title: "Ship feature",
    body: "Adds the feature.\n\nDetails here.",
    user: { login: "alice" },
    merged_by: { login: "bob" },
    head: { ref: "feat" },
    base: { ref: "main" },
  },
};

function prEnv() {
  const calls = [];
  const env = makeEnv(
    ghFetch(calls, [
      [
        "/app/installations/",
        () =>
          Response.json({
            token: "ghs_test",
            expires_at: "2099-01-01T00:00:00Z",
          }),
      ],
      ["/contents/context/webapp/github/", () => Response.json({ ok: true })],
    ]),
    { WEBHOOK_SECRET: SECRET },
  );
  return { env, calls };
}

async function mapProductRepo(env) {
  await registerSpaceRepo(env, {
    space: "s1",
    installationId: 7,
    owner: "o",
    repo: "ctx",
    branch: "main",
  });
  const res = await handleAdminAddProductRepo(
    new Request("https://gw/admin/product-repos", {
      method: "POST",
      body: JSON.stringify({
        owner: "acme",
        repo: "webapp",
        space: "s1",
        project: "webapp",
      }),
    }),
    env,
  );
  assert.equal(res.status, 200);
}

test("merged PR on a mapped product repo writes a bot summary entry to the space's context repo", async () => {
  const { env, calls } = prEnv();
  await mapProductRepo(env);
  const res = await handleWebhook(
    pushReq(PR_PAYLOAD, { event: "pull_request" }),
    env,
  );
  assert.equal(res.status, 200);
  const put = calls.find(
    (c) =>
      c.init.method === "PUT" &&
      c.url.includes("/repos/o/ctx/contents/context/webapp/github/"),
  );
  assert.ok(put, "expected a Contents PUT to the context repo");
  const committed = Buffer.from(
    JSON.parse(put.init.body).content,
    "base64",
  ).toString();
  assert.match(
    committed,
    /PR merged: Ship feature \(acme\/webapp#12\) \| author alice, merged by bob \| main←feat \| Adds the feature\./,
  );
  assert.match(committed, /type: context/);
  assert.match(committed, /author: GitHub/);
});

test("pull_request events that are not merges, or from unmapped repos, write nothing", async () => {
  const { env, calls } = prEnv();
  await mapProductRepo(env);
  const closedUnmerged = {
    ...PR_PAYLOAD,
    pull_request: { ...PR_PAYLOAD.pull_request, merged: false },
  };
  assert.equal(
    (
      await handleWebhook(
        pushReq(closedUnmerged, { event: "pull_request" }),
        env,
      )
    ).status,
    200,
  );
  const unmapped = { ...PR_PAYLOAD, repository: { full_name: "acme/other" } };
  assert.equal(
    (await handleWebhook(pushReq(unmapped, { event: "pull_request" }), env))
      .status,
    200,
  );
  assert.equal(
    calls.filter((c) => c.init.method === "PUT").length,
    0,
    "no writes for ignored events",
  );
});

test("admin product-repos endpoint is operator-gated and validates required fields", async () => {
  const { env } = prEnv();
  const post = (body, callerEnv = env) =>
    handleAdminAddProductRepo(
      new Request("https://gw/admin/product-repos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      callerEnv,
    );
  assert.equal(
    (
      await post(
        { owner: "a", repo: "b", space: "s", project: "p" },
        { ...env, oauthProps: { githubId: 9999, githubLogin: "outsider" } },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await post({ owner: "a", repo: "b", space: "s" })
    ).status,
    400,
  );
});

test("webhook rejects bad signatures; ignores non-push, unknown repos, other branches", async () => {
  const db = new MemoryIndexDb();
  const env = pushEnv(db);
  await registerSpaceRepo(env, {
    space: "s1",
    installationId: 7,
    owner: "o",
    repo: "r",
    branch: "main",
  });
  assert.equal(
    (await handleWebhook(pushReq(PAYLOAD, { badSig: true }), env)).status,
    401,
  );
  assert.equal(
    (await handleWebhook(pushReq(PAYLOAD, { event: "ping" }), env)).status,
    200,
  );
  const other = { ...PAYLOAD, repository: { full_name: "o/unknown" } };
  assert.equal((await handleWebhook(pushReq(other), env)).status, 200);
  const branch = { ...PAYLOAD, ref: "refs/heads/dev" };
  assert.equal((await handleWebhook(pushReq(branch), env)).status, 200);
  assert.deepEqual(await db.listDocs("s1"), []); // none of those ingested
});

async function lifecycleEnv() {
  const indexDb = new MemoryIndexDb();
  const revoked = [];
  const env = makeEnv(undefined, {
    WEBHOOK_SECRET: SECRET,
    indexDb,
    OAUTH_PROVIDER: {
      async listUserGrants(userId) {
        return { items: [{ id: `grant-${userId}` }] };
      },
      async revokeGrant(grantId, userId) {
        revoked.push(`${grantId}:${userId}`);
      },
    },
  });
  const admin = await seedGithubMember(env, {
    space: "team-a",
    installationId: 7,
    owner: "acme",
    repo: "memory",
    author: "ada",
    authorEmail: "a@x.io",
    githubId: 1,
    githubLogin: "ada",
    role: "admin",
  });
  await seedGithubMember(env, {
    ...admin,
    author: "bo",
    authorEmail: "b@x.io",
    githubId: 2,
    githubLogin: "bo",
    role: "member",
  });
  await inviteGithubUser(env, admin, "casey");
  await env.ROUTING.put(
    "member:github:3",
    JSON.stringify({
      ...admin,
      githubId: 3,
      githubLogin: "legacy",
      author: "legacy",
      role: "member",
    }),
  );
  await env.ROUTING.put("github:login:legacy", "3");
  await env.ROUTING.put(
    "invite:github:legacy-invite",
    JSON.stringify({
      space: "team-a",
      installationId: 7,
      owner: "acme",
      repo: "memory",
      branch: "main",
      invitedByGithubId: 1,
      invitedAt: Date.now(),
    }),
  );
  await env.ROUTING.put("recency:team-a:product", "cached");
  await env.ROUTING.put("hookread:team-a:product", "cached");
  await env.ROUTING.put("oauth:setup-space:team-a:pending", "cached");
  await env.ROUTING.put("reindex-cursor:team-a", "cached");
  await env.ROUTING.put("ghtok:7", "installation-access");
  await env.ROUTING.put(
    "product-repos:registry",
    JSON.stringify({
      "acme/product": { space: "team-a", project: "product" },
      "other/product": { space: "team-b", project: "product" },
    }),
  );
  await indexDb.replaceBySource("team-a", "source", [
    {
      id: "fact",
      space: "team-a",
      project: "product",
      kind: "decision",
      tier: "normal",
      body: "derived fact",
      sourceFile: "f",
      sourceAuthor: "ada",
      sourceTs: "2026-08-22T00:00:00Z",
      embedding: [],
      supersededBy: null,
      createdAt: "2026-08-22T00:00:00Z",
      sourceId: "source",
      entities: [],
    },
  ]);
  return { env, indexDb, revoked };
}

test("installation deletion removes every derived access record", async () => {
  const { env, indexDb, revoked } = await lifecycleEnv();
  const payload = {
    action: "deleted",
    installation: { id: 7 },
  };
  const res = await handleWebhook(
    pushReq(payload, { event: "installation" }),
    env,
  );
  assert.equal(res.status, 200);
  for (const key of [
    "space:inst:7",
    "member:github:1",
    "member:github:2",
    "member:github:3",
    "github:login:ada",
    "github:login:bo",
    "github:login:legacy",
    "invite:github:casey",
    "invite:github:legacy-invite",
    "space:members:team-a",
    "space:invites:team-a",
    "recency:team-a:product",
    "hookread:team-a:product",
    "oauth:setup-space:team-a:pending",
    "reindex-cursor:team-a",
    "ghtok:7",
  ]) {
    assert.equal(await env.ROUTING.get(key), null, key);
  }
  assert.deepEqual(await indexDb.listDocs("team-a"), []);
  assert.deepEqual(revoked.sort(), ["grant-1:1", "grant-2:2", "grant-3:3"]);
  const spaces = JSON.parse(await env.ROUTING.get("spaces:registry"));
  assert.equal(spaces["acme/memory"], undefined);
  const products = JSON.parse(await env.ROUTING.get("product-repos:registry"));
  assert.equal(products["acme/product"], undefined);
  assert.deepEqual(products["other/product"], {
    space: "team-b",
    project: "product",
  });
});

test("failed grant revocation leaves a retryable deactivation tombstone", async () => {
  const { env } = await lifecycleEnv();
  env.OAUTH_PROVIDER.revokeGrant = async () => {
    throw new Error("provider unavailable");
  };
  const payload = { action: "deleted", installation: { id: 7 } };
  await assert.rejects(
    handleWebhook(pushReq(payload, { event: "installation" }), env),
    /provider unavailable/,
  );
  assert.equal(await env.ROUTING.get("member:github:1"), null);
  assert.ok(await env.ROUTING.get("space:inst:7"));
  assert.ok(await env.ROUTING.get("deactivation:inst:7"));

  env.OAUTH_PROVIDER.revokeGrant = async () => {};
  const retry = await handleWebhook(
    pushReq(payload, { event: "installation" }),
    env,
  );
  assert.equal(retry.status, 200);
  assert.equal(await env.ROUTING.get("space:inst:7"), null);
  assert.equal(await env.ROUTING.get("deactivation:inst:7"), null);
});

test("suspension and selected repository removal deactivate the space", async () => {
  for (const [event, payload] of [
    ["installation", { action: "suspend", installation: { id: 7 } }],
    [
      "installation_repositories",
      {
        action: "removed",
        installation: { id: 7 },
        repositories_removed: [{ name: "memory", full_name: "acme/memory" }],
      },
    ],
  ]) {
    const { env } = await lifecycleEnv();
    const res = await handleWebhook(pushReq(payload, { event }), env);
    assert.equal(res.status, 200);
    assert.equal(await env.ROUTING.get("space:inst:7"), null, event);
    assert.equal(await env.ROUTING.get("member:github:1"), null, event);
  }
});
