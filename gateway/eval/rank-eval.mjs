#!/usr/bin/env node
/**
 * Rank-based retrieval eval over a REAL exported corpus.
 *
 * Why this exists alongside golden.test.mjs: that test measures recall@10 over
 * 4 toy docs, which cannot see an ordering problem. On 2026-09-13 the only doc
 * of 425 containing "Mosaic" ranked 16th for a query built from its own rarest
 * terms — and recall@10 passed, because 16th... was not in the top 10, yet the
 * toy corpus never exercised it at all. Ordering needs an ordering metric.
 *
 * Reports MRR and the rank of each expected doc. Any tuning of RRF_K, TAU or
 * the kind priors should be judged here, not by inspection: the first
 * hypothesis for that failure (BM25 length normalisation) was WRONG, and only
 * a measurement showed it.
 *
 * COSINE IS EXCLUDED — re-embedding the query needs Workers AI credentials.
 * Both generators the entity-tag bug affects (bm25, entity) are covered, so
 * this measures what it claims to; confirm end-to-end against the live gateway.
 *
 * Export the corpus first (needs operator Cloudflare creds):
 *   wrangler d1 execute memorylayer-index --remote --json --command \
 *     "SELECT id,kind,tier,body,source_ts FROM docs WHERE space='<space>' \
 *      AND project='<project>' AND superseded_by IS NULL"  > docs.json
 *   wrangler d1 execute memorylayer-index --remote --json --command \
 *     "SELECT fact_id,entity FROM fact_entities WHERE space='<space>'" > entities.json
 *
 * Usage:
 *   node eval/rank-eval.mjs <dir-with-docs.json+entities.json+cases.json>
 * cases.json: [{ "query": "...", "expect": "<fact id>", "note": "..." }]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bm25Rank,
  entityRank,
  rrfFuse,
  adjustScores,
} from "../dist/gateway/src/rank.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: node eval/rank-eval.mjs <dir>");
  process.exit(2);
}
/**
 * `wrangler d1 execute --json` wraps rows as [{ results, success, meta }],
 * so the export command in the header above does NOT produce a bare array.
 * Unwrap it here rather than making every caller remember a jq incantation —
 * on 2026-09-21 this eval, recorded as the project's next quality check,
 * crashed on its own documented input.
 */
const rows = (v) => (Array.isArray(v) && v[0]?.results ? v[0].results : v);
const read = (f) => rows(JSON.parse(readFileSync(join(dir, f), "utf8")));
const docs = read("docs.json");
const entitiesRaw = read("entities.json");
// Accept either the { factId: [entity] } map or raw fact_entities rows.
const entities = Array.isArray(entitiesRaw)
  ? entitiesRaw.reduce((m, r) => {
      const id = r.fact_id ?? r.factId;
      (m[id] ??= []).push(r.entity);
      return m;
    }, {})
  : entitiesRaw;
const cases = read("cases.json").filter((c) => c.expect);

const withEnts = docs.map((d) => ({ ...d, entities: entities[d.id] ?? [] }));
const byId = new Map(
  docs.map((d) => [
    d.id,
    { kind: d.kind, sourceTs: d.source_ts, tier: d.tier },
  ]),
);

let rr = 0;
const ranks = [];
for (const c of cases) {
  const bm = bm25Rank(
    docs.map((d) => ({ id: d.id, body: d.body })),
    c.query,
    50,
    docs.length,
  );
  const en = entityRank(withEnts, c.query).slice(0, 50);
  const ids = adjustScores(rrfFuse([bm, en]), byId, new Date()).map(
    (s) => s.id,
  );
  // `expect` lists the ENTRY ids (fact-id prefixes) that answer the query.
  // Entries split into many facts and duplicates get superseded, so pinning
  // one fact id went stale as soon as the corpus was re-extracted (2026-09-17).
  const accept = (Array.isArray(c.expect) ? c.expect : [c.expect]).map(
    (e) => e.split("#")[0],
  );
  const i = ids.findIndex((id) => accept.includes(id.split("#")[0]));
  const rank = i < 0 ? Infinity : i + 1;
  ranks.push(rank);
  rr += i < 0 ? 0 : 1 / rank;
  console.log(
    `  rank ${(rank === Infinity ? "MISS" : String(rank)).padStart(4)}  ${accept.join("|").padEnd(28)} ${c.note ?? ""}`,
  );
}
const n = cases.length;
console.log(`\n  corpus ${docs.length} docs | bm25 + entity (no cosine)`);
console.log(
  `  MRR ${(rr / n).toFixed(4)}   top-1 ${ranks.filter((r) => r === 1).length}/${n}   top-3 ${ranks.filter((r) => r <= 3).length}/${n}`,
);
