import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import {
  handleAdminReindex,
  reconcileAll,
  CRON_REINDEX_PAGE,
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
      [
        "/contents/context/memorylayer/skanda/a.md",
        () => new Response(entryMd),
      ],
    ]),
    { indexDb, embedder: fakeEmbed },
  );
  return env;
}

test("POST /mcp/admin/reindex is operator-gated and rebuilds registered spaces", async () => {
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
    new Request("https://gw/mcp/admin/reindex", { method: "POST", body: "{}" }),
    { ...env, oauthProps: { githubId: 9999, githubLogin: "outsider" } },
  );
  assert.equal(forbidden.status, 403);

  const res = await handleAdminReindex(
    new Request("https://gw/mcp/admin/reindex", {
      method: "POST",
      body: JSON.stringify({}),
    }),
    env,
  );
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.reindexed, { s1: 1 });
  // The response now carries the day's remaining allocation. A reindex that
  // outruns the budget still returns a plausible count while the entries after
  // the stop are NOT indexed — on 2026-09-13 that made a degrading rebuild of
  // 202 entries against a 95-call/day budget look like a successful one.
  assert.equal(typeof out.budget.neuronsLeft, "number");
  assert.match(out.budget.note, /sufficient|allocation spent/);
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
  // …and already backfilled under this extractor version.
  const { EXTRACTOR_VERSION } = await import("../dist/gateway/src/extract.js");
  await env.ROUTING.put("index-backfill:s1", EXTRACTOR_VERSION);
  await reconcileAll(env);
  assert.equal((await db.listDocs("s1")).length, 0); // untouched

  await db.setLastIndexedSha("s1", "stalesha");
  await reconcileAll(env);
  assert.equal((await db.listDocs("s1", "memorylayer")).length, 1);
});

// --- cron wipe-loop fix (paginated reconcile, 2026-07-13 incident) ---

function envWithManyEntries(indexDb, fileCount) {
  const files = Array.from(
    { length: fileCount },
    (_, i) =>
      `context/memorylayer/skanda/2026-07-01T00-00-${String(i).padStart(2, "0")}Z-e${i}.md`,
  );
  const md = (i) =>
    `---\nauthor: Skanda\ntype: decision\ntimestamp: 2026-07-01T00:00:${String(i).padStart(2, "0")}Z\nid: e${i}\nproject: memorylayer\n---\n\ndecision number ${i}\n`;
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
            tree: files.map((path) => ({ path, type: "blob" })),
          }),
      ],
      ...files.map((path, i) => [
        `/contents/${path}`,
        () => new Response(md(i)),
      ]),
    ]),
    { indexDb, embedder: fakeEmbed },
  );
  return env;
}

test("reconcileAll heals a large drifted space one bounded page per tick via a KV cursor", async () => {
  const db = new MemoryIndexDb();
  // Sized off the page constant so retuning the page size doesn't break this
  // test: two full pages plus a short final one still exercises resume + finish.
  const page = CRON_REINDEX_PAGE;
  const total = page * 2 + 5;
  const env = envWithManyEntries(db, total);
  await registerSpaceRepo(env, {
    space: "s1",
    installationId: 7,
    owner: "o",
    repo: "r",
    branch: "main",
  });
  // simulate the incident: no indexed sha at all (wiped space) → drift
  // tick 1: wipes (offset 0) and ingests the first page only
  await reconcileAll(env);
  assert.equal((await db.listDocs("s1")).length, page);
  assert.equal(await env.ROUTING.get("reindex-cursor:s1"), `headsha:${page}`);
  assert.equal(await db.getLastIndexedSha("s1"), null); // not done → still drifts

  // tick 2: resumes from the cursor without re-wiping
  await reconcileAll(env);
  assert.equal((await db.listDocs("s1")).length, page * 2);
  assert.equal(
    await env.ROUTING.get("reindex-cursor:s1"),
    `headsha:${page * 2}`,
  );

  // tick 3: final page — sha advances, cursor cleared
  await reconcileAll(env);
  assert.equal((await db.listDocs("s1")).length, total);
  assert.equal(await env.ROUTING.get("reindex-cursor:s1"), null);
  assert.equal(await db.getLastIndexedSha("s1"), "headsha");

  // tick 4: no drift → untouched
  await reconcileAll(env);
  assert.equal((await db.listDocs("s1")).length, total);
});

test("reconcileAll deletes an abandoned cursor once the sha has caught up", async () => {
  const db = new MemoryIndexDb();
  const env = envWithManyEntries(db, 3);
  await registerSpaceRepo(env, {
    space: "s1",
    installationId: 7,
    owner: "o",
    repo: "r",
    branch: "main",
  });
  // A webhook ingest advanced the sha mid-rebuild; the rebuild's cursor is debris.
  await db.setLastIndexedSha("s1", "headsha");
  await env.ROUTING.put("reindex-cursor:s1", "headsha:150");
  await reconcileAll(env);
  assert.equal(await env.ROUTING.get("reindex-cursor:s1"), null);
});

test("reconcileAll resumes a cursor even after the head moved — rebuilds no longer wipe", async () => {
  // This used to restart at offset 0, because resuming a WIPING rebuild
  // against a new head skipped the wiped range. Rebuilds are now
  // non-destructive, so restarting would only re-walk (and, pre-ingest_state,
  // re-extract) pages that are already done.
  const db = new MemoryIndexDb();
  const page = CRON_REINDEX_PAGE;
  const env = envWithManyEntries(db, page * 2 + 5);
  await registerSpaceRepo(env, {
    space: "s1",
    installationId: 7,
    owner: "o",
    repo: "r",
    branch: "main",
  });
  await env.ROUTING.put("reindex-cursor:s1", `stalesha:${page}`);
  await reconcileAll(env);
  assert.equal((await db.listDocs("s1")).length, page);
  assert.equal(
    await env.ROUTING.get("reindex-cursor:s1"),
    `headsha:${page * 2}`,
    "continued from the saved offset",
  );
});
