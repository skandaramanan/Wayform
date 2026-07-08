import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import {
  handleAdminReindex,
  reconcileAll,
} from "../dist/gateway/src/reindex.js";
import { registerSpaceRepo } from "../dist/gateway/src/tenancy.js";
import { makeEnv, ghFetch, fakeEmbed } from "./helpers.mjs";

const entryMd =
  "---\nauthor: Skanda\ntype: decision\ntimestamp: 2026-07-04T00:00:00Z\nid: abc\nproject: memorylayer\n---\n\na decision\n";

function envWith(indexDb) {
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
      ["/commits/main", () => Response.json({ sha: "headsha" })],
      [
        "/git/trees/main",
        () =>
          Response.json({
            tree: [{ path: "context/memorylayer/skanda/a.md", type: "blob" }],
          }),
      ],
      ["/contents/context/memorylayer/skanda/a.md", () => new Response(entryMd)],
    ]),
    { indexDb, embedder: fakeEmbed },
  );
  return env;
}

test("POST /admin/reindex requires the admin secret and rebuilds registered spaces", async () => {
  const db = new MemoryIndexDb();
  const env = envWith(db);
  await registerSpaceRepo(env, {
    space: "s1",
    installationId: 7,
    owner: "o",
    repo: "r",
    branch: "main",
  });
  const forbidden = await handleAdminReindex(
    new Request("https://gw/admin/reindex", { method: "POST", body: "{}" }),
    env,
  );
  assert.equal(forbidden.status, 403);

  const res = await handleAdminReindex(
    new Request("https://gw/admin/reindex", {
      method: "POST",
      headers: { "x-admin-secret": "test-admin-secret" },
      body: JSON.stringify({}),
    }),
    env,
  );
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out, { reindexed: { s1: 1 } });
  assert.equal((await db.listDocs("s1", "memorylayer")).length, 1);
});

test("reconcileAll reindexes only spaces whose indexed sha lags HEAD", async () => {
  const db = new MemoryIndexDb();
  const env = envWith(db);
  await registerSpaceRepo(env, {
    space: "s1",
    installationId: 7,
    owner: "o",
    repo: "r",
    branch: "main",
  });
  await db.setLastIndexedSha("s1", "headsha"); // already current
  await reconcileAll(env);
  assert.equal((await db.listDocs("s1")).length, 0); // untouched

  await db.setLastIndexedSha("s1", "stalesha");
  await reconcileAll(env);
  assert.equal((await db.listDocs("s1", "memorylayer")).length, 1);
});
