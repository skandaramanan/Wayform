import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import {
  projectFromPath,
  factToDoc,
  ingestEntries,
  ingestFiles,
  reindexSpace,
} from "../dist/gateway/src/ingest.js";
import { makeEnv, ghFetch, fakeEmbed, fakeGenText } from "./helpers.mjs";

const twoFacts = JSON.stringify([
  {
    kind: "constraint",
    tier: "canon",
    body: "Cursor MCP config is project-scoped.",
    entities: ["cursor", "mcp-config"],
  },
  {
    kind: "context",
    tier: "normal",
    body: "Verified 2026-07-04.",
    entities: [],
  },
]);

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

test("factToDoc maps a fact to a doc; synthetic id + source_id fall back to file when entry id missing", () => {
  const entry = {
    author: "A",
    type: "context",
    timestamp: "2026-01-01T00:00:00Z",
    id: "",
    payload: "body",
    file: "context/p/a/f.md",
  };
  const fact = {
    kind: "constraint",
    tier: "canon",
    body: "b",
    entities: ["x"],
  };
  const d = factToDoc("s1", "My Proj", entry, fact, 0, [1]);
  // Ids are CONTENT-derived, not positional — assert the property, not a
  // literal. The old `#${idx}` form let re-extraction silently repoint a
  // stored id at different text.
  assert.match(d.id, /^context\/p\/a\/f\.md#[0-9a-z]{6,}$/);
  assert.equal(
    d.id,
    factToDoc("s1", "My Proj", entry, fact, 99, [1]).id,
    "the same fact keeps its id regardless of position in the entry",
  );
  assert.notEqual(
    d.id,
    factToDoc("s1", "My Proj", entry, { ...fact, body: "different" }, 0, [1])
      .id,
    "different text must yield a different id, so a stale ref dangles",
  );
  assert.equal(d.sourceId, "context/p/a/f.md");
  assert.equal(d.project, "my-proj"); // slugged
  assert.equal(d.kind, "constraint"); // from the fact, not the entry
  assert.equal(d.tier, "canon");
  assert.deepEqual(d.entities, ["x"]);
  assert.equal(d.supersededBy, null);
});

test("ingestEntries embeds each fact; embed failure stores empty vectors", async () => {
  const db = new MemoryIndexDb();
  const entry = {
    author: "A",
    type: "decision",
    timestamp: "2026-01-01T00:00:00Z",
    id: "e1",
    payload: "we picked D1",
    file: "context/p/a/f.md",
  };
  assert.equal(await ingestEntries(db, fakeEmbed, null, "s1", "p", [entry]), 1);
  assert.equal((await db.listDocs("s1", "p"))[0].embedding.length, 16);

  const db2 = new MemoryIndexDb();
  const boom = async () => {
    throw new Error("down");
  };
  assert.equal(await ingestEntries(db2, boom, null, "s1", "p", [entry]), 1);
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
    null,
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
  assert.equal(n.count, 2);
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
  const result = await reindexSpace(
    env,
    db,
    fakeEmbed,
    null,
    SR,
    env.githubFetch,
  );
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
  const result = await reindexSpace(
    env,
    db,
    fakeEmbed,
    null,
    SR,
    env.githubFetch,
    {
      project: "memorylayer",
    },
  );
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
  const page1 = await reindexSpace(
    env,
    db,
    fakeEmbed,
    null,
    SR,
    env.githubFetch,
    {
      limit: 1,
    },
  );
  assert.equal(page1.count, 1);
  assert.equal(page1.total, 2);
  assert.equal(page1.nextOffset, 1);
  assert.equal(await db.getLastIndexedSha("s1"), null);
  assert.equal((await db.listDocs("s1")).length, 1);

  // Page 2: does NOT re-wipe (offset > 0), indexes the remaining path, THEN
  // advances last_indexed_sha since this is the final page.
  const page2 = await reindexSpace(
    env,
    db,
    fakeEmbed,
    null,
    SR,
    env.githubFetch,
    {
      offset: page1.nextOffset,
      limit: 1,
    },
  );
  assert.equal(page2.count, 1);
  assert.equal(page2.nextOffset, null);
  assert.equal(await db.getLastIndexedSha("s1"), "headsha");
  assert.equal((await db.listDocs("s1")).length, 2);
});

test("ingestEntries extracts N facts per entry as docs rows with synthetic ids + source_id", async () => {
  const db = new MemoryIndexDb();
  const gen = fakeGenText({ "Cursor MCP": twoFacts });
  const entry = {
    author: "Skanda",
    type: "decision",
    timestamp: "2026-07-04T00:00:00Z",
    id: "e1",
    payload: "Cursor MCP config is project-scoped. Verified 2026-07-04.",
    file: "context/memorylayer/skanda/e.md",
  };
  const n = await ingestEntries(db, fakeEmbed, gen, "s1", "memorylayer", [
    entry,
  ]);
  assert.equal(n, 2);
  const docs = await db.listDocs("s1", "memorylayer");
  assert.equal(docs.length, 2);
  assert.ok(
    docs.every((d) => d.id.startsWith("e1#")),
    "sourceId prefix is stable",
  );
  assert.equal(
    new Set(docs.map((d) => d.id)).size,
    2,
    "distinct facts, distinct ids",
  );
  assert.ok(docs.every((d) => d.sourceId === "e1"));
  const canon = docs.find((d) => d.tier === "canon");
  assert.ok(canon, "the canon fact survived");
  assert.equal(canon.embedding.length, 16);
});

test("ingestEntries fail-open: no gen → one whole-entry normal fact (Phase A behavior)", async () => {
  const db = new MemoryIndexDb();
  const entry = {
    author: "A",
    type: "decision",
    timestamp: "2026-01-01T00:00:00Z",
    id: "e1",
    payload: "we picked D1",
    file: "context/p/a/f.md",
  };
  assert.equal(await ingestEntries(db, fakeEmbed, null, "s1", "p", [entry]), 1);
  const docs = await db.listDocs("s1", "p");
  assert.match(docs[0].id, /^e1#[0-9a-z]{6,}$/);
  assert.equal(docs[0].body, "we picked D1");
  assert.equal(docs[0].tier, "normal");
});

test("ingestEntries is idempotent per entry: re-ingesting replaces the fact set", async () => {
  const db = new MemoryIndexDb();
  const entry = {
    author: "A",
    type: "decision",
    timestamp: "2026-01-01T00:00:00Z",
    id: "e1",
    payload: "Cursor MCP note, verified 2026-07-04",
    file: "context/p/a/f.md",
  };
  await ingestEntries(
    db,
    fakeEmbed,
    fakeGenText({ "Cursor MCP": twoFacts }),
    "s1",
    "p",
    [entry],
  );
  assert.equal((await db.listDocs("s1", "p")).length, 2);
  // second run, single-fact extraction → old e1#1 must be gone
  await ingestEntries(
    db,
    fakeEmbed,
    fakeGenText({
      "Cursor MCP": JSON.stringify([
        {
          kind: "decision",
          tier: "normal",
          body: "single fact now",
          entities: [],
        },
      ]),
    }),
    "s1",
    "p",
    [entry],
    // Unchanged content is now skipped outright; force models a deliberate
    // re-extraction (e.g. a better prompt) to check replacement semantics.
    { force: true },
  );
  const docs = await db.listDocs("s1", "p");
  assert.equal(docs.length, 1);
  assert.equal(docs[0].body, "single fact now");
});

test("ingest STOPS when the day's neuron budget cannot cover the next entry", async () => {
  // The failure this prevents, observed 2026-09-13: a reindex of 202 entries
  // ran against a 95-extraction/day allocation. It spent the budget partway,
  // then every remaining entry silently took the floor path — and the reindex
  // still reported success while leaving the index WORSE than the one it
  // replaced. Stopping deliberately keeps the caller's cursor, so the next tick
  // resumes with a fresh budget instead of rebuilding without the model.
  const db = new MemoryIndexDb();
  const mk = (id) => ({
    author: "A",
    type: "decision",
    timestamp: "2026-01-01T00:00:00Z",
    id,
    payload: `entry ${id}`,
    file: `context/p/a/${id}.md`,
  });
  let genCalls = 0;
  const gen = async () => {
    genCalls += 1;
    return JSON.stringify([
      { kind: "decision", tier: "normal", body: "f", entities: ["x"] },
    ]);
  };

  // Plenty of budget: every entry is extracted.
  const n1 = await ingestEntries(
    db,
    fakeEmbed,
    gen,
    "s1",
    "p",
    [mk("a"), mk("b")],
    {
      budgetLeft: async () => 9500,
    },
  );
  assert.equal(n1, 2);
  const callsWithBudget = genCalls;
  assert.ok(callsWithBudget >= 2, "both entries reached the model");

  // Exhausted: it must decline to start, not floor its way through.
  genCalls = 0;
  const n2 = await ingestEntries(
    db,
    fakeEmbed,
    gen,
    "s1",
    "p",
    [mk("c"), mk("d")],
    {
      budgetLeft: async () => 0,
    },
  );
  assert.equal(genCalls, 0, "no model call is attempted past the budget");
  assert.equal(n2, 0, "and nothing is indexed rather than floor-indexed");

  // Unknown budget fails OPEN — a broken counter must not halt indexing.
  genCalls = 0;
  await ingestEntries(db, fakeEmbed, gen, "s1", "p", [mk("e")], {
    budgetLeft: async () => null,
  });
  assert.ok(genCalls > 0, "a null reading must not stop ingest");
});
