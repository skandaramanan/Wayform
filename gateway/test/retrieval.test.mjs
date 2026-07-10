import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import {
  retrieve,
  renderSearchResults,
  renderBriefing,
} from "../dist/gateway/src/retrieval.js";
import { fakeEmbed } from "./helpers.mjs";

function doc(id, body, overrides = {}) {
  return {
    id,
    space: "s1",
    project: "memorylayer",
    kind: "decision",
    tier: "normal",
    body,
    sourceFile: `context/memorylayer/skanda/${id}.md`,
    sourceAuthor: "Skanda",
    sourceTs: "2026-07-04T11:00:00Z",
    embedding: [],
    supersededBy: null,
    createdAt: "2026-07-08T00:00:00Z",
    sourceId: id,
    entities: [],
    ...overrides,
  };
}

async function seed(db, docs) {
  const vecs = await fakeEmbed(docs.map((d) => d.body));
  await db.upsertDocs(docs.map((d, i) => ({ ...d, embedding: vecs[i] })));
}

test("the Cursor regression: old exact-topic decision beats 45 newer unrelated entries", async () => {
  const db = new MemoryIndexDb();
  await seed(db, [
    doc(
      "cursor-fact",
      "Cursor MCP config is project-scoped, not global — verified 2026-07-04.",
      { sourceTs: "2026-06-01T00:00:00Z" },
    ),
    ...Array.from({ length: 45 }, (_, i) =>
      doc(
        `f${i}`,
        `gateway auth hardening step ${i} for hosted member tokens`,
        {
          sourceTs: "2026-07-07T00:00:00Z",
        },
      ),
    ),
  ]);
  const { results, total } = await retrieve(
    { db, embed: fakeEmbed },
    {
      space: "s1",
      project: "memorylayer",
      query: "how is cursor mcp config scoped",
      budgetTokens: 4000,
      trigger: "test",
    },
  );
  assert.equal(total, 46);
  assert.equal(results[0].doc.id, "cursor-fact");
});

test("kinds filter restricts candidates; empty index returns empty", async () => {
  const db = new MemoryIndexDb();
  await seed(db, [
    doc("d1", "we chose D1 for the index plane"),
    doc("c1", "background: pilot has two spaces", { kind: "context" }),
  ]);
  const { results } = await retrieve(
    { db, embed: fakeEmbed },
    {
      space: "s1",
      project: "memorylayer",
      query: "index plane pilot spaces",
      budgetTokens: 4000,
      kinds: ["context"],
      trigger: "test",
    },
  );
  assert.deepEqual(
    results.map((r) => r.doc.id),
    ["c1"],
  );

  const empty = await retrieve(
    { db, embed: fakeEmbed },
    { space: "nope", query: "anything", budgetTokens: 4000, trigger: "test" },
  );
  assert.deepEqual(empty, { results: [], total: 0 });
});

test("irrelevant queries fall below tau — silence is a first-class outcome", async () => {
  const db = new MemoryIndexDb();
  await seed(db, [doc("d1", "we chose D1 for the index plane")]);
  const { results } = await retrieve(
    { db, embed: null }, // BM25 only: zero term overlap => no candidates
    {
      space: "s1",
      project: "memorylayer",
      query: "zzqx unrelated nonsense",
      budgetTokens: 4000,
      trigger: "test",
    },
  );
  assert.deepEqual(results, []);
});

test("embedder failure fails open to BM25-only", async () => {
  const db = new MemoryIndexDb();
  await seed(db, [doc("cursor-fact", "Cursor MCP config is project-scoped.")]);
  const boom = async () => {
    throw new Error("model down");
  };
  const { results } = await retrieve(
    { db, embed: boom },
    {
      space: "s1",
      project: "memorylayer",
      query: "cursor mcp config",
      budgetTokens: 4000,
      trigger: "test",
    },
  );
  assert.equal(results[0].doc.id, "cursor-fact");
});

test("budget packing keeps highest-scored results within budget (never zero)", async () => {
  const db = new MemoryIndexDb();
  const big = "cursor ".repeat(400); // ~700 tokens each
  await seed(db, [doc("a", big), doc("b", big), doc("c", big)]);
  const { results } = await retrieve(
    { db, embed: fakeEmbed },
    {
      space: "s1",
      project: "memorylayer",
      query: "cursor",
      budgetTokens: 800,
      trigger: "test",
    },
  );
  assert.equal(results.length, 1);
});

test("every retrieval is logged with trigger, query, scores, injected flag", async () => {
  const db = new MemoryIndexDb();
  await seed(db, [doc("cursor-fact", "Cursor MCP config is project-scoped.")]);
  await retrieve(
    { db, embed: fakeEmbed },
    {
      space: "s1",
      project: "memorylayer",
      query: "cursor config",
      budgetTokens: 4000,
      trigger: "search_memory",
    },
  );
  assert.equal(db.logged.length, 1);
  assert.equal(db.logged[0].trigger, "search_memory");
  assert.equal(db.logged[0].query, "cursor config");
  assert.equal(db.logged[0].injected, true);
  assert.equal(db.logged[0].returned[0].id, "cursor-fact");
  assert.ok(db.logged[0].returned[0].score > 0);
});

test("retrieve applies feedback penalties and fails open when the map load throws", async () => {
  const db = new MemoryIndexDb();
  // "flagged" has more query-term content, so it out-ranks "clean" on the raw
  // pipeline. Only the feedback penalty can push it below "clean".
  await seed(db, [
    doc("clean", "cursor mcp config scoping"),
    doc("flagged", "cursor mcp config scoping cursor mcp config"),
  ]);
  const rawIds = (
    await retrieve(
      { db, embed: fakeEmbed },
      { space: "s1", project: "memorylayer", query: "cursor mcp config", budgetTokens: 4000, trigger: "test" },
    )
  ).results.map((r) => r.doc.id);
  assert.equal(rawIds[0], "flagged", "precondition: flagged out-ranks clean without feedback");

  // Flag "flagged" net-negative twice.
  const fb = { space: "s1", project: "memorylayer", member: "Ada", ts: "2026-07-10T00:00:00Z" };
  await db.recordFeedback({ ...fb, factId: "flagged", verdict: "wrong" });
  await db.recordFeedback({ ...fb, factId: "flagged", verdict: "wrong" });
  const { results } = await retrieve(
    { db, embed: fakeEmbed },
    { space: "s1", project: "memorylayer", query: "cursor mcp config", budgetTokens: 4000, trigger: "test" },
  );
  const ids = results.map((r) => r.doc.id);
  assert.ok(ids.indexOf("clean") < ids.indexOf("flagged"), "flagged fact demoted below clean");

  // Fail-open: a throwing feedbackPenalties must not break retrieval.
  db.feedbackPenalties = async () => {
    throw new Error("penalty store down");
  };
  const { results: r2 } = await retrieve(
    { db, embed: fakeEmbed },
    { space: "s1", project: "memorylayer", query: "cursor mcp config", budgetTokens: 4000, trigger: "test" },
  );
  assert.ok(r2.length >= 1, "retrieval still returns results when penalties throw");
});

test("renderSearchResults groups by kind and carries provenance", () => {
  const results = [
    { doc: doc("d1", "we chose D1"), score: 0.03 },
    { doc: doc("c1", "pilot background", { kind: "context" }), score: 0.02 },
  ];
  const text = renderSearchResults("memorylayer", "index", results, 10);
  assert.match(text, /# Memory search: "index"/);
  assert.match(text, /2 of 10 indexed entries cleared the relevance bar/);
  assert.match(text, /## decision — Skanda — 2026-07-04/);
  assert.match(text, /source: context\/memorylayer\/skanda\/d1\.md/);
  const none = renderSearchResults("memorylayer", "xyz", [], 10);
  assert.match(none, /no stored entries cleared the relevance bar/);
});

test("entity-tag rescue: a fact retrievable only by its entity tag still surfaces", async () => {
  const db = new MemoryIndexDb();
  await db.replaceBySource("s1", "e1", [
    {
      id: "e1#0",
      space: "s1",
      project: "memorylayer",
      kind: "constraint",
      tier: "normal",
      body: "Config is project-scoped, not global.",
      sourceFile: "f",
      sourceAuthor: "Skanda",
      sourceTs: "2026-06-01T00:00:00Z",
      embedding: [],
      supersededBy: null,
      createdAt: "2026-07-08T00:00:00Z",
      sourceId: "e1",
      entities: ["cursor"],
    },
  ]);
  const { results } = await retrieve(
    { db, embed: null }, // no BM25 overlap ("cursor" absent from body), no vectors
    {
      space: "s1",
      project: "memorylayer",
      query: "cursor",
      budgetTokens: 4000,
      trigger: "test",
    },
  );
  assert.equal(results[0].doc.id, "e1#0");
});

function bdoc(id, kind, tier, body, entities, sourceTs) {
  return {
    id,
    space: "s1",
    project: "memorylayer",
    kind,
    tier,
    body,
    sourceFile: `context/memorylayer/skanda/${id}.md`,
    sourceAuthor: "Skanda",
    sourceTs,
    embedding: [],
    supersededBy: null,
    createdAt: "2026-07-08T00:00:00Z",
    sourceId: id,
    entities,
  };
}

test("renderBriefing includes canon, open questions, 7-day decisions, and a topic manifest", () => {
  const now = new Date("2026-07-08T00:00:00Z");
  const docs = [
    bdoc(
      "c",
      "constraint",
      "canon",
      "Infra cost must stay $0/free-tier.",
      ["infra-cost"],
      "2026-02-01T00:00:00Z",
    ),
    bdoc(
      "q",
      "question",
      "normal",
      "Should preferences travel across spaces?",
      ["multi-space"],
      "2026-07-07T00:00:00Z",
    ),
    bdoc(
      "d",
      "decision",
      "normal",
      "Chose D1 for the index.",
      ["d1", "index"],
      "2026-07-07T00:00:00Z",
    ),
    bdoc(
      "old",
      "decision",
      "normal",
      "Ancient decision.",
      ["legacy"],
      "2026-01-01T00:00:00Z",
    ),
  ];
  const text = renderBriefing("memorylayer", docs, 4000, now);
  assert.match(text, /Infra cost must stay \$0/); // canon always shown
  assert.match(text, /Should preferences travel/); // open question
  assert.match(text, /Chose D1 for the index/); // recent decision (<7d)
  assert.doesNotMatch(text, /Ancient decision/); // >7d decision excluded from the recent section
  assert.match(text, /memory covers:/); // topic manifest line
  assert.match(text, /infra-cost \(1\)/); // manifest counts entities
});

test("renderBriefing caps the topic manifest at 40 entities with a '+N more' suffix", () => {
  const now = new Date("2026-07-08T00:00:00Z");
  // 42 facts, each with a distinct single entity, all recent decisions. The
  // manifest must list only the first 40 (stable order, all count 1) and
  // summarize the overflow rather than growing unbounded.
  const docs = Array.from({ length: 42 }, (_, i) => {
    const tag = `e${String(i).padStart(2, "0")}`;
    return bdoc(
      tag,
      "decision",
      "normal",
      `decision about ${tag}`,
      [tag],
      "2026-07-07T00:00:00Z",
    );
  });
  const text = renderBriefing("memorylayer", docs, 4000, now);
  const line = text.split("\n").find((l) => l.startsWith("memory covers:"));
  assert.ok(line, "manifest line present");
  const listed = (line.match(/\(\d+\)/g) ?? []).length;
  assert.equal(listed, 40, "exactly 40 entities listed");
  assert.match(line, /\+2 more/);
  assert.match(line, /e00 \(1\)/); // kept
  assert.doesNotMatch(line, /e41 \(1\)/); // dropped into the overflow count
});

test("renderBriefing on an empty index returns an empty string (caller falls back)", () => {
  assert.equal(renderBriefing("memorylayer", [], 4000, new Date()), "");
});

test("renderBriefing includes unresolved conflicts when provided", () => {
  const text = renderBriefing(
    "memorylayer",
    [],
    4000,
    new Date("2026-07-08T00:00:00Z"),
    [
      {
        oldFactId: "o1",
        oldBody: "MCP is project-scoped",
        reason: "scope clash",
      },
    ],
  );
  assert.match(text, /Unresolved conflicts/);
  assert.match(text, /scope clash/);
});
