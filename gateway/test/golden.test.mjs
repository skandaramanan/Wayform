import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import { retrieve } from "../dist/gateway/src/retrieval.js";
import { recallAtK } from "../dist/gateway/src/eval-golden.js";
import { fakeEmbed } from "./helpers.mjs";

// Start at the Phase A exit floor (0.9); tighten toward 0.95 as the fixture grows.
const RECALL_FLOOR = 0.9;
/**
 * Mean reciprocal rank floor.
 *
 * recall@10 alone CANNOT see an ordering problem — on 2026-09-13 the only doc
 * of 425 containing "Mosaic" ranked 16th for a query of its own rarest terms
 * and this suite stayed green. MRR is the metric that regresses when ranking
 * degrades, which is why it is asserted here and not only in the offline
 * eval/rank-eval.mjs (that one needs a real exported corpus and cannot run in CI).
 *
 * Actual MRR on this fixture is 1.000 (every expected doc ranks first), so the
 * floor has real headroom: tripping it needs an average rank worse than ~1.33.
 * That catches a catastrophic regression, NOT a subtle one — 4 toy cases over 5
 * docs cannot. Real ranking quality is measured by eval/rank-eval.mjs against
 * an exported production corpus. Raise this floor as the fixture grows.
 */
const MRR_FLOOR = 0.75;
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

  // ORDERING, not just presence. A doc that is retrieved but buried is a
  // ranking failure that recall cannot express.
  const ranks = cases.map((c, i) => {
    const ids = retrievedByCase[i];
    const best = (c.expectedIds ?? [])
      .map((id) => ids.indexOf(id))
      .filter((ix) => ix >= 0)
      .sort((a, b) => a - b)[0];
    return best === undefined ? 0 : 1 / (best + 1);
  });
  const mrr = ranks.reduce((a, b) => a + b, 0) / (cases.length || 1);
  const worst = cases
    .map((c, i) => ({ q: c.query, rr: ranks[i] }))
    .sort((a, b) => a.rr - b.rr)
    .slice(0, 2)
    .map((x) => `${x.q} (rr=${x.rr.toFixed(2)})`);
  assert.ok(
    mrr >= MRR_FLOOR,
    `MRR ${mrr.toFixed(3)} < floor ${MRR_FLOOR}; worst: ${worst.join("; ")}`,
  );
});
