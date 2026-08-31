import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import { makeEnv, ghFetch } from "./helpers.mjs";

function env(db) {
  return makeEnv(ghFetch([], []), { indexDb: db });
}

test("POST /admin/golden-candidate records a candidate with the admin secret", async () => {
  const db = new MemoryIndexDb();
  const res = await handleRequest(
    new Request("https://gw.test/admin/golden-candidate", {
      method: "POST",
      headers: {
        "x-admin-secret": "test-admin-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        space: "s1",
        project: "memorylayer",
        query: "cursor scoping",
        expectedFactId: "cursor-fact",
        note: "live miss",
      }),
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
    space: "s1",
    project: "memorylayer",
    trigger: "hook_prompt",
    query: "q",
    returned: [{ id: "f1", score: 0.03 }],
    injected: true,
    ts: "2026-07-10T00:00:00Z",
  });
  const res = await handleRequest(
    new Request(
      "https://gw.test/admin/retrieval-log?space=s1&since=2026-07-01T00:00:00Z",
      {
        headers: { "x-admin-secret": "test-admin-secret" },
      },
    ),
    env(db),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.rows.length, 1);
  assert.equal(body.rows[0].query, "q");
});

test("retrieval-log filters by trigger and counts guard fires", async () => {
  const db = new MemoryIndexDb();
  const base = { space: "team-a", project: "memorylayer", returned: [], query: "q" };
  await db.logRetrieval({ ...base, trigger: "hook_guard", injected: true,  ts: "2026-08-30T10:00:00Z" });
  await db.logRetrieval({ ...base, trigger: "hook_guard", injected: false, ts: "2026-08-30T10:01:00Z" });
  await db.logRetrieval({ ...base, trigger: "hook_read",  injected: true,  ts: "2026-08-30T10:02:00Z" });

  const res = await handleRequest(
    new Request(
      "https://gw.test/admin/retrieval-log?space=team-a&trigger=hook_guard",
      { headers: { "x-admin-secret": "test-admin-secret" } },
    ),
    env(db),
  );
  const body = await res.json();
  assert.equal(body.rows.length, 2);
  assert.equal(body.fired, 1);
});

test("retrieval-log without a trigger returns every row", async () => {
  const db = new MemoryIndexDb();
  await db.logRetrieval({
    space: "team-a", project: "memorylayer", trigger: "hook_read",
    query: "q", returned: [], injected: true, ts: "2026-08-30T10:00:00Z",
  });
  const res = await handleRequest(
    new Request("https://gw.test/admin/retrieval-log?space=team-a", {
      headers: { "x-admin-secret": "test-admin-secret" },
    }),
    env(db),
  );
  assert.equal((await res.json()).rows.length, 1);
});
