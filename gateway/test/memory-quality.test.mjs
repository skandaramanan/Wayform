// Retrieval and supersession quality fixes from the 2026-09-17 production
// audit: judge verdicts as suggestions, dangling-pointer repair, IDF entity
// weighting, and grouped search output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import {
  retrieve,
  renderSearchResults,
  SEARCH_MAX_ENTRIES,
  SEARCH_FACTS_PER_ENTRY,
} from "../dist/gateway/src/retrieval.js";
import { entityRank } from "../dist/gateway/src/rank.js";
import { buildExtractionPrompt } from "../dist/gateway/src/extract.js";
import { fakeEmbed } from "./helpers.mjs";

function doc(id, body, extra = {}) {
  return {
    id,
    space: "s1",
    project: "p",
    kind: "decision",
    tier: "normal",
    body,
    sourceFile: `context/p/a/${id.split("#")[0]}.md`,
    sourceAuthor: "A",
    sourceTs: "2026-09-01T00:00:00Z",
    embedding: [],
    supersededBy: null,
    createdAt: "2026-09-01T00:00:00Z",
    sourceId: id.split("#")[0],
    entities: [],
    ...extra,
  };
}

test("a suggested supersession demotes and annotates the old fact, never hides it", async () => {
  const db = new MemoryIndexDb();
  const docs = [
    doc("old#1", "cursor mcp config is project scoped"),
    doc("new#1", "cursor mcp config is now global"),
  ];
  const vecs = await fakeEmbed(docs.map((d) => d.body));
  await db.upsertDocs(docs.map((d, i) => ({ ...d, embedding: vecs[i] })));
  await db.logSupersession({
    space: "s1",
    project: "p",
    newFactId: "new#1",
    oldFactId: "old#1",
    verdict: "replaces",
    autoLinked: false,
    reason: "judge",
    ts: "2026-09-02T00:00:00Z",
  });
  const { results } = await retrieve(
    { db, embed: fakeEmbed },
    {
      space: "s1",
      project: "p",
      query: "cursor mcp config",
      budgetTokens: 4000,
      trigger: "test",
    },
  );
  const old = results.find((r) => r.doc.id === "old#1");
  assert.ok(old, "still retrievable");
  assert.equal(old.supersededBy, "new#1");
  assert.match(
    renderSearchResults("p", "q", results, 2),
    /possibly outdated — see fact new#1/,
  );
});

test("dangling supersession pointers are re-pointed within the entry, or cleared", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([
    doc("a#1", "fact a", { supersededBy: "fix#gone" }),
    doc("fix#new", "the correction, re-extracted under a new id"),
    doc("b#1", "fact b", { supersededBy: "vanished#x" }),
  ]);
  await db.repairDanglingSupersession("s1");
  assert.equal((await db.getDoc("s1", "a#1")).supersededBy, "fix#new");
  assert.equal((await db.getDoc("s1", "b#1")).supersededBy, null);
});

test("entityRank weights rare tags above generic ones", () => {
  const docs = [
    ...Array.from({ length: 20 }, (_, i) => ({
      id: `g${i}`,
      entities: ["plan", "memorylayer"],
    })),
    { id: "answer", entities: ["mosaic"] },
  ];
  const ranked = entityRank(docs, "mosaic competitor positioning plan layer");
  assert.equal(ranked[0].id, "answer", "the rare tag wins over a generic one");
});

test("search output is grouped by entry and capped", () => {
  const results = [];
  for (let e = 0; e < SEARCH_MAX_ENTRIES + 3; e++) {
    for (let f = 0; f < SEARCH_FACTS_PER_ENTRY + 2; f++) {
      results.push({
        doc: doc(`e${e}#${f}`, `entry ${e} fact ${f}`),
        score: 1,
      });
    }
  }
  const text = renderSearchResults("p", "q", results, 999);
  assert.equal((text.match(/^## /gm) ?? []).length, SEARCH_MAX_ENTRIES);
  assert.equal(
    (text.match(/^- \[/gm) ?? []).length,
    SEARCH_MAX_ENTRIES * SEARCH_FACTS_PER_ENTRY,
  );
  assert.match(text, /…2 more matching facts from this entry/);
});

test("the extraction prompt forbids context-free fragments", () => {
  const p = buildExtractionPrompt({
    author: "A",
    type: "decision",
    timestamp: "t",
    id: "x",
    payload: "body",
    file: "f.md",
  });
  assert.match(p, /name its subject explicitly/);
  assert.match(p, /never "it", "this", "the issue"/);
});
