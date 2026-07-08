import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryIndexDb,
  encodeEmbedding,
  decodeEmbedding,
  d1IndexDb,
} from "../dist/gateway/src/index-db.js";

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
