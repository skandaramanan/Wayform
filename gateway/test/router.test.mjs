import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import { makeEnv } from "./helpers.mjs";

test("GET /health returns ok json", async () => {
  const res = await handleRequest(
    new Request("https://gw.test/health"),
    makeEnv(),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("unknown path returns 404", async () => {
  const res = await handleRequest(
    new Request("https://gw.test/nope"),
    makeEnv(),
  );
  assert.equal(res.status, 404);
});

test("OPTIONS preflight on /mcp returns 204 with CORS headers", async () => {
  const res = await handleRequest(
    new Request("https://gw.test/mcp", {
      method: "OPTIONS",
      headers: {
        origin: "https://chatgpt.com",
        "access-control-request-method": "POST",
      },
    }),
    makeEnv(),
  );
  assert.equal(res.status, 204);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("access-control-allow-methods"), /POST/);
});

test("a normal response still carries CORS headers (browser can read the body)", async () => {
  const res = await handleRequest(
    new Request("https://gw.test/health"),
    makeEnv(),
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await res.json(), { ok: true });
});

test("GET /admin/supersession-audit is operator-gated", async () => {
  const db = new (
    await import("../dist/gateway/src/index-db-memory.js")
  ).MemoryIndexDb();
  const res = await handleRequest(
    new Request("https://gw.test/admin/supersession-audit?space=s1"),
    makeEnv(async () => new Response(), {
      indexDb: db,
      oauthProps: { githubId: 9999, githubLogin: "outsider" },
    }),
  );
  assert.equal(res.status, 403);
});

test("POST /admin/clear-supersession clears edges", async () => {
  const { MemoryIndexDb } =
    await import("../dist/gateway/src/index-db-memory.js");
  const db = new MemoryIndexDb();
  await db.upsertDocs([
    {
      id: "a",
      space: "s1",
      project: "p",
      kind: "decision",
      tier: "normal",
      body: "a",
      sourceFile: "f.md",
      sourceAuthor: "A",
      sourceTs: "2026-01-01T00:00:00Z",
      embedding: [],
      supersededBy: null,
      createdAt: "2026-01-01T00:00:00Z",
      sourceId: "a",
      entities: [],
    },
    {
      id: "b",
      space: "s1",
      project: "p",
      kind: "decision",
      tier: "normal",
      body: "b",
      sourceFile: "f.md",
      sourceAuthor: "A",
      sourceTs: "2026-01-01T00:00:00Z",
      embedding: [],
      supersededBy: null,
      createdAt: "2026-01-01T00:00:00Z",
      sourceId: "b",
      entities: [],
    },
  ]);
  await db.markSuperseded("s1", "a", "b");
  const res = await handleRequest(
    new Request("https://gw.test/admin/clear-supersession", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ space: "s1" }),
    }),
    makeEnv(async () => new Response(), { indexDb: db }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cleared, 1);
  assert.equal((await db.listDocs("s1")).length, 2);
});

test("POST /admin/allowlist is operator-gated; /join is gone", async () => {
  const env = makeEnv();
  const denied = await handleRequest(
    new Request("https://gw.test/admin/allowlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ add: ["ada"] }),
    }),
    { ...env, oauthProps: { githubId: 9999, githubLogin: "outsider" } },
  );
  assert.equal(denied.status, 403);
  const added = await handleRequest(
    new Request("https://gw.test/admin/allowlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ add: ["ada"] }),
    }),
    env,
  );
  assert.equal(added.status, 200);
  assert.deepEqual((await added.json()).allowlist, ["ada"]);
  const join = await handleRequest(
    new Request("https://gw.test/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    env,
  );
  assert.equal(join.status, 404);
});
