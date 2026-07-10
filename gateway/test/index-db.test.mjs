import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryIndexDb,
  encodeEmbedding,
  decodeEmbedding,
  d1IndexDb,
} from "../dist/gateway/src/index-db.js";

test("feedbackPenalties nets wrong+stale minus useful, floored above zero", async () => {
  const db = new MemoryIndexDb();
  const base = { space: "s1", project: "memorylayer", member: "Ada", ts: "2026-07-10T00:00:00Z" };
  await db.recordFeedback({ ...base, factId: "f1", verdict: "wrong" });
  await db.recordFeedback({ ...base, factId: "f1", verdict: "stale" });
  await db.recordFeedback({ ...base, factId: "f1", verdict: "useful" }); // net = 2 - 1 = 1
  await db.recordFeedback({ ...base, factId: "f2", verdict: "useful" }); // net = -1 → dropped
  const pen = await db.feedbackPenalties("s1");
  assert.equal(pen.get("f1"), 1);
  assert.equal(pen.has("f2"), false);
});

function doc(overrides = {}) {
  return {
    id: "e1",
    space: "s1",
    project: "memorylayer",
    kind: "decision",
    tier: "normal",
    body: "Cursor MCP config is project-scoped.",
    sourceFile: "context/memorylayer/skanda/f.md",
    sourceAuthor: "Skanda",
    sourceTs: "2026-07-04T00:00:00Z",
    embedding: [0.1, 0.2],
    supersededBy: null,
    createdAt: "2026-07-08T00:00:00Z",
    sourceId: "e1",
    entities: [],
    ...overrides,
  };
}

test("MemoryIndexDb: upsert is idempotent per (space,id); listDocs scopes by space+project", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([doc(), doc({ body: "updated body" })]);
  await db.upsertDocs([doc({ id: "e2", project: "other" })]);
  await db.upsertDocs([doc({ id: "e1", space: "s2" })]);
  assert.equal((await db.listDocs("s1")).length, 2);
  const scoped = await db.listDocs("s1", "memorylayer");
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].body, "updated body");
});

test("MemoryIndexDb: listDocs excludes superseded docs", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([doc(), doc({ id: "e2", supersededBy: "e1" })]);
  assert.deepEqual(
    (await db.listDocs("s1")).map((d) => d.id),
    ["e1"],
  );
});

test("MemoryIndexDb: sha state and deleteSpace", async () => {
  const db = new MemoryIndexDb();
  assert.equal(await db.getLastIndexedSha("s1"), null);
  await db.setLastIndexedSha("s1", "abc");
  assert.equal(await db.getLastIndexedSha("s1"), "abc");
  await db.upsertDocs([doc()]);
  await db.deleteSpace("s1");
  assert.deepEqual(await db.listDocs("s1"), []);
});

test("embedding blob codec round-trips (float32 precision)", () => {
  const v = [0.25, -1.5, 3.75];
  assert.deepEqual(decodeEmbedding(encodeEmbedding(v)), v);
  assert.deepEqual(decodeEmbedding(null), []);
  assert.deepEqual(decodeEmbedding(encodeEmbedding([])), []);
});

test("d1IndexDb issues parameterized SQL and decodes rows", async () => {
  const executed = [];
  const stmt = (sql) => ({
    sql,
    params: [],
    bind(...values) {
      this.params = values;
      return this;
    },
    async run() {
      executed.push(this);
      return {};
    },
    async all() {
      executed.push(this);
      return {
        results: [
          {
            id: "e1",
            space: "s1",
            project: "memorylayer",
            kind: "decision",
            tier: "normal",
            body: "b",
            source_file: "f.md",
            source_author: "A",
            source_ts: "2026-07-04T00:00:00Z",
            embedding: encodeEmbedding([0.5]),
            superseded_by: null,
            created_at: "2026-07-08T00:00:00Z",
          },
        ],
      };
    },
    async first() {
      executed.push(this);
      return { last_indexed_sha: "abc" };
    },
  });
  const fake = {
    prepare: (sql) => stmt(sql),
    async batch(stmts) {
      executed.push(...stmts);
      return [];
    },
  };
  const db = d1IndexDb(fake);

  await db.upsertDocs([doc()]);
  const upsert = executed.find((s) =>
    /INSERT OR REPLACE INTO docs/i.test(s.sql),
  );
  assert.ok(upsert);
  assert.equal(upsert.params[0], "e1");

  const rows = await db.listDocs("s1", "memorylayer");
  assert.deepEqual(rows[0].embedding, [0.5]);
  assert.equal(rows[0].sourceFile, "f.md");
  const list = executed.find(
    (s) => /FROM docs/i.test(s.sql) && /superseded_by IS NULL/i.test(s.sql),
  );
  assert.deepEqual(list.params, ["s1", "memorylayer"]);

  assert.equal(await db.getLastIndexedSha("s1"), "abc");
  await db.logRetrieval({
    space: "s1",
    project: "memorylayer",
    trigger: "mcp_read",
    query: "q",
    returned: [{ id: "e1", score: 0.5 }],
    injected: true,
    ts: "2026-07-08T00:00:00Z",
  });
  assert.ok(executed.some((s) => /INSERT INTO retrieval_log/i.test(s.sql)));
});

test("MemoryIndexDb: replaceBySource is idempotent — re-running leaves no duplicate/orphan facts", async () => {
  const db = new MemoryIndexDb();
  const f = (id, body, entities = []) =>
    doc({ id, body, entities, sourceId: "e1" });
  await db.replaceBySource("s1", "e1", [
    f("e1#0", "a", ["cursor"]),
    f("e1#1", "b"),
  ]);
  assert.equal((await db.listDocs("s1")).length, 2);
  // second extraction of the same entry yields a DIFFERENT fact set
  await db.replaceBySource("s1", "e1", [f("e1#0", "a-updated", ["cursor"])]);
  const docs = await db.listDocs("s1");
  assert.equal(docs.length, 1); // e1#1 orphan is gone
  assert.equal(docs[0].body, "a-updated");
  assert.deepEqual(docs[0].entities, ["cursor"]); // entities hydrated on read
});

test("MemoryIndexDb: replaceBySource scopes deletion by (space, sourceId)", async () => {
  const db = new MemoryIndexDb();
  await db.replaceBySource("s1", "e1", [doc({ id: "e1#0", sourceId: "e1" })]);
  await db.replaceBySource("s1", "e2", [doc({ id: "e2#0", sourceId: "e2" })]);
  await db.replaceBySource("s1", "e1", []); // clears only e1's facts
  assert.deepEqual(
    (await db.listDocs("s1")).map((d) => d.id),
    ["e2#0"],
  );
});

test("d1IndexDb.replaceBySource batches deletes (fact_entities + docs) then inserts", async () => {
  const executed = [];
  const stmt = (sql) => ({
    sql,
    params: [],
    bind(...v) {
      this.params = v;
      return this;
    },
    async run() {
      executed.push(this);
      return {};
    },
    async all() {
      executed.push(this);
      return { results: [] };
    },
    async first() {
      return null;
    },
  });
  const fake = {
    prepare: (sql) => stmt(sql),
    async batch(s) {
      executed.push(...s);
      return [];
    },
  };
  const db = d1IndexDb(fake);
  await db.replaceBySource("s1", "e1", [
    doc({
      id: "e1#0",
      tier: "canon",
      embedding: [0.5],
      sourceId: "e1",
      entities: ["cursor", "d1"],
    }),
  ]);
  assert.ok(
    executed.some((s) =>
      /DELETE FROM docs WHERE space = \? AND source_id = \?/i.test(s.sql),
    ),
  );
  assert.ok(
    executed.some((s) =>
      /DELETE FROM fact_entities WHERE space = \? AND fact_id IN/i.test(s.sql),
    ),
  );
  assert.ok(
    executed.some(
      (s) =>
        /INSERT OR REPLACE INTO docs/i.test(s.sql) && s.params.includes("e1#0"),
    ),
  );
  assert.ok(
    executed.some(
      (s) =>
        /INSERT OR REPLACE INTO fact_entities/i.test(s.sql) &&
        s.params.includes("cursor"),
    ),
  );
});

test("markSuperseded sets old fact's supersededBy; listDocs excludes it", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([doc(), doc({ id: "new1" })]);
  await db.markSuperseded("s1", "e1", "new1");
  const live = await db.listDocs("s1");
  assert.deepEqual(
    live.map((d) => d.id),
    ["new1"],
  );
});

test("clearSupersessionPointersTo un-hides facts pointing at deleted ids", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([doc({ id: "victim" }), doc({ id: "soon-gone" })]);
  await db.markSuperseded("s1", "victim", "soon-gone");
  await db.clearSupersessionPointersTo("s1", ["soon-gone"]);
  const live = await db.listDocs("s1");
  assert.ok(live.some((d) => d.id === "victim"));
});

test("replaceBySource clears inbound pointers before delete", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([
    doc({ id: "other", sourceId: "other" }),
    doc({ id: "e1#0", sourceId: "e1" }),
  ]);
  await db.markSuperseded("s1", "other", "e1#0");
  await db.replaceBySource("s1", "e1", [
    doc({ id: "e1#0", sourceId: "e1", body: "rewritten" }),
  ]);
  const live = await db.listDocs("s1");
  assert.ok(live.some((d) => d.id === "other"));
});

test("clearAllSupersession wipes edges and returns count", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([doc({ id: "a" }), doc({ id: "b" })]);
  await db.markSuperseded("s1", "a", "b");
  const n = await db.clearAllSupersession("s1");
  assert.equal(n, 1);
  assert.equal((await db.listDocs("s1")).length, 2);
});

test("logSupersession + recentConflictLogs round-trip", async () => {
  const db = new MemoryIndexDb();
  await db.logSupersession({
    space: "s1",
    project: "memorylayer",
    newFactId: "n1",
    oldFactId: "o1",
    verdict: "contradicts",
    autoLinked: false,
    reason: "scope mismatch",
    ts: "2026-07-10T00:00:00Z",
  });
  const rows = await db.recentConflictLogs(
    "s1",
    "memorylayer",
    "2026-07-09T00:00:00Z",
    5,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, "contradicts");
});
