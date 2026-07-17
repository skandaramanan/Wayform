import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tokenize,
  bm25Rank,
  cosineTopK,
  rrfFuse,
  adjustScores,
  entityRank,
  CANON_BOOST,
  TAU,
  FEEDBACK_PENALTY,
} from "../dist/gateway/src/rank.js";

test("adjustScores demotes a net-negative fact below an identical clean one", () => {
  const now = new Date("2026-07-10T00:00:00Z");
  const docsById = new Map([
    [
      "f1",
      { kind: "decision", sourceTs: "2026-07-01T00:00:00Z", tier: "normal" },
    ],
    [
      "f2",
      { kind: "decision", sourceTs: "2026-07-01T00:00:00Z", tier: "normal" },
    ],
  ]);
  const fused = new Map([
    ["f1", 0.02],
    ["f2", 0.02],
  ]);
  const penalties = new Map([["f1", 2]]); // f1 flagged twice net-negative
  const scored = adjustScores(fused, docsById, now, penalties);
  const s1 = scored.find((s) => s.id === "f1").score;
  const s2 = scored.find((s) => s.id === "f2").score;
  assert.ok(s1 < s2, "flagged fact ranks below the clean one");
  assert.ok(
    Math.abs(s1 - s2 * FEEDBACK_PENALTY ** 2) < 1e-9,
    "penalty is FEEDBACK_PENALTY**net",
  );
});

test("adjustScores with no penalties map is a no-op", () => {
  const now = new Date("2026-07-10T00:00:00Z");
  const docsById = new Map([
    [
      "f1",
      { kind: "decision", sourceTs: "2026-07-01T00:00:00Z", tier: "normal" },
    ],
  ]);
  const withOut = adjustScores(new Map([["f1", 0.02]]), docsById, now);
  const withEmpty = adjustScores(
    new Map([["f1", 0.02]]),
    docsById,
    now,
    new Map(),
  );
  assert.equal(withOut[0].score, withEmpty[0].score);
});

test("tokenize lowercases, splits on non-alphanumerics, drops 1-char tokens", () => {
  assert.deepEqual(tokenize("Cursor's MCP-config, v2!"), [
    "cursor",
    "mcp",
    "config",
    "v2",
  ]);
});

test("bm25Rank: exact-term doc outranks unrelated docs (the Cursor miss)", () => {
  const docs = [
    {
      id: "old-cursor",
      body: "Cursor MCP config is project-scoped, not global — verified.",
    },
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `filler-${i}`,
      body: `gateway auth token rotation step ${i} for the hosted plane`,
    })),
  ];
  const ranked = bm25Rank(docs, "how does cursor mcp config work");
  assert.equal(ranked[0].id, "old-cursor");
});

test("bm25Rank returns [] for empty query or empty corpus", () => {
  assert.deepEqual(bm25Rank([], "cursor"), []);
  assert.deepEqual(bm25Rank([{ id: "a", body: "x y z" }], "!!"), []);
});

test("cosineTopK ranks by cosine similarity, skips dimension mismatches", () => {
  const docs = [
    { id: "close", embedding: [1, 0, 0] },
    { id: "far", embedding: [0, 1, 0] },
    { id: "bad", embedding: [1, 0] },
  ];
  const ranked = cosineTopK(docs, [0.9, 0.1, 0]);
  assert.deepEqual(
    ranked.map((r) => r.id),
    ["close", "far"],
  );
});

test("rrfFuse: doc present in both lists beats single-list docs", () => {
  const fused = rrfFuse([
    [
      { id: "both", score: 9 },
      { id: "onlyA", score: 8 },
    ],
    [
      { id: "both", score: 0.9 },
      { id: "onlyB", score: 0.8 },
    ],
  ]);
  assert.ok(fused.get("both") > fused.get("onlyA"));
  assert.ok(fused.get("both") > fused.get("onlyB"));
});

test("adjustScores: decisions get a boost; status decays with age", () => {
  const now = new Date("2026-07-08T00:00:00Z");
  const docsById = new Map([
    [
      "d",
      { kind: "decision", tier: "normal", sourceTs: "2026-01-01T00:00:00Z" },
    ],
    [
      "c",
      { kind: "context", tier: "normal", sourceTs: "2026-01-01T00:00:00Z" },
    ],
    [
      "s-old",
      { kind: "status", tier: "normal", sourceTs: "2026-06-10T00:00:00Z" },
    ], // 28d = 2 half-lives
    [
      "s-new",
      { kind: "status", tier: "normal", sourceTs: "2026-07-08T00:00:00Z" },
    ],
  ]);
  const fused = new Map([
    ["d", 0.02],
    ["c", 0.02],
    ["s-old", 0.02],
    ["s-new", 0.02],
  ]);
  const out = adjustScores(fused, docsById, now);
  const score = (id) => out.find((s) => s.id === id).score;
  assert.ok(score("d") > score("c")); // kind prior — an old decision does NOT decay
  assert.ok(Math.abs(score("s-old") - score("s-new") * 0.25) < 1e-9); // 2 half-lives
  assert.deepEqual(out.map((s) => s.id).slice(0, 1), ["d"]); // sorted desc
});

test("TAU is a small positive floor below a single-list top-1 RRF score", () => {
  assert.ok(TAU > 0 && TAU < 1 / 61);
});

test("adjustScores: a canon fact outranks a same-similarity normal decision", () => {
  const now = new Date("2026-07-08T00:00:00Z");
  const docsById = new Map([
    [
      "canon",
      { kind: "constraint", tier: "canon", sourceTs: "2026-01-01T00:00:00Z" },
    ],
    [
      "norm",
      { kind: "decision", tier: "normal", sourceTs: "2026-07-08T00:00:00Z" },
    ],
  ]);
  const fused = new Map([
    ["canon", 0.02],
    ["norm", 0.02],
  ]);
  const out = adjustScores(fused, docsById, now);
  assert.equal(out[0].id, "canon");
});

test("CANON_BOOST exceeds the strongest kind prior (1.2) so canon wins its slot", () => {
  assert.ok(CANON_BOOST > 1.2);
});

test("entityRank: docs whose entity tags overlap the query rank; others absent", () => {
  const docs = [
    { id: "hit", entities: ["cursor", "mcp-config"] },
    { id: "miss", entities: ["gateway-auth"] },
  ];
  const ranked = entityRank(docs, "how is cursor scoped");
  assert.deepEqual(
    ranked.map((r) => r.id),
    ["hit"],
  );
});

test("entityRank returns [] when the query names no known entity", () => {
  assert.deepEqual(
    entityRank([{ id: "a", entities: ["cursor"] }], "unrelated nonsense"),
    [],
  );
});

test("cosineTopK ranks Float32Array embeddings identically to number[]", () => {
  const vecs = [
    [0.9, 0.1, 0.05],
    [0.1, 0.9, 0.2],
    [0.5, 0.5, 0.5],
  ];
  const asArrays = vecs.map((v, i) => ({ id: `d${i}`, embedding: v }));
  const asF32 = vecs.map((v, i) => ({
    id: `d${i}`,
    embedding: new Float32Array(v),
  }));
  const query = [0.8, 0.2, 0.1];
  const a = cosineTopK(asArrays, query);
  const b = cosineTopK(asF32, new Float32Array(query));
  assert.deepEqual(
    b.map((s) => s.id),
    a.map((s) => s.id),
  );
  for (let i = 0; i < a.length; i++) {
    assert.ok(
      Math.abs(a[i].score - b[i].score) < 1e-6,
      `score drift at rank ${i}: ${a[i].score} vs ${b[i].score}`,
    );
  }
});
