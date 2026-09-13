import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMBED_SCAN_CAP,
  TOKEN_MATCH_LIMIT,
} from "../dist/gateway/src/index-db.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
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
      {
        space: "s1",
        project: "memorylayer",
        query: "cursor mcp config",
        budgetTokens: 4000,
        trigger: "test",
      },
    )
  ).results.map((r) => r.doc.id);
  assert.equal(
    rawIds[0],
    "flagged",
    "precondition: flagged out-ranks clean without feedback",
  );

  // Flag "flagged" net-negative twice.
  const fb = {
    space: "s1",
    project: "memorylayer",
    member: "Ada",
    ts: "2026-07-10T00:00:00Z",
  };
  await db.recordFeedback({ ...fb, factId: "flagged", verdict: "wrong" });
  await db.recordFeedback({ ...fb, factId: "flagged", verdict: "wrong" });
  const { results } = await retrieve(
    { db, embed: fakeEmbed },
    {
      space: "s1",
      project: "memorylayer",
      query: "cursor mcp config",
      budgetTokens: 4000,
      trigger: "test",
    },
  );
  const ids = results.map((r) => r.doc.id);
  assert.ok(
    ids.indexOf("clean") < ids.indexOf("flagged"),
    "flagged fact demoted below clean",
  );

  // Fail-open: a throwing feedbackPenalties must not break retrieval.
  db.feedbackPenalties = async () => {
    throw new Error("penalty store down");
  };
  const { results: r2 } = await retrieve(
    { db, embed: fakeEmbed },
    {
      space: "s1",
      project: "memorylayer",
      query: "cursor mcp config",
      budgetTokens: 4000,
      trigger: "test",
    },
  );
  assert.ok(
    r2.length >= 1,
    "retrieval still returns results when penalties throw",
  );
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
  // Fact id must be visible — memory_feedback and supersedes both consume it.
  assert.match(text, /id: d1/);
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
  // A quiet week (1 decision in window) backfills with the latest decisions,
  // newest first, under an honest title.
  assert.match(text, /## Latest decisions/);
  assert.ok(text.indexOf("Chose D1") < text.indexOf("Ancient decision"));
  assert.match(text, /memory covers:/); // topic manifest line
  assert.match(text, /infra-cost \(1\)/); // manifest counts entities
});

test("renderBriefing spends ONE budget across all sections", () => {
  // Regression: the budget was per-section, so canon, questions, conflicts
  // and decisions could each fill it — a 16KB briefing on a 4000 budget.
  const now = new Date("2026-07-08T00:00:00Z");
  const body = (i) => `fact ${i} ` + "word ".repeat(70); // ~350 chars
  const docs = [
    ...Array.from({ length: 10 }, (_, i) =>
      bdoc(`c${i}`, "constraint", "canon", body(i), [], "2026-07-01T00:00:00Z"),
    ),
    ...Array.from({ length: 10 }, (_, i) =>
      bdoc(`d${i}`, "decision", "normal", body(i), [], "2026-07-07T00:00:00Z"),
    ),
    ...Array.from({ length: 10 }, (_, i) =>
      bdoc(`q${i}`, "question", "normal", body(i), [], "2026-07-07T00:00:00Z"),
    ),
  ];
  const text = renderBriefing("memorylayer", docs, 500, now);
  const bullets = text.split("\n").filter((l) => l.startsWith("- "));
  const spent = bullets.reduce((n, l) => n + Math.ceil(l.length / 4) + 12, 0);
  assert.ok(spent <= 500, `bullets cost ${spent} tokens against a 500 budget`);
  assert.match(
    text,
    /Standing rules/,
    "the highest-priority section fills first",
  );
  assert.doesNotMatch(text, /Open questions/, "the lowest is what gets cut");
});

test("renderBriefing clips a long fact to one line that points at the rest", () => {
  const now = new Date("2026-07-08T00:00:00Z");
  const long = "PRODUCT PIVOT.\n\n" + "the plan is the object. ".repeat(200);
  const text = renderBriefing(
    "memorylayer",
    [bdoc("blob#0", "decision", "normal", long, [], "2026-07-07T00:00:00Z")],
    4000,
    now,
  );
  const line = text.split("\n").find((l) => l.includes("PRODUCT PIVOT"));
  assert.ok(
    line,
    "the fact stays on one line — no blank lines inside a bullet",
  );
  assert.ok(line.length < 600, `clipped line is ${line.length} chars`);
  assert.match(line, /truncated — search_memory/);
  assert.match(line, /fact id blob#0/);
});

test("renderBriefing drops open questions older than 30 days", () => {
  const now = new Date("2026-09-13T00:00:00Z");
  const text = renderBriefing(
    "memorylayer",
    [
      bdoc(
        "old",
        "question",
        "normal",
        "Fix strategy still OPEN",
        [],
        "2026-07-03T00:00:00Z",
      ),
      bdoc(
        "new",
        "question",
        "normal",
        "Where does generation run?",
        [],
        "2026-09-10T00:00:00Z",
      ),
    ],
    4000,
    now,
  );
  assert.match(text, /Where does generation run/);
  assert.doesNotMatch(text, /Fix strategy still OPEN/);
});

test("renderBriefing keeps the 7-day window when the week is busy, and never repeats canon", () => {
  const now = new Date("2026-07-08T00:00:00Z");
  const docs = [
    ...Array.from({ length: 8 }, (_, i) =>
      bdoc(
        `d${i}`,
        "decision",
        "normal",
        `busy decision ${i}`,
        [],
        "2026-07-06T00:00:00Z",
      ),
    ),
    bdoc(
      "old",
      "decision",
      "normal",
      "Ancient decision.",
      [],
      "2026-01-01T00:00:00Z",
    ),
    bdoc(
      "cd",
      "decision",
      "canon",
      "Canon decision stays canon.",
      [],
      "2026-07-07T00:00:00Z",
    ),
  ];
  const text = renderBriefing("memorylayer", docs, 4000, now);
  assert.match(text, /## Recent decisions \(last 7 days\)/);
  assert.doesNotMatch(text, /Ancient decision/);
  assert.equal(text.split("Canon decision stays canon.").length - 1, 1);
});

test("renderBriefing's manifest drops generic tags and the project's own name", () => {
  const now = new Date("2026-07-08T00:00:00Z");
  const text = renderBriefing(
    "MemoryLayer",
    [
      bdoc(
        "a",
        "decision",
        "normal",
        "x",
        ["memorylayer", "not", "decided", "d1"],
        "2026-07-07T00:00:00Z",
      ),
    ],
    4000,
    now,
  );
  const line = text.split("\n").find((l) => l.startsWith("memory covers:"));
  assert.equal(line, "memory covers: d1 (1)");
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

// --- read-path hardening (bounded candidate hydration), 2026-07-13 ---

test("retrieve hydrates only candidate docs, not the whole corpus", async () => {
  const db = new MemoryIndexDb();
  await seed(db, [
    doc("hit", "cursor mcp config is project scoped"),
    ...Array.from({ length: 30 }, (_, i) =>
      doc(`cold${i}`, `entry about topic-${i} with nothing shared`),
    ),
  ]);
  const hydrated = [];
  const orig = db.getDocsByIds.bind(db);
  db.getDocsByIds = async (space, ids) => {
    hydrated.push(...ids);
    return orig(space, ids);
  };
  const { results, total } = await retrieve(
    { db, embed: null }, // no cosine → candidates come from tokens/entities only
    {
      space: "s1",
      project: "memorylayer",
      query: "cursor mcp config",
      budgetTokens: 4000,
      trigger: "test",
    },
  );
  assert.equal(total, 31); // total still reports the whole scope
  assert.equal(results[0].doc.id, "hit");
  assert.ok(
    hydrated.length < 31,
    `expected bounded hydration, got ${hydrated.length} of 31`,
  );
  assert.ok(hydrated.includes("hit"));
});

test("retrieve with embeddings still surfaces a paraphrase (cosine) candidate sharing no tokens", async () => {
  const db = new MemoryIndexDb();
  // fakeEmbed is token-hash based, so force a shared-vocabulary paraphrase:
  // doc and query share tokens ONLY in embedding space via identical words
  // the BM25 path can't see (we strip them from the query tokens by using
  // a doc whose body tokens all collide with query tokens in hash space).
  await seed(db, [
    doc("para", "codex onboarding token handoff"),
    doc("noise", "completely different subject matter"),
  ]);
  // Query shares real tokens with "para" — this asserts the cosine list's
  // ids are hydrated and rankable end-to-end (regression for the candidate
  // union wiring), not embedding quality itself.
  const { results } = await retrieve(
    { db, embed: fakeEmbed },
    {
      space: "s1",
      query: "codex token onboarding",
      budgetTokens: 4000,
      trigger: "test",
    },
  );
  assert.ok(results.length > 0);
  assert.equal(results[0].doc.id, "para");
});

// --- bounded-by-construction caps (the 1102 fix), 2026-07-17 ---

test("retrieve stays bounded on a corpus far larger than every cap", async () => {
  const db = new MemoryIndexDb();
  const N = 3000;
  // Every body shares the token "gateway" so the token prefilter saturates.
  await seed(
    db,
    Array.from({ length: N }, (_, i) =>
      doc(`bulk${i}`, `gateway rollout note ${i} for the hosted beta`, {
        sourceTs: `2026-07-${String(1 + (i % 15)).padStart(2, "0")}T${String(
          i % 24,
        ).padStart(2, "0")}:00:00Z`,
      }),
    ),
  );

  const scan = await db.queryScan("s1", ["gateway"], {
    project: "memorylayer",
  });
  assert.equal(scan.total, N, "total reports the true corpus size");
  assert.ok(
    scan.embeddings.length <= EMBED_SCAN_CAP,
    `embedding scan must cap at ${EMBED_SCAN_CAP}, got ${scan.embeddings.length}`,
  );
  assert.ok(
    scan.tokenMatchIds.length <= TOKEN_MATCH_LIMIT,
    `token prefilter must cap at ${TOKEN_MATCH_LIMIT}, got ${scan.tokenMatchIds.length}`,
  );

  const hydrated = [];
  const orig = db.getDocsByIds.bind(db);
  db.getDocsByIds = async (space, ids) => {
    hydrated.push(...ids);
    return orig(space, ids);
  };
  const { results, total } = await retrieve(
    { db, embed: fakeEmbed },
    {
      space: "s1",
      query: "gateway rollout hosted beta",
      budgetTokens: 4000,
      trigger: "test",
    },
  );
  assert.equal(total, N);
  assert.ok(results.length > 0, "a saturating query still returns results");
  // Hydration union: ≤ TOKEN_MATCH_LIMIT + cosine top-50 + entity cap (200).
  assert.ok(
    hydrated.length <= TOKEN_MATCH_LIMIT + 50 + 200,
    `hydration must stay bounded, got ${hydrated.length} of ${N}`,
  );
});
