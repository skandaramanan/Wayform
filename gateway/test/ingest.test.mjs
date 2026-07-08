import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import {
  projectFromPath,
  entryToDoc,
  ingestEntries,
  ingestFiles,
  reindexSpace,
} from "../dist/gateway/src/ingest.js";
import { makeEnv, ghFetch, fakeEmbed } from "./helpers.mjs";

const SR = {
  space: "s1",
  installationId: 7,
  owner: "o",
  repo: "r",
  branch: "main",
};

const entryMd = (project, body, id = "abc123") =>
  `---\nauthor: Skanda\ntype: decision\ntimestamp: 2026-07-04T11:00:00Z\nid: ${id}\nproject: ${project}\n---\n\n${body}\n`;

/** Routes shared by ingestFiles/reindexSpace tests: token + contents + tree + head. */
function ghRoutes(calls) {
  return ghFetch(calls, [
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
          tree: [
            { path: "context/memorylayer/skanda/a.md", type: "blob" },
            { path: "context/other-proj/skanda/b.md", type: "blob" },
            { path: "README.md", type: "blob" },
          ],
        }),
    ],
    [
      "/contents/context/memorylayer/skanda/a.md",
      () =>
        new Response(
          entryMd("memorylayer", "Cursor MCP config is project-scoped."),
        ),
    ],
    [
      "/contents/context/other-proj/skanda/b.md",
      () =>
        new Response(entryMd("other-proj", "Other project fact.", "def456")),
    ],
    [
      "/contents/context/memorylayer/skanda/broken.md",
      () => new Response("not an entry at all"),
    ],
  ]);
}

test("projectFromPath extracts the project slug segment", () => {
  assert.equal(
    projectFromPath("context/memorylayer/skanda/x.md"),
    "memorylayer",
  );
  assert.equal(projectFromPath("README.md"), null);
  assert.equal(projectFromPath("context/x/nope.txt"), null);
});

test("entryToDoc maps a parsed entry; falls back to file path when id missing", () => {
  const entry = {
    author: "A",
    type: "context",
    timestamp: "2026-01-01T00:00:00Z",
    id: "",
    payload: "body",
    file: "context/p/a/f.md",
  };
  const d = entryToDoc("s1", "My Proj", entry, [1]);
  assert.equal(d.id, "context/p/a/f.md");
  assert.equal(d.project, "my-proj"); // slugged
  assert.equal(d.kind, "context");
  assert.equal(d.tier, "normal");
  assert.equal(d.supersededBy, null);
});

test("ingestEntries embeds and upserts; embed failure stores empty vectors", async () => {
  const db = new MemoryIndexDb();
  const entry = {
    author: "A",
    type: "decision",
    timestamp: "2026-01-01T00:00:00Z",
    id: "e1",
    payload: "we picked D1",
    file: "context/p/a/f.md",
  };
  assert.equal(await ingestEntries(db, fakeEmbed, "s1", "p", [entry]), 1);
  assert.equal((await db.listDocs("s1", "p"))[0].embedding.length, 16);

  const db2 = new MemoryIndexDb();
  const boom = async () => {
    throw new Error("down");
  };
  assert.equal(await ingestEntries(db2, boom, "s1", "p", [entry]), 1);
  assert.deepEqual((await db2.listDocs("s1", "p"))[0].embedding, []);
});

test("ingestFiles fetches, parses, skips junk, groups by project, records sha", async () => {
  const calls = [];
  const env = makeEnv(ghRoutes(calls));
  const db = new MemoryIndexDb();
  const n = await ingestFiles(
    env,
    db,
    fakeEmbed,
    SR,
    [
      "context/memorylayer/skanda/a.md",
      "context/other-proj/skanda/b.md",
      "context/memorylayer/skanda/broken.md",
      "README.md",
    ],
    "pushsha",
    env.githubFetch,
  );
  assert.equal(n, 2);
  assert.equal((await db.listDocs("s1", "memorylayer")).length, 1);
  assert.equal((await db.listDocs("s1", "other-proj")).length, 1);
  assert.equal(await db.getLastIndexedSha("s1"), "pushsha");
});

test("reindexSpace wipes the space and rebuilds from the full tree", async () => {
  const calls = [];
  const env = makeEnv(ghRoutes(calls));
  const db = new MemoryIndexDb();
  await db.upsertDocs([
    {
      id: "stale",
      space: "s1",
      project: "memorylayer",
      kind: "decision",
      tier: "normal",
      body: "stale",
      sourceFile: "x",
      sourceAuthor: "x",
      sourceTs: "2026-01-01T00:00:00Z",
      embedding: [],
      supersededBy: null,
      createdAt: "2026-01-01T00:00:00Z",
    },
  ]);
  const result = await reindexSpace(env, db, fakeEmbed, SR, env.githubFetch);
  assert.equal(result.count, 2);
  assert.equal(result.total, 2);
  assert.equal(result.nextOffset, null);
  const ids = (await db.listDocs("s1")).map((d) => d.id);
  assert.ok(!ids.includes("stale"));
  assert.equal(await db.getLastIndexedSha("s1"), "headsha");
});

test("reindexSpace project filter scopes to one project's paths only", async () => {
  const calls = [];
  const env = makeEnv(ghRoutes(calls));
  const db = new MemoryIndexDb();
  const result = await reindexSpace(env, db, fakeEmbed, SR, env.githubFetch, {
    project: "memorylayer",
  });
  assert.equal(result.count, 1);
  assert.equal(result.total, 1);
  assert.equal((await db.listDocs("s1", "memorylayer")).length, 1);
  assert.equal((await db.listDocs("s1", "other-proj")).length, 0);
});

test("reindexSpace pagination: subrequest-budget-safe backfill across multiple calls", async () => {
  const calls = [];
  const env = makeEnv(ghRoutes(calls));
  const db = new MemoryIndexDb();

  // Page 1: wipes the space (offset 0), indexes only the first path, does
  // NOT advance last_indexed_sha yet (more pages remain).
  const page1 = await reindexSpace(env, db, fakeEmbed, SR, env.githubFetch, {
    limit: 1,
  });
  assert.equal(page1.count, 1);
  assert.equal(page1.total, 2);
  assert.equal(page1.nextOffset, 1);
  assert.equal(await db.getLastIndexedSha("s1"), null);
  assert.equal((await db.listDocs("s1")).length, 1);

  // Page 2: does NOT re-wipe (offset > 0), indexes the remaining path, THEN
  // advances last_indexed_sha since this is the final page.
  const page2 = await reindexSpace(env, db, fakeEmbed, SR, env.githubFetch, {
    offset: page1.nextOffset,
    limit: 1,
  });
  assert.equal(page2.count, 1);
  assert.equal(page2.nextOffset, null);
  assert.equal(await db.getLastIndexedSha("s1"), "headsha");
  assert.equal((await db.listDocs("s1")).length, 2);
});
