import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import {
  verifyGithubSignature,
  handleWebhook,
} from "../dist/gateway/src/webhook.js";
import { registerSpaceRepo } from "../dist/gateway/src/tenancy.js";
import { makeEnv, ghFetch, fakeEmbed } from "./helpers.mjs";

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
