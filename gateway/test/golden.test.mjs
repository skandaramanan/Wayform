import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import { retrieve } from "../dist/gateway/src/retrieval.js";
import { recallAtK } from "../dist/gateway/src/eval-golden.js";
import { fakeEmbed } from "./helpers.mjs";

// Start at the Phase A exit floor (0.9); tighten toward 0.95 as the fixture grows.
const RECALL_FLOOR = 0.9;
const SPACE = "golden-space";
const PROJECT = "memorylayer";

function fullDoc(seed, embedding) {
  return {
    id: seed.id,
    space: SPACE,
    project: PROJECT,
    kind: seed.kind,
    tier: seed.tier,
    body: seed.body,
    sourceFile: `context/${PROJECT}/skanda/${seed.id}.md`,
    sourceAuthor: seed.sourceAuthor,
    sourceTs: seed.sourceTs,
    embedding,
    supersededBy: null,
    createdAt: seed.sourceTs,
    sourceId: seed.id,
    entities: seed.entities ?? [],
  };
}

test("golden set: recall@10 stays at or above the floor", async () => {
  const { corpus, cases } = JSON.parse(
    readFileSync(new URL("../eval/golden.json", import.meta.url), "utf8"),
  );
  const db = new MemoryIndexDb();
  const vecs = await fakeEmbed(corpus.map((d) => d.body));
  await db.upsertDocs(corpus.map((d, i) => fullDoc(d, vecs[i])));

  const retrievedByCase = [];
  for (const c of cases) {
    const { results } = await retrieve(
      { db, embed: fakeEmbed },
      {
        space: SPACE,
        project: PROJECT,
        query: c.query,
        budgetTokens: 4000,
        trigger: "golden",
      },
    );
    retrievedByCase.push(results.map((r) => r.doc.id));
  }

  const { recall, perCase } = recallAtK(cases, retrievedByCase, 10);
  const misses = perCase.filter((p) => p.recall < 1).map((p) => p.query);
  assert.ok(
    recall >= RECALL_FLOOR,
    `recall@10 ${recall.toFixed(2)} < floor ${RECALL_FLOOR}; missed: ${misses.join("; ")}`,
  );
});
