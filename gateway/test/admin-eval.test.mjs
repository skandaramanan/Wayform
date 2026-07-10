import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import { makeEnv, ghFetch } from "./helpers.mjs";

function env(db) {
  return makeEnv(ghFetch([], []), { indexDb: db });
}

test("POST /admin/golden-candidate records a candidate with the admin secret", async () => {
  const db = new MemoryIndexDb();
  const res = await handleRequest(
    new Request("https://gw.test/admin/golden-candidate", {
      method: "POST",
      headers: { "x-admin-secret": "test-admin-secret", "content-type": "application/json" },
      body: JSON.stringify({ space: "s1", project: "memorylayer", query: "cursor scoping", expectedFactId: "cursor-fact", note: "live miss" }),
    }),
    env(db),
  );
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
  assert.equal(db.goldenCandidates.length, 1);
});

test("POST /admin/golden-candidate is forbidden without the secret", async () => {
  const res = await handleRequest(
    new Request("https://gw.test/admin/golden-candidate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ space: "s1", query: "q", expectedFactId: "f1" }),
    }),
    env(new MemoryIndexDb()),
  );
  assert.equal(res.status, 403);
});

test("GET /admin/retrieval-log returns rows since a timestamp", async () => {
  const db = new MemoryIndexDb();
  await db.logRetrieval({
    space: "s1", project: "memorylayer", trigger: "hook_prompt", query: "q",
    returned: [{ id: "f1", score: 0.03 }], injected: true, ts: "2026-07-10T00:00:00Z",
  });
  const res = await handleRequest(
    new Request("https://gw.test/admin/retrieval-log?space=s1&since=2026-07-01T00:00:00Z", {
      headers: { "x-admin-secret": "test-admin-secret" },
    }),
    env(db),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].query, "q");
});
