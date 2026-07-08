# Phase A — Retrieval Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Query-conditioned, relevance-ranked retrieval over the whole ledger history on both planes (hosted gateway + local CLI), fixing the confirmed "Cursor decision 40 entries deep never surfaces" miss class.

**Architecture:** The gateway (Cloudflare Worker) gains a disposable index in D1: one row per ledger entry (naive per-entry indexing — no LLM extraction yet, that's Phase B). Ingest happens three ways: inline on gateway writes (read-your-own-writes), via a GitHub push webhook for local-plane writes, and via a cron reconciler + `POST /admin/reindex` for recovery/backfill. Retrieval runs the §5 pipeline entirely in the Worker in pure TypeScript: BM25 + brute-force cosine candidate generation → reciprocal rank fusion → kind priors → relevance floor τ → token-budget packing → provenance-carrying render. Every query-conditioned retrieval is logged to `retrieval_log`. The local CLI becomes remote-first for reads (calls the gateway with its member token) with the existing local recency read as the offline fail-open fallback.

**Tech Stack:** TypeScript, Cloudflare Workers + D1 + Workers AI (`@cf/baai/bge-base-en-v1.5` embeddings), node:test for both test suites, no new npm dependencies.

## Global Constraints

- **Branch from `main`** (roadmap: "implementation branches from main"), e.g. `relevance/phase-a`. Use superpowers:using-git-worktrees.
- **Ledger format unchanged** — no changes to `src/frontmatter.ts` serialization, entry paths, or commit conventions.
- **Fail-open everywhere**: a broken index, missing D1/AI binding, unreachable gateway, or failed embed must degrade to the existing recency read (or to silence on ingest), never to an error surfaced to a session.
- **$0 infra**: D1 free tier, Workers AI free allocation, cron trigger (free). No Queues, no Vectorize, no paid models.
- **No native modules, no new npm dependencies** in either package.
- **Deviation from roadmap §4 schema, deliberate:** no D1 FTS5 virtual table. BM25 is computed in the Worker over the space's docs (≤ low-thousands rows — same "exact scan is single-digit ms" argument §2.1 makes for cosine). Rationale: one code path that node:test can exercise directly (node:sqlite has no FTS5; the gateway suite has no miniflare), no FTS-sync triggers, identical recall behavior. If a space's corpus makes in-Worker scoring the measured bottleneck, FTS5 slots in behind the same candidate-generation interface.
- **Test seams follow the existing pattern**: `Env` carries optional injected fakes (`githubFetch` today; add `indexDb`, `embedder`), production leaves them unset.
- Tenant scoping: every index read/write is parameterized by `member.space` exactly like tool calls today.
- Root suite: `npm test` (builds + node:test). Gateway suite: `cd gateway && npm test`. Both must stay green; also `npm run lint`, `npm run typecheck`, `npm run format:check`.

## File Structure

```
gateway/src/rank.ts          NEW  pure scoring: tokenize, BM25, cosine, RRF, priors, τ
gateway/src/index-db.ts      NEW  IndexedDoc/IndexDb types, MemoryIndexDb, d1IndexDb, blob codecs
gateway/src/retrieval.ts     NEW  retrieve() pipeline orchestrator + renderSearchResults + log
gateway/src/ingest.ts        NEW  entryToDoc, ingestEntries, ingestFiles, reindexSpace
gateway/src/deps.ts          NEW  indexDeps(env) — resolves IndexDb + Embedder from bindings/seams
gateway/src/webhook.ts       NEW  POST /webhook/github: HMAC verify + push-payload ingest
gateway/src/reindex.ts       NEW  POST /admin/reindex handler + reconcileAll (cron)
gateway/src/api-read.ts      NEW  GET /api/read — JSON read endpoint for the local CLI
gateway/src/env.ts           MOD  add DB/AI/WEBHOOK_SECRET bindings + test seams
gateway/src/worker.ts        MOD  pass ctx; add scheduled() handler
gateway/src/router.ts        MOD  new routes
gateway/src/tenancy.ts       MOD  space-repo registry written on member mint
gateway/src/mcp.ts           MOD  read_context query param, search_memory tool, inline write ingest
gateway/migrations/0001_relevance_index.sql  NEW  D1 schema
gateway/wrangler.toml        MOD  D1 + AI bindings, cron trigger
gateway/test/rank.test.mjs, index-db.test.mjs, retrieval.test.mjs, ingest.test.mjs,
gateway/test/webhook.test.mjs, reindex.test.mjs, api-read.test.mjs  NEW
gateway/test/mcp.test.mjs, tenancy.test.mjs, helpers.mjs            MOD
src/config.ts                MOD  gatewayUrl/gatewayToken + env allowlist
src/remote-read.ts           NEW  remoteApiRead / remoteHookRead clients (timeout, null-on-failure)
src/hook.ts                  MOD  remote-first with local fallback
src/index.ts                 MOD  read_context query param, search_memory tool, remote-first read
test/remote-read.test.mjs    NEW; test/config.test.mjs MOD
gateway/README.md            MOD  deploy + webhook + client-env docs
```

---

### Task 1: Pure ranking functions (`rank.ts`)

**Files:**
- Create: `gateway/src/rank.ts`
- Test: `gateway/test/rank.test.mjs`

**Interfaces:**
- Consumes: `IndexedDoc` shape (only `kind`, `sourceTs` fields; defined properly in Task 2 — this module types its params structurally to avoid a dependency cycle).
- Produces (used by Task 3):
  - `tokenize(text: string): string[]`
  - `interface Scored { id: string; score: number }`
  - `bm25Rank(docs: {id: string; body: string}[], query: string, topK?: number): Scored[]`
  - `cosineTopK(docs: {id: string; embedding: number[]}[], queryVec: number[], topK?: number): Scored[]`
  - `rrfFuse(lists: Scored[][]): Map<string, number>`
  - `adjustScores(fused: Map<string, number>, docsById: Map<string, {kind: string; sourceTs: string}>, now: Date): Scored[]`
  - `TAU` (number, exported constant `0.01`)

- [ ] **Step 1: Write the failing test**

```js
// gateway/test/rank.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tokenize, bm25Rank, cosineTopK, rrfFuse, adjustScores, TAU,
} from "../dist/gateway/src/rank.js";

test("tokenize lowercases, splits on non-alphanumerics, drops 1-char tokens", () => {
  assert.deepEqual(tokenize("Cursor's MCP-config, v2!"), [
    "cursor", "mcp", "config", "v2",
  ]);
});

test("bm25Rank: exact-term doc outranks unrelated docs (the Cursor miss)", () => {
  const docs = [
    { id: "old-cursor", body: "Cursor MCP config is project-scoped, not global — verified." },
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
  assert.deepEqual(ranked.map((r) => r.id), ["close", "far"]);
});

test("rrfFuse: doc present in both lists beats single-list docs", () => {
  const fused = rrfFuse([
    [{ id: "both", score: 9 }, { id: "onlyA", score: 8 }],
    [{ id: "both", score: 0.9 }, { id: "onlyB", score: 0.8 }],
  ]);
  assert.ok(fused.get("both") > fused.get("onlyA"));
  assert.ok(fused.get("both") > fused.get("onlyB"));
});

test("adjustScores: decisions get a boost; status decays with age", () => {
  const now = new Date("2026-07-08T00:00:00Z");
  const docsById = new Map([
    ["d", { kind: "decision", sourceTs: "2026-01-01T00:00:00Z" }],
    ["c", { kind: "context", sourceTs: "2026-01-01T00:00:00Z" }],
    ["s-old", { kind: "status", sourceTs: "2026-06-10T00:00:00Z" }], // 28d = 2 half-lives
    ["s-new", { kind: "status", sourceTs: "2026-07-08T00:00:00Z" }],
  ]);
  const fused = new Map([["d", 0.02], ["c", 0.02], ["s-old", 0.02], ["s-new", 0.02]]);
  const out = adjustScores(fused, docsById, now);
  const score = (id) => out.find((s) => s.id === id).score;
  assert.ok(score("d") > score("c")); // kind prior — an old decision does NOT decay
  assert.ok(Math.abs(score("s-old") - score("s-new") * 0.25) < 1e-9); // 2 half-lives
  assert.deepEqual(out.map((s) => s.id).slice(0, 1), ["d"]); // sorted desc
});

test("TAU is a small positive floor below a single-list top-1 RRF score", () => {
  assert.ok(TAU > 0 && TAU < 1 / 61);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npm run build; node --test test/rank.test.mjs`
Expected: FAIL — `Cannot find module '../dist/gateway/src/rank.js'`

- [ ] **Step 3: Write the implementation**

```ts
// gateway/src/rank.ts
/**
 * Pure scoring for the retrieval pipeline (§5 of the 2026-07-07 roadmap).
 * BM25 and cosine both run as exact scans in the Worker: a space holds
 * hundreds to low-thousands of docs, so exact scoring is single-digit ms and
 * needs no FTS5/ANN infrastructure (same rationale as §2.1's brute-force
 * cosine). Everything here is deterministic and dependency-free.
 */

export interface Scored {
  id: string;
  score: number;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const DEFAULT_TOP_K = 50;

export function bm25Rank(
  docs: { id: string; body: string }[],
  query: string,
  topK: number = DEFAULT_TOP_K,
): Scored[] {
  const qTerms = [...new Set(tokenize(query))];
  if (qTerms.length === 0 || docs.length === 0) return [];

  const docTokens = docs.map((d) => tokenize(d.body));
  const avgLen =
    docTokens.reduce((sum, t) => sum + t.length, 0) / docs.length || 1;

  const df = new Map<string, number>();
  for (const tokens of docTokens) {
    const seen = new Set(tokens);
    for (const q of qTerms) if (seen.has(q)) df.set(q, (df.get(q) ?? 0) + 1);
  }

  const scored: Scored[] = [];
  docs.forEach((d, i) => {
    const tokens = docTokens[i];
    const tf = new Map<string, number>();
    for (const t of tokens) {
      if (qTerms.includes(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
    }
    let score = 0;
    for (const q of qTerms) {
      const f = tf.get(q) ?? 0;
      if (f === 0) continue;
      const n = df.get(q) ?? 0;
      const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
      score +=
        (idf * f * (BM25_K1 + 1)) /
        (f + BM25_K1 * (1 - BM25_B + (BM25_B * tokens.length) / avgLen));
    }
    if (score > 0) scored.push({ id: d.id, score });
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, topK);
}

export function cosineTopK(
  docs: { id: string; embedding: number[] }[],
  queryVec: number[],
  topK: number = DEFAULT_TOP_K,
): Scored[] {
  const out: Scored[] = [];
  for (const d of docs) {
    if (queryVec.length === 0 || d.embedding.length !== queryVec.length)
      continue;
    let dot = 0;
    let a = 0;
    let b = 0;
    for (let i = 0; i < queryVec.length; i++) {
      dot += d.embedding[i] * queryVec[i];
      a += d.embedding[i] * d.embedding[i];
      b += queryVec[i] * queryVec[i];
    }
    if (a === 0 || b === 0) continue;
    out.push({ id: d.id, score: dot / Math.sqrt(a * b) });
  }
  return out.sort((x, y) => y.score - x.score).slice(0, topK);
}

const RRF_K = 60;

/** Reciprocal rank fusion: parameter-free, robust with zero training data (§5.2). */
export function rrfFuse(lists: Scored[][]): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    list.forEach((s, rank) => {
      fused.set(s.id, (fused.get(s.id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }
  return fused;
}

/**
 * Relevance floor on the adjusted score: candidates below τ are dropped even
 * when budget remains — returning nothing is a first-class outcome (§5.4).
 * Set below a single-generator top-1 RRF score (1/61 ≈ 0.0164) so an exact
 * keyword hit always survives; the single most important calibration target
 * once retrieval_log accumulates data (§7).
 */
export const TAU = 0.01;

const STATUS_HALF_LIFE_DAYS = 14;

/**
 * Kind priors (§5.3). Decisions/constraints do not decay by clock — only by
 * supersession (§4); status/question rot with a ~14-day half-life.
 */
const KIND_PRIOR: Record<string, number> = {
  decision: 1.2,
  constraint: 1.2,
  preference: 1.0,
  reference: 1.0,
  context: 1.0,
  status: 0.9,
  question: 0.9,
};

export function adjustScores(
  fused: Map<string, number>,
  docsById: Map<string, { kind: string; sourceTs: string }>,
  now: Date,
): Scored[] {
  const out: Scored[] = [];
  for (const [id, score] of fused) {
    const doc = docsById.get(id);
    if (!doc) continue;
    let s = score * (KIND_PRIOR[doc.kind] ?? 1.0);
    if (doc.kind === "status" || doc.kind === "question") {
      const ageMs = now.getTime() - Date.parse(doc.sourceTs);
      const ageDays = Number.isFinite(ageMs) ? Math.max(0, ageMs / 86_400_000) : 0;
      s *= Math.pow(0.5, ageDays / STATUS_HALF_LIFE_DAYS);
    }
    out.push({ id, score: s });
  }
  return out.sort((a, b) => b.score - a.score);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npm run build && node --test test/rank.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/rank.ts gateway/test/rank.test.mjs
git commit -m "feat(gateway): pure ranking functions — BM25, cosine, RRF, kind priors, tau"
```

---

### Task 2: Index store — types, in-memory impl, D1 impl, schema

**Files:**
- Create: `gateway/src/index-db.ts`
- Create: `gateway/migrations/0001_relevance_index.sql`
- Test: `gateway/test/index-db.test.mjs`

**Interfaces:**
- Produces (used by Tasks 3–8):

```ts
interface IndexedDoc {
  id: string; space: string; project: string; // project is already slugged
  kind: string; tier: string; body: string;
  sourceFile: string; sourceAuthor: string; sourceTs: string;
  embedding: number[]; supersededBy: string | null; createdAt: string;
}
interface RetrievalLogEntry {
  space: string; project: string; trigger: string; query: string;
  returned: { id: string; score: number }[]; injected: boolean; ts: string;
}
interface IndexDb {
  upsertDocs(docs: IndexedDoc[]): Promise<void>;
  listDocs(space: string, project?: string): Promise<IndexedDoc[]>; // live (unsuperseded) only
  getLastIndexedSha(space: string): Promise<string | null>;
  setLastIndexedSha(space: string, sha: string): Promise<void>;
  deleteSpace(space: string): Promise<void>;
  logRetrieval(rec: RetrievalLogEntry): Promise<void>;
}
class MemoryIndexDb implements IndexDb { readonly logged: RetrievalLogEntry[] }
interface D1Like { prepare(sql: string): D1Stmt; batch(stmts: D1Stmt[]): Promise<unknown> }
function d1IndexDb(db: D1Like): IndexDb
function encodeEmbedding(v: number[]): ArrayBuffer
function decodeEmbedding(b: ArrayBuffer | null): number[]
```

- [ ] **Step 1: Write the failing test**

```js
// gateway/test/index-db.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MemoryIndexDb, encodeEmbedding, decodeEmbedding, d1IndexDb,
} from "../dist/gateway/src/index-db.js";

function doc(overrides = {}) {
  return {
    id: "e1", space: "s1", project: "memorylayer", kind: "decision",
    tier: "normal", body: "Cursor MCP config is project-scoped.",
    sourceFile: "context/memorylayer/skanda/f.md", sourceAuthor: "Skanda",
    sourceTs: "2026-07-04T00:00:00Z", embedding: [0.1, 0.2],
    supersededBy: null, createdAt: "2026-07-08T00:00:00Z",
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
  assert.deepEqual((await db.listDocs("s1")).map((d) => d.id), ["e1"]);
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
    sql, params: [],
    bind(...values) { this.params = values; return this; },
    async run() { executed.push(this); return {}; },
    async all() {
      executed.push(this);
      return {
        results: [{
          id: "e1", space: "s1", project: "memorylayer", kind: "decision",
          tier: "normal", body: "b", source_file: "f.md", source_author: "A",
          source_ts: "2026-07-04T00:00:00Z",
          embedding: encodeEmbedding([0.5]), superseded_by: null,
          created_at: "2026-07-08T00:00:00Z",
        }],
      };
    },
    async first() { executed.push(this); return { last_indexed_sha: "abc" }; },
  });
  const fake = {
    prepare: (sql) => stmt(sql),
    async batch(stmts) { executed.push(...stmts); return []; },
  };
  const db = d1IndexDb(fake);

  await db.upsertDocs([doc()]);
  const upsert = executed.find((s) => /INSERT OR REPLACE INTO docs/i.test(s.sql));
  assert.ok(upsert);
  assert.equal(upsert.params[0], "e1");

  const rows = await db.listDocs("s1", "memorylayer");
  assert.deepEqual(rows[0].embedding, [0.5]);
  assert.equal(rows[0].sourceFile, "f.md");
  const list = executed.find((s) => /FROM docs/i.test(s.sql) && /superseded_by IS NULL/i.test(s.sql));
  assert.deepEqual(list.params, ["s1", "memorylayer"]);

  assert.equal(await db.getLastIndexedSha("s1"), "abc");
  await db.logRetrieval({
    space: "s1", project: "memorylayer", trigger: "mcp_read", query: "q",
    returned: [{ id: "e1", score: 0.5 }], injected: true, ts: "2026-07-08T00:00:00Z",
  });
  assert.ok(executed.some((s) => /INSERT INTO retrieval_log/i.test(s.sql)));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npm run build; node --test test/index-db.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// gateway/src/index-db.ts
/**
 * The disposable index (§2): derived entirely from the git ledger, deletable
 * and rebuildable with zero data loss. Phase A indexes one ledger entry as
 * one doc (naive per-entry indexing, §9 Phase A); Phase B replaces docs with
 * extracted atomic facts behind this same interface.
 *
 * IndexDb is a local structural interface (same pattern as KVStore in env.ts)
 * so handlers stay testable under node:test: production binds D1 via
 * d1IndexDb, tests use MemoryIndexDb.
 */

export interface IndexedDoc {
  id: string;
  space: string;
  project: string; // slugged
  kind: string; // Phase A: the entry type ("decision" | "context")
  tier: string; // Phase A: always "normal"; Phase B adds "canon"
  body: string;
  sourceFile: string;
  sourceAuthor: string;
  sourceTs: string;
  embedding: number[];
  supersededBy: string | null;
  createdAt: string;
}

export interface RetrievalLogEntry {
  space: string;
  project: string;
  trigger: string;
  query: string;
  returned: { id: string; score: number }[];
  injected: boolean;
  ts: string;
}

export interface IndexDb {
  upsertDocs(docs: IndexedDoc[]): Promise<void>;
  /** Live (unsuperseded) docs; project omitted = whole space. */
  listDocs(space: string, project?: string): Promise<IndexedDoc[]>;
  getLastIndexedSha(space: string): Promise<string | null>;
  setLastIndexedSha(space: string, sha: string): Promise<void>;
  deleteSpace(space: string): Promise<void>;
  logRetrieval(rec: RetrievalLogEntry): Promise<void>;
}

export class MemoryIndexDb implements IndexDb {
  private docs = new Map<string, IndexedDoc>();
  private shas = new Map<string, string>();
  readonly logged: RetrievalLogEntry[] = [];

  async upsertDocs(docs: IndexedDoc[]): Promise<void> {
    for (const d of docs) this.docs.set(`${d.space} ${d.id}`, d);
  }
  async listDocs(space: string, project?: string): Promise<IndexedDoc[]> {
    return [...this.docs.values()].filter(
      (d) =>
        d.space === space &&
        d.supersededBy === null &&
        (project === undefined || d.project === project),
    );
  }
  async getLastIndexedSha(space: string): Promise<string | null> {
    return this.shas.get(space) ?? null;
  }
  async setLastIndexedSha(space: string, sha: string): Promise<void> {
    this.shas.set(space, sha);
  }
  async deleteSpace(space: string): Promise<void> {
    for (const key of this.docs.keys()) {
      if (key.startsWith(`${space} `)) this.docs.delete(key);
    }
    this.shas.delete(space);
  }
  async logRetrieval(rec: RetrievalLogEntry): Promise<void> {
    this.logged.push(rec);
  }
}

/** Minimal structural surface of a D1 prepared statement / database. */
export interface D1Stmt {
  bind(...values: unknown[]): D1Stmt;
  run(): Promise<unknown>;
  all(): Promise<{ results: Record<string, unknown>[] }>;
  first(): Promise<Record<string, unknown> | null>;
}
export interface D1Like {
  prepare(sql: string): D1Stmt;
  batch(stmts: D1Stmt[]): Promise<unknown>;
}

export function encodeEmbedding(v: number[]): ArrayBuffer {
  return new Float32Array(v).buffer as ArrayBuffer;
}

export function decodeEmbedding(b: ArrayBuffer | null): number[] {
  if (!b || b.byteLength === 0) return [];
  return [...new Float32Array(b)];
}

const UPSERT_SQL =
  "INSERT OR REPLACE INTO docs (id, space, project, kind, tier, body, " +
  "source_file, source_author, source_ts, embedding, superseded_by, created_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

export function d1IndexDb(db: D1Like): IndexDb {
  return {
    async upsertDocs(docs) {
      if (docs.length === 0) return;
      await db.batch(
        docs.map((d) =>
          db
            .prepare(UPSERT_SQL)
            .bind(
              d.id, d.space, d.project, d.kind, d.tier, d.body,
              d.sourceFile, d.sourceAuthor, d.sourceTs,
              encodeEmbedding(d.embedding), d.supersededBy, d.createdAt,
            ),
        ),
      );
    },
    async listDocs(space, project) {
      const sql =
        "SELECT * FROM docs WHERE space = ? AND superseded_by IS NULL" +
        (project !== undefined ? " AND project = ?" : "");
      const stmt =
        project !== undefined
          ? db.prepare(sql).bind(space, project)
          : db.prepare(sql).bind(space);
      const { results } = await stmt.all();
      return results.map((r) => ({
        id: r.id as string,
        space: r.space as string,
        project: r.project as string,
        kind: r.kind as string,
        tier: r.tier as string,
        body: r.body as string,
        sourceFile: r.source_file as string,
        sourceAuthor: r.source_author as string,
        sourceTs: r.source_ts as string,
        embedding: decodeEmbedding(r.embedding as ArrayBuffer | null),
        supersededBy: (r.superseded_by as string | null) ?? null,
        createdAt: r.created_at as string,
      }));
    },
    async getLastIndexedSha(space) {
      const row = await db
        .prepare("SELECT last_indexed_sha FROM index_state WHERE space = ?")
        .bind(space)
        .first();
      return (row?.last_indexed_sha as string | undefined) ?? null;
    },
    async setLastIndexedSha(space, sha) {
      await db
        .prepare(
          "INSERT OR REPLACE INTO index_state (space, last_indexed_sha) VALUES (?, ?)",
        )
        .bind(space, sha)
        .run();
    },
    async deleteSpace(space) {
      await db.batch([
        db.prepare("DELETE FROM docs WHERE space = ?").bind(space),
        db.prepare("DELETE FROM index_state WHERE space = ?").bind(space),
      ]);
    },
    async logRetrieval(rec) {
      await db
        .prepare(
          "INSERT INTO retrieval_log (space, project, trigger_kind, query, returned, injected, ts) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          rec.space, rec.project, rec.trigger, rec.query,
          JSON.stringify(rec.returned), rec.injected ? 1 : 0, rec.ts,
        )
        .run();
    },
  };
}
```

```sql
-- gateway/migrations/0001_relevance_index.sql
-- Disposable index plane (roadmap §2/§4): derived from the git ledger,
-- rebuildable via POST /admin/reindex. Phase A: one row per ledger entry.
CREATE TABLE IF NOT EXISTS docs (
  id TEXT NOT NULL,
  space TEXT NOT NULL,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'normal',
  body TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_author TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  embedding BLOB,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (space, id)
);
CREATE INDEX IF NOT EXISTS docs_space_project ON docs (space, project);

CREATE TABLE IF NOT EXISTS index_state (
  space TEXT PRIMARY KEY,
  last_indexed_sha TEXT
);

CREATE TABLE IF NOT EXISTS retrieval_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space TEXT NOT NULL,
  project TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  query TEXT NOT NULL,
  returned TEXT NOT NULL,
  injected INTEGER NOT NULL,
  ts TEXT NOT NULL
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npm run build && node --test test/index-db.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/index-db.ts gateway/migrations/0001_relevance_index.sql gateway/test/index-db.test.mjs
git commit -m "feat(gateway): disposable index store — IndexDb interface, memory + D1 impls, D1 schema"
```

---

### Task 3: Retrieval pipeline orchestrator (`retrieval.ts`) + fake embedder test helper

**Files:**
- Create: `gateway/src/retrieval.ts`
- Modify: `gateway/test/helpers.mjs` (add `fakeEmbed`)
- Test: `gateway/test/retrieval.test.mjs`

**Interfaces:**
- Consumes: `IndexDb`, `IndexedDoc` (Task 2); `bm25Rank`, `cosineTopK`, `rrfFuse`, `adjustScores`, `TAU` (Task 1); `estimateTokens`, `ENTRY_OVERHEAD_TOKENS` from `../../src/token-budget.js`.
- Produces (used by Tasks 6–8):

```ts
type Embedder = (texts: string[]) => Promise<number[][]>;
interface RetrieveDeps { db: IndexDb; embed: Embedder | null }
interface RetrieveOpts {
  space: string; project?: string; query: string; budgetTokens: number;
  kinds?: string[]; trigger: string; now?: Date;
}
interface Retrieved { doc: IndexedDoc; score: number }
async function retrieve(deps: RetrieveDeps, opts: RetrieveOpts):
  Promise<{ results: Retrieved[]; total: number }>
function renderSearchResults(project: string | undefined, query: string,
  results: Retrieved[], total: number): string
```

- Test helper produced: `fakeEmbed(texts) => Promise<number[][]>` — deterministic 16-dim bag-of-hashed-tokens vectors, so texts sharing vocabulary have higher cosine.

- [ ] **Step 1: Add `fakeEmbed` to `gateway/test/helpers.mjs`**

Append to the existing file:

```js
/** Deterministic 16-dim embedding: token-hash bag, so shared vocabulary =>
 *  higher cosine. Good enough to exercise the vector path without a model. */
export async function fakeEmbed(texts) {
  return texts.map((text) => {
    const v = new Array(16).fill(0);
    for (const tok of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok.length < 2) continue;
      let h = 0;
      for (const c of tok) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      v[h % 16] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  });
}
```

- [ ] **Step 2: Write the failing test**

```js
// gateway/test/retrieval.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import { retrieve, renderSearchResults } from "../dist/gateway/src/retrieval.js";
import { fakeEmbed } from "./helpers.mjs";

function doc(id, body, overrides = {}) {
  return {
    id, space: "s1", project: "memorylayer", kind: "decision", tier: "normal",
    body, sourceFile: `context/memorylayer/skanda/${id}.md`,
    sourceAuthor: "Skanda", sourceTs: "2026-07-04T11:00:00Z",
    embedding: [], supersededBy: null, createdAt: "2026-07-08T00:00:00Z",
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
    doc("cursor-fact", "Cursor MCP config is project-scoped, not global — verified 2026-07-04.", {
      sourceTs: "2026-06-01T00:00:00Z",
    }),
    ...Array.from({ length: 45 }, (_, i) =>
      doc(`f${i}`, `gateway auth hardening step ${i} for hosted member tokens`, {
        sourceTs: "2026-07-07T00:00:00Z",
      }),
    ),
  ]);
  const { results, total } = await retrieve(
    { db, embed: fakeEmbed },
    { space: "s1", project: "memorylayer", query: "how is cursor mcp config scoped",
      budgetTokens: 4000, trigger: "test" },
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
    { space: "s1", project: "memorylayer", query: "index plane pilot spaces",
      budgetTokens: 4000, kinds: ["context"], trigger: "test" },
  );
  assert.deepEqual(results.map((r) => r.doc.id), ["c1"]);

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
    { space: "s1", project: "memorylayer", query: "zzqx unrelated nonsense",
      budgetTokens: 4000, trigger: "test" },
  );
  assert.deepEqual(results, []);
});

test("embedder failure fails open to BM25-only", async () => {
  const db = new MemoryIndexDb();
  await seed(db, [doc("cursor-fact", "Cursor MCP config is project-scoped.")]);
  const boom = async () => { throw new Error("model down"); };
  const { results } = await retrieve(
    { db, embed: boom },
    { space: "s1", project: "memorylayer", query: "cursor mcp config",
      budgetTokens: 4000, trigger: "test" },
  );
  assert.equal(results[0].doc.id, "cursor-fact");
});

test("budget packing keeps highest-scored results within budget (never zero)", async () => {
  const db = new MemoryIndexDb();
  const big = "cursor ".repeat(400); // ~700 tokens each
  await seed(db, [doc("a", big), doc("b", big), doc("c", big)]);
  const { results } = await retrieve(
    { db, embed: fakeEmbed },
    { space: "s1", project: "memorylayer", query: "cursor",
      budgetTokens: 800, trigger: "test" },
  );
  assert.equal(results.length, 1);
});

test("every retrieval is logged with trigger, query, scores, injected flag", async () => {
  const db = new MemoryIndexDb();
  await seed(db, [doc("cursor-fact", "Cursor MCP config is project-scoped.")]);
  await retrieve(
    { db, embed: fakeEmbed },
    { space: "s1", project: "memorylayer", query: "cursor config",
      budgetTokens: 4000, trigger: "search_memory" },
  );
  assert.equal(db.logged.length, 1);
  assert.equal(db.logged[0].trigger, "search_memory");
  assert.equal(db.logged[0].query, "cursor config");
  assert.equal(db.logged[0].injected, true);
  assert.equal(db.logged[0].returned[0].id, "cursor-fact");
  assert.ok(db.logged[0].returned[0].score > 0);
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd gateway && npm run build; node --test test/retrieval.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 4: Write the implementation**

```ts
// gateway/src/retrieval.ts
/**
 * The §5 pipeline, one code path for every trigger:
 * candidates (BM25 ∪ cosine) → RRF fusion → kind priors/decay → τ floor →
 * token-budget packing → render with provenance. Logs every run to
 * retrieval_log (§7) — the log is the training/calibration data every later
 * phase needs. No LLM on the read path (latency budget, §6).
 */
import type { IndexDb, IndexedDoc } from "./index-db.js";
import {
  bm25Rank, cosineTopK, rrfFuse, adjustScores, TAU, type Scored,
} from "./rank.js";
import {
  estimateTokens, ENTRY_OVERHEAD_TOKENS,
} from "../../src/token-budget.js";

export type Embedder = (texts: string[]) => Promise<number[][]>;

export interface RetrieveDeps {
  db: IndexDb;
  embed: Embedder | null;
}

export interface RetrieveOpts {
  space: string;
  project?: string;
  query: string;
  budgetTokens: number;
  kinds?: string[];
  trigger: string;
  now?: Date;
}

export interface Retrieved {
  doc: IndexedDoc;
  score: number;
}

export async function retrieve(
  deps: RetrieveDeps,
  opts: RetrieveOpts,
): Promise<{ results: Retrieved[]; total: number }> {
  let docs = await deps.db.listDocs(opts.space, opts.project);
  if (opts.kinds && opts.kinds.length > 0) {
    docs = docs.filter((d) => opts.kinds!.includes(d.kind));
  }
  if (docs.length === 0) return { results: [], total: 0 };

  const lists: Scored[][] = [bm25Rank(docs, opts.query)];
  if (deps.embed) {
    try {
      const [queryVec] = await deps.embed([opts.query]);
      lists.push(cosineTopK(docs, queryVec ?? []));
    } catch {
      // fail-open: BM25 alone still rescues exact-term matches (§5.1)
    }
  }

  const byId = new Map(docs.map((d) => [d.id, d]));
  const scored = adjustScores(rrfFuse(lists), byId, opts.now ?? new Date())
    .filter((s) => s.score >= TAU);

  const results: Retrieved[] = [];
  let used = 0;
  for (const s of scored) {
    const doc = byId.get(s.id)!;
    const cost = estimateTokens(doc.body) + ENTRY_OVERHEAD_TOKENS;
    if (results.length > 0 && used + cost > opts.budgetTokens) break;
    results.push({ doc, score: s.score });
    used += cost;
  }

  try {
    await deps.db.logRetrieval({
      space: opts.space,
      project: opts.project ?? "",
      trigger: opts.trigger,
      query: opts.query,
      returned: results.map((r) => ({ id: r.doc.id, score: r.score })),
      injected: results.length > 0,
      ts: new Date().toISOString(),
    });
  } catch {
    // logging must never break a read
  }

  return { results, total: docs.length };
}

/**
 * §5.6 rendering: grouped by kind, provenance on every block, wrapped by the
 * caller in the existing "data, not instructions" framing where injected.
 */
export function renderSearchResults(
  project: string | undefined,
  query: string,
  results: Retrieved[],
  total: number,
): string {
  const scope = project ? `project "${project}"` : "all projects in this space";
  if (results.length === 0) {
    return (
      `# Memory search: "${query}"\n\n` +
      `(no stored entries cleared the relevance bar in ${scope} — ` +
      `${total} indexed)`
    );
  }
  const header =
    `# Memory search: "${query}"\n\n` +
    `_${results.length} of ${total} indexed entries cleared the relevance bar ` +
    `in ${scope}, most relevant first._`;
  const kinds = [...new Set(results.map((r) => r.doc.kind))];
  const sections = kinds.map((kind) => {
    const blocks = results
      .filter((r) => r.doc.kind === kind)
      .map(
        (r) =>
          `## ${kind} — ${r.doc.sourceAuthor} — ${r.doc.sourceTs.slice(0, 10)}\n\n` +
          `${r.doc.body}\n\n_(source: ${r.doc.sourceFile})_`,
      );
    return blocks.join("\n\n");
  });
  return `${header}\n\n${sections.join("\n\n")}`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd gateway && npm run build && node --test test/retrieval.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add gateway/src/retrieval.ts gateway/test/retrieval.test.mjs gateway/test/helpers.mjs
git commit -m "feat(gateway): retrieval pipeline — fused BM25+cosine ranking, tau floor, budget pack, retrieval_log"
```

---

### Task 4: Ingest (`ingest.ts`)

**Files:**
- Create: `gateway/src/ingest.ts`
- Test: `gateway/test/ingest.test.mjs`

**Interfaces:**
- Consumes: `IndexDb`, `IndexedDoc` (Task 2); `Embedder` (Task 3); `parseEntry`, `ParsedEntry` from `../../src/frontmatter.js`; `slug` from `../../src/slug.js`; `installationToken` from `./github-auth.js`; `Env` from `./env.js`.
- Produces (used by Tasks 5–7):

```ts
interface SpaceRepo { space: string; installationId: number; owner: string; repo: string; branch: string }
function projectFromPath(path: string): string | null   // "context/<p>/**.md" -> "<p>"
function entryToDoc(space: string, project: string, entry: ParsedEntry, embedding: number[]): IndexedDoc
async function ingestEntries(db: IndexDb, embed: Embedder | null, space: string,
  project: string, entries: ParsedEntry[]): Promise<number>
async function ingestFiles(env: Env, db: IndexDb, embed: Embedder | null, sr: SpaceRepo,
  paths: string[], headSha: string, fetchImpl: typeof fetch): Promise<number>
async function reindexSpace(env: Env, db: IndexDb, embed: Embedder | null, sr: SpaceRepo,
  fetchImpl: typeof fetch): Promise<number>
```

Behavior notes to encode:
- `ingestEntries` embeds all bodies in one `embed()` call; on embed failure it stores empty vectors (BM25 still works — fail-open).
- `ingestFiles` fetches each path via the Contents API raw endpoint (same headers as `readEntries` in `github-store.ts`), parses, groups by `projectFromPath`, ingests per project, then `setLastIndexedSha(sr.space, headSha)`. Unparseable/missing files are skipped (per-entry fail-open, matching `readEntries`).
- `reindexSpace` gets the branch head sha via `GET /repos/{owner}/{repo}/commits/{branch}` (`.sha`), lists all `context/**.md` blobs via the recursive Trees API, calls `db.deleteSpace(sr.space)`, then `ingestFiles` with every path — this is the disposability guarantee (§2.3) and the backfill for the ~70 existing entries.

- [ ] **Step 1: Write the failing test**

```js
// gateway/test/ingest.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import {
  projectFromPath, entryToDoc, ingestEntries, ingestFiles, reindexSpace,
} from "../dist/gateway/src/ingest.js";
import { makeEnv, ghFetch, fakeEmbed } from "./helpers.mjs";

const SR = { space: "s1", installationId: 7, owner: "o", repo: "r", branch: "main" };

const entryMd = (project, body) =>
  `---\nauthor: Skanda\ntype: decision\ntimestamp: 2026-07-04T11:00:00Z\nid: abc123\nproject: ${project}\n---\n\n${body}\n`;

/** Routes shared by ingestFiles/reindexSpace tests: token + contents + tree + head. */
function ghRoutes(calls) {
  return ghFetch(calls, [
    ["/app/installations/", () =>
      Response.json({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" })],
    ["/commits/main", () => Response.json({ sha: "headsha" })],
    ["/git/trees/main", () =>
      Response.json({
        tree: [
          { path: "context/memorylayer/skanda/a.md", type: "blob" },
          { path: "context/other-proj/skanda/b.md", type: "blob" },
          { path: "README.md", type: "blob" },
        ],
      })],
    ["/contents/context/memorylayer/skanda/a.md", () =>
      new Response(entryMd("memorylayer", "Cursor MCP config is project-scoped."))],
    ["/contents/context/other-proj/skanda/b.md", () =>
      new Response(entryMd("other-proj", "Other project fact."))],
    ["/contents/context/memorylayer/skanda/broken.md", () =>
      new Response("not an entry at all")],
  ]);
}

test("projectFromPath extracts the project slug segment", () => {
  assert.equal(projectFromPath("context/memorylayer/skanda/x.md"), "memorylayer");
  assert.equal(projectFromPath("README.md"), null);
  assert.equal(projectFromPath("context/x/nope.txt"), null);
});

test("entryToDoc maps a parsed entry; falls back to file path when id missing", () => {
  const entry = { author: "A", type: "context", timestamp: "2026-01-01T00:00:00Z",
    id: "", payload: "body", file: "context/p/a/f.md" };
  const d = entryToDoc("s1", "My Proj", entry, [1]);
  assert.equal(d.id, "context/p/a/f.md");
  assert.equal(d.project, "my-proj"); // slugged
  assert.equal(d.kind, "context");
  assert.equal(d.tier, "normal");
  assert.equal(d.supersededBy, null);
});

test("ingestEntries embeds and upserts; embed failure stores empty vectors", async () => {
  const db = new MemoryIndexDb();
  const entry = { author: "A", type: "decision", timestamp: "2026-01-01T00:00:00Z",
    id: "e1", payload: "we picked D1", file: "context/p/a/f.md" };
  assert.equal(await ingestEntries(db, fakeEmbed, "s1", "p", [entry]), 1);
  assert.equal((await db.listDocs("s1", "p"))[0].embedding.length, 16);

  const db2 = new MemoryIndexDb();
  const boom = async () => { throw new Error("down"); };
  assert.equal(await ingestEntries(db2, boom, "s1", "p", [entry]), 1);
  assert.deepEqual((await db2.listDocs("s1", "p"))[0].embedding, []);
});

test("ingestFiles fetches, parses, skips junk, groups by project, records sha", async () => {
  const calls = [];
  const env = makeEnv(ghRoutes(calls));
  const db = new MemoryIndexDb();
  const n = await ingestFiles(env, db, fakeEmbed, SR, [
    "context/memorylayer/skanda/a.md",
    "context/other-proj/skanda/b.md",
    "context/memorylayer/skanda/broken.md",
    "README.md",
  ], "pushsha", env.githubFetch);
  assert.equal(n, 2);
  assert.equal((await db.listDocs("s1", "memorylayer")).length, 1);
  assert.equal((await db.listDocs("s1", "other-proj")).length, 1);
  assert.equal(await db.getLastIndexedSha("s1"), "pushsha");
});

test("reindexSpace wipes the space and rebuilds from the full tree", async () => {
  const calls = [];
  const env = makeEnv(ghRoutes(calls));
  const db = new MemoryIndexDb();
  await db.upsertDocs([{
    id: "stale", space: "s1", project: "memorylayer", kind: "decision",
    tier: "normal", body: "stale", sourceFile: "x", sourceAuthor: "x",
    sourceTs: "2026-01-01T00:00:00Z", embedding: [], supersededBy: null,
    createdAt: "2026-01-01T00:00:00Z",
  }]);
  const n = await reindexSpace(env, db, fakeEmbed, SR, env.githubFetch);
  assert.equal(n, 2);
  const ids = (await db.listDocs("s1")).map((d) => d.id);
  assert.ok(!ids.includes("stale"));
  assert.equal(await db.getLastIndexedSha("s1"), "headsha");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npm run build; node --test test/ingest.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// gateway/src/ingest.ts
/**
 * Index ingest (§2): the ledger is the source of truth; these functions
 * derive index docs from it. Three callers: inline gateway writes (mcp.ts),
 * the push webhook (webhook.ts), and reindex/reconcile (reindex.ts).
 * Phase A is naive per-entry indexing — one ledger entry = one doc; Phase B
 * swaps LLM fact extraction into ingestEntries without touching callers.
 */
import { parseEntry, type ParsedEntry } from "../../src/frontmatter.js";
import { slug } from "../../src/slug.js";
import { installationToken } from "./github-auth.js";
import type { Env } from "./env.js";
import type { IndexDb, IndexedDoc } from "./index-db.js";
import type { Embedder } from "./retrieval.js";

const GH = "https://api.github.com";

export interface SpaceRepo {
  space: string;
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
}

function ghHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "memorylayer-gateway",
    "x-github-api-version": "2022-11-28",
  };
}

/** "context/<project>/**.md" -> "<project>", else null. */
export function projectFromPath(path: string): string | null {
  const m = path.match(/^context\/([^/]+)\/.+\.md$/);
  return m ? m[1] : null;
}

export function entryToDoc(
  space: string,
  project: string,
  entry: ParsedEntry,
  embedding: number[],
): IndexedDoc {
  return {
    id: entry.id || entry.file,
    space,
    project: slug(project),
    kind: entry.type,
    tier: "normal",
    body: entry.payload,
    sourceFile: entry.file,
    sourceAuthor: entry.author,
    sourceTs: entry.timestamp,
    embedding,
    supersededBy: null,
    createdAt: new Date().toISOString(),
  };
}

export async function ingestEntries(
  db: IndexDb,
  embed: Embedder | null,
  space: string,
  project: string,
  entries: ParsedEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  let vecs: number[][] = entries.map(() => []);
  if (embed) {
    try {
      vecs = await embed(entries.map((e) => e.payload));
    } catch {
      // fail-open: index without vectors — BM25 still serves recall
    }
  }
  await db.upsertDocs(
    entries.map((e, i) => entryToDoc(space, project, e, vecs[i] ?? [])),
  );
  return entries.length;
}

/**
 * Fetch + parse the given ledger paths and ingest them, then advance the
 * space's indexed sha. Non-entry/missing files are skipped, matching the
 * per-entry tolerance of readEntries.
 */
export async function ingestFiles(
  env: Env,
  db: IndexDb,
  embed: Embedder | null,
  sr: SpaceRepo,
  paths: string[],
  headSha: string,
  fetchImpl: typeof fetch,
): Promise<number> {
  const relevant = paths.filter((p) => projectFromPath(p) !== null);
  let count = 0;
  if (relevant.length > 0) {
    const token = await installationToken(env, sr.installationId, fetchImpl);
    const byProject = new Map<string, ParsedEntry[]>();
    for (const path of relevant) {
      const res = await fetchImpl(
        `${GH}/repos/${sr.owner}/${sr.repo}/contents/${path}?ref=${sr.branch}`,
        { headers: { ...ghHeaders(token), accept: "application/vnd.github.raw+json" } },
      );
      if (!res.ok) continue;
      const parsed = parseEntry(await res.text(), path);
      if (!parsed) continue;
      const project = projectFromPath(path)!;
      const list = byProject.get(project) ?? [];
      list.push(parsed);
      byProject.set(project, list);
    }
    for (const [project, entries] of byProject) {
      count += await ingestEntries(db, embed, sr.space, project, entries);
    }
  }
  await db.setLastIndexedSha(sr.space, headSha);
  return count;
}

/**
 * Rebuild a space's index from the ledger from scratch — the disposability
 * guarantee (§2.3), and the one-time backfill of pre-existing entries.
 */
export async function reindexSpace(
  env: Env,
  db: IndexDb,
  embed: Embedder | null,
  sr: SpaceRepo,
  fetchImpl: typeof fetch,
): Promise<number> {
  const token = await installationToken(env, sr.installationId, fetchImpl);
  const headRes = await fetchImpl(
    `${GH}/repos/${sr.owner}/${sr.repo}/commits/${sr.branch}`,
    { headers: ghHeaders(token) },
  );
  if (!headRes.ok) throw new Error(`head read failed: ${headRes.status}`);
  const { sha } = (await headRes.json()) as { sha: string };

  const treeRes = await fetchImpl(
    `${GH}/repos/${sr.owner}/${sr.repo}/git/trees/${sr.branch}?recursive=1`,
    { headers: ghHeaders(token) },
  );
  if (!treeRes.ok) throw new Error(`tree read failed: ${treeRes.status}`);
  const tree = (await treeRes.json()) as { tree: { path: string; type: string }[] };
  const paths = tree.tree
    .filter((t) => t.type === "blob" && projectFromPath(t.path) !== null)
    .map((t) => t.path);

  await db.deleteSpace(sr.space);
  return ingestFiles(env, db, embed, sr, paths, sha, fetchImpl);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npm run build && node --test test/ingest.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/ingest.ts gateway/test/ingest.test.mjs
git commit -m "feat(gateway): ledger ingest — per-entry indexing, file/diff ingest, full space reindex"
```

---

### Task 5: Bindings, deps resolver, space-repo registry, webhook, reindex/cron, router/worker wiring

**Files:**
- Modify: `gateway/src/env.ts`, `gateway/src/worker.ts`, `gateway/src/router.ts`, `gateway/src/tenancy.ts`
- Create: `gateway/src/deps.ts`, `gateway/src/webhook.ts`, `gateway/src/reindex.ts`
- Modify: `gateway/test/helpers.mjs` (makeEnv gains `indexDb`/`embedder`/`WEBHOOK_SECRET`), `gateway/test/tenancy.test.mjs`
- Test: `gateway/test/webhook.test.mjs`, `gateway/test/reindex.test.mjs`

**Interfaces:**
- Consumes: Tasks 2–4 exports.
- Produces:

```ts
// env.ts additions
interface AiBinding { run(model: string, input: { text: string[] }): Promise<{ data: number[][] }> }
Env += { DB?: D1Like; AI?: AiBinding; WEBHOOK_SECRET?: string;
         indexDb?: IndexDb; embedder?: Embedder }   // last two: test seams
// deps.ts
function indexDeps(env: Env): { db: IndexDb; embed: Embedder | null } | null
const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5"
// tenancy.ts additions
async function registerSpaceRepo(env: Env, sr: SpaceRepo): Promise<void>
async function getSpaceRepo(env: Env, fullName: string): Promise<SpaceRepo | null>
async function listSpaceRepos(env: Env): Promise<SpaceRepo[]>
// webhook.ts
async function verifyGithubSignature(secret: string, body: string, sigHeader: string | null): Promise<boolean>
async function handleWebhook(req: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response>
// reindex.ts
async function handleAdminReindex(req: Request, env: Env): Promise<Response>
async function reconcileAll(env: Env): Promise<void>
// router.ts
handleRequest(req, env, ctx?) — new routes: POST /webhook/github, POST /admin/reindex, GET /api/read (Task 7)
// worker.ts — fetch passes ctx; scheduled() runs reconcileAll via ctx.waitUntil
```

- [ ] **Step 1: Modify `gateway/src/env.ts`**

Append to the existing file (keep `KVStore` and existing `Env` fields):

```ts
import type { D1Like, IndexDb } from "./index-db.js";
import type { Embedder } from "./retrieval.js";

/** Minimal Workers AI surface used for embeddings. */
export interface AiBinding {
  run(model: string, input: { text: string[] }): Promise<{ data: number[][] }>;
}
```

and extend the `Env` interface with:

```ts
  /** D1 index database. Optional: absent = index plane disabled, recency reads only. */
  DB?: D1Like;
  /** Workers AI binding for embeddings. Optional: absent = BM25-only retrieval. */
  AI?: AiBinding;
  /** GitHub App webhook secret for POST /webhook/github signature checks. */
  WEBHOOK_SECRET?: string;
  /** Test seams: injected index store / embedder. Production leaves unset. */
  indexDb?: IndexDb;
  embedder?: Embedder;
```

- [ ] **Step 2: Create `gateway/src/deps.ts`**

```ts
// gateway/src/deps.ts
/**
 * Resolve the index plane's dependencies from bindings (production) or test
 * seams. Null means "no index configured" — every caller must fall back to
 * the recency path (fail-open invariant).
 */
import type { Env } from "./env.js";
import { d1IndexDb, type IndexDb } from "./index-db.js";
import type { Embedder } from "./retrieval.js";

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";

export function indexDeps(
  env: Env,
): { db: IndexDb; embed: Embedder | null } | null {
  const db = env.indexDb ?? (env.DB ? d1IndexDb(env.DB) : null);
  if (!db) return null;
  const embed =
    env.embedder ??
    (env.AI
      ? async (texts: string[]) =>
          (await env.AI!.run(EMBED_MODEL, { text: texts })).data
      : null);
  return { db, embed };
}
```

- [ ] **Step 3: Add the space-repo registry to `gateway/src/tenancy.ts`**

Add after `handleAdminAddMember`'s imports section:

```ts
import type { SpaceRepo } from "./ingest.js";

/** Single-key registry mapping "owner/repo" -> SpaceRepo, maintained on
 *  member mint. Powers webhook repo->space lookup and cron reconciliation.
 *  One JSON blob is fine at pilot scale (a handful of spaces). */
const REGISTRY_KEY = "spaces:registry";

export async function registerSpaceRepo(env: Env, sr: SpaceRepo): Promise<void> {
  const raw = await env.ROUTING.get(REGISTRY_KEY);
  const reg = raw ? (JSON.parse(raw) as Record<string, SpaceRepo>) : {};
  reg[`${sr.owner}/${sr.repo}`] = sr;
  await env.ROUTING.put(REGISTRY_KEY, JSON.stringify(reg));
}

export async function getSpaceRepo(
  env: Env,
  fullName: string,
): Promise<SpaceRepo | null> {
  const raw = await env.ROUTING.get(REGISTRY_KEY);
  if (!raw) return null;
  return (JSON.parse(raw) as Record<string, SpaceRepo>)[fullName] ?? null;
}

export async function listSpaceRepos(env: Env): Promise<SpaceRepo[]> {
  const raw = await env.ROUTING.get(REGISTRY_KEY);
  return raw ? Object.values(JSON.parse(raw) as Record<string, SpaceRepo>) : [];
}
```

In `handleAdminAddMember`, after the existing `env.ROUTING.put("member:...")` call and before the return, add:

```ts
  await registerSpaceRepo(env, {
    space: member.space,
    installationId: member.installationId,
    owner: member.owner,
    repo: member.repo,
    branch: member.branch,
  });
```

Add to `gateway/test/tenancy.test.mjs` (imports: `getSpaceRepo` from `../dist/gateway/src/tenancy.js`):

```js
test("minting a member registers its repo in the spaces registry", async () => {
  const env = makeEnv();
  const res = await handleAdminAddMember(
    new Request("https://gw/admin/members", {
      method: "POST",
      headers: { "x-admin-secret": "test-admin-secret" },
      body: JSON.stringify({
        space: "s1", installationId: 7, owner: "o", repo: "r",
        author: "A", authorEmail: "a@x.com",
      }),
    }),
    env,
  );
  assert.equal(res.status, 200);
  const sr = await getSpaceRepo(env, "o/r");
  assert.deepEqual(sr, {
    space: "s1", installationId: 7, owner: "o", repo: "r", branch: "main",
  });
});
```

(Match the existing test file's import style and admin-secret constant; adjust the assertion setup to mirror how that file already builds admin requests.)

- [ ] **Step 4: Update `gateway/test/helpers.mjs` `makeEnv`**

Change `makeEnv` to accept and pass through index seams:

```js
/** Env with a FakeKV and the test keypair; pass a mock fetch for GitHub calls.
 *  extra: { indexDb, embedder, WEBHOOK_SECRET, ... } merged onto the env. */
export function makeEnv(githubFetch, extra = {}) {
  return {
    ROUTING: new FakeKV(),
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: TEST_KEYPAIR.pem,
    ADMIN_SECRET: "test-admin-secret",
    githubFetch,
    ...extra,
  };
}
```

- [ ] **Step 5: Write the failing webhook test**

```js
// gateway/test/webhook.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import { verifyGithubSignature, handleWebhook } from "../dist/gateway/src/webhook.js";
import { registerSpaceRepo } from "../dist/gateway/src/tenancy.js";
import { makeEnv, ghFetch, fakeEmbed } from "./helpers.mjs";

const SECRET = "hooksecret";
const sign = (body) =>
  "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");

const entryMd =
  "---\nauthor: Skanda\ntype: decision\ntimestamp: 2026-07-08T00:00:00Z\nid: web1\nproject: memorylayer\n---\n\nwebhook-ingested decision\n";

function pushEnv(indexDb) {
  const calls = [];
  const env = makeEnv(
    ghFetch(calls, [
      ["/app/installations/", () =>
        Response.json({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" })],
      ["/contents/context/memorylayer/skanda/new.md", () => new Response(entryMd)],
    ]),
    { WEBHOOK_SECRET: SECRET, indexDb, embedder: fakeEmbed },
  );
  return env;
}

function pushReq(payload, { badSig = false, event = "push" } = {}) {
  const body = JSON.stringify(payload);
  return new Request("https://gw/webhook/github", {
    method: "POST",
    headers: {
      "x-hub-signature-256": badSig ? "sha256=" + "0".repeat(64) : sign(body),
      "x-github-event": event,
    },
    body,
  });
}

const PAYLOAD = {
  ref: "refs/heads/main",
  after: "pushsha",
  repository: { full_name: "o/r" },
  commits: [
    { added: ["context/memorylayer/skanda/new.md"], modified: [], removed: [] },
  ],
};

test("verifyGithubSignature accepts a valid HMAC and rejects a forged one", async () => {
  const body = JSON.stringify(PAYLOAD);
  assert.equal(await verifyGithubSignature(SECRET, body, sign(body)), true);
  assert.equal(await verifyGithubSignature(SECRET, body, "sha256=" + "0".repeat(64)), false);
  assert.equal(await verifyGithubSignature(SECRET, body, null), false);
});

test("push webhook ingests new ledger files for a registered repo", async () => {
  const db = new MemoryIndexDb();
  const env = pushEnv(db);
  await registerSpaceRepo(env, {
    space: "s1", installationId: 7, owner: "o", repo: "r", branch: "main",
  });
  const res = await handleWebhook(pushReq(PAYLOAD), env);
  assert.equal(res.status, 200);
  const docs = await db.listDocs("s1", "memorylayer");
  assert.equal(docs.length, 1);
  assert.equal(docs[0].body, "webhook-ingested decision");
  assert.equal(await db.getLastIndexedSha("s1"), "pushsha");
});

test("webhook rejects bad signatures; ignores non-push, unknown repos, other branches", async () => {
  const db = new MemoryIndexDb();
  const env = pushEnv(db);
  await registerSpaceRepo(env, {
    space: "s1", installationId: 7, owner: "o", repo: "r", branch: "main",
  });
  assert.equal((await handleWebhook(pushReq(PAYLOAD, { badSig: true }), env)).status, 401);
  assert.equal((await handleWebhook(pushReq(PAYLOAD, { event: "ping" }), env)).status, 200);
  const other = { ...PAYLOAD, repository: { full_name: "o/unknown" } };
  assert.equal((await handleWebhook(pushReq(other), env)).status, 200);
  const branch = { ...PAYLOAD, ref: "refs/heads/dev" };
  assert.equal((await handleWebhook(pushReq(branch), env)).status, 200);
  assert.deepEqual(await db.listDocs("s1"), []); // none of those ingested
});
```

- [ ] **Step 6: Run webhook test to verify it fails**

Run: `cd gateway && npm run build; node --test test/webhook.test.mjs`
Expected: FAIL — module not found

- [ ] **Step 7: Create `gateway/src/webhook.ts`**

```ts
// gateway/src/webhook.ts
/**
 * POST /webhook/github — GitHub App push webhook, the ingest path for
 * local-plane writes (§2): a member's `git push` lands here seconds later and
 * updates the one remote index. Signature-checked (HMAC SHA-256), branch- and
 * repo-filtered via the spaces registry, fail-open: every non-error outcome
 * is a 2xx so GitHub does not retry-storm, and ingest failures are swallowed
 * (the cron reconciler catches them via last_indexed_sha drift).
 */
import type { Env } from "./env.js";
import { getSpaceRepo } from "./tenancy.js";
import { indexDeps } from "./deps.js";
import { ingestFiles } from "./ingest.js";

export async function verifyGithubSignature(
  secret: string,
  body: string,
  sigHeader: string | null,
): Promise<boolean> {
  if (!sigHeader?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const given = sigHeader.slice("sha256=".length).toLowerCase();
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  }
  return diff === 0;
}

interface PushPayload {
  ref?: string;
  after?: string;
  repository?: { full_name?: string };
  commits?: { added?: string[]; modified?: string[] }[];
}

export async function handleWebhook(
  req: Request,
  env: Env,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  const body = await req.text();
  if (
    !env.WEBHOOK_SECRET ||
    !(await verifyGithubSignature(
      env.WEBHOOK_SECRET,
      body,
      req.headers.get("x-hub-signature-256"),
    ))
  ) {
    return new Response("bad signature", { status: 401 });
  }
  if (req.headers.get("x-github-event") !== "push") {
    return new Response("ignored event", { status: 200 });
  }

  let payload: PushPayload;
  try {
    payload = JSON.parse(body) as PushPayload;
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  const fullName = payload.repository?.full_name ?? "";
  const sr = await getSpaceRepo(env, fullName);
  if (!sr) return new Response("unknown repo", { status: 200 });
  if (payload.ref !== `refs/heads/${sr.branch}`) {
    return new Response("ignored ref", { status: 200 });
  }
  const deps = indexDeps(env);
  if (!deps || !payload.after) {
    return new Response("index disabled", { status: 200 });
  }

  const paths = [
    ...new Set(
      (payload.commits ?? []).flatMap((c) => [
        ...(c.added ?? []),
        ...(c.modified ?? []),
      ]),
    ),
  ];
  const work = ingestFiles(
    env, deps.db, deps.embed, sr, paths, payload.after,
    env.githubFetch ?? fetch,
  ).catch(() => {
    // swallowed: reconcile cron detects the sha gap and reindexes
  });
  if (ctx) {
    ctx.waitUntil(work);
    return new Response("accepted", { status: 202 });
  }
  await work;
  return new Response("ok", { status: 200 });
}
```

- [ ] **Step 8: Write the failing reindex/reconcile test**

```js
// gateway/test/reindex.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import { handleAdminReindex, reconcileAll } from "../dist/gateway/src/reindex.js";
import { registerSpaceRepo } from "../dist/gateway/src/tenancy.js";
import { makeEnv, ghFetch, fakeEmbed } from "./helpers.mjs";

const entryMd =
  "---\nauthor: Skanda\ntype: decision\ntimestamp: 2026-07-04T00:00:00Z\nid: abc\nproject: memorylayer\n---\n\na decision\n";

function envWith(indexDb) {
  const calls = [];
  const env = makeEnv(
    ghFetch(calls, [
      ["/app/installations/", () =>
        Response.json({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" })],
      ["/commits/main", () => Response.json({ sha: "headsha" })],
      ["/git/trees/main", () =>
        Response.json({ tree: [
          { path: "context/memorylayer/skanda/a.md", type: "blob" },
        ] })],
      ["/contents/context/memorylayer/skanda/a.md", () => new Response(entryMd)],
    ]),
    { indexDb, embedder: fakeEmbed },
  );
  return env;
}

test("POST /admin/reindex requires the admin secret and rebuilds registered spaces", async () => {
  const db = new MemoryIndexDb();
  const env = envWith(db);
  await registerSpaceRepo(env, {
    space: "s1", installationId: 7, owner: "o", repo: "r", branch: "main",
  });
  const forbidden = await handleAdminReindex(
    new Request("https://gw/admin/reindex", { method: "POST", body: "{}" }),
    env,
  );
  assert.equal(forbidden.status, 403);

  const res = await handleAdminReindex(
    new Request("https://gw/admin/reindex", {
      method: "POST",
      headers: { "x-admin-secret": "test-admin-secret" },
      body: JSON.stringify({}),
    }),
    env,
  );
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out, { reindexed: { s1: 1 } });
  assert.equal((await db.listDocs("s1", "memorylayer")).length, 1);
});

test("reconcileAll reindexes only spaces whose indexed sha lags HEAD", async () => {
  const db = new MemoryIndexDb();
  const env = envWith(db);
  await registerSpaceRepo(env, {
    space: "s1", installationId: 7, owner: "o", repo: "r", branch: "main",
  });
  await db.setLastIndexedSha("s1", "headsha"); // already current
  await reconcileAll(env);
  assert.equal((await db.listDocs("s1")).length, 0); // untouched

  await db.setLastIndexedSha("s1", "stalesha");
  await reconcileAll(env);
  assert.equal((await db.listDocs("s1", "memorylayer")).length, 1);
});
```

- [ ] **Step 9: Create `gateway/src/reindex.ts`**

```ts
// gateway/src/reindex.ts
/**
 * Reindex + reconciliation: POST /admin/reindex rebuilds spaces from the
 * ledger on demand (disposability, §2.3); reconcileAll runs on the cron
 * trigger and catches dropped webhooks by comparing each space's HEAD commit
 * to last_indexed_sha (§2.1 — no Queues, cron bounds divergence). At pilot
 * corpus size a blunt full reindex on drift is cheaper than diffing.
 */
import type { Env } from "./env.js";
import { listSpaceRepos } from "./tenancy.js";
import { indexDeps } from "./deps.js";
import { reindexSpace, type SpaceRepo } from "./ingest.js";
import { installationToken } from "./github-auth.js";

const GH = "https://api.github.com";

export async function handleAdminReindex(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const deps = indexDeps(env);
  if (!deps) return Response.json({ error: "index disabled" }, { status: 503 });

  let body: { repo?: string };
  try {
    body = (await req.json()) as { repo?: string };
  } catch {
    body = {};
  }
  const repos = (await listSpaceRepos(env)).filter(
    (sr) => !body.repo || `${sr.owner}/${sr.repo}` === body.repo,
  );
  const reindexed: Record<string, number> = {};
  for (const sr of repos) {
    reindexed[sr.space] = await reindexSpace(
      env, deps.db, deps.embed, sr, env.githubFetch ?? fetch,
    );
  }
  return Response.json({ reindexed });
}

async function headSha(
  env: Env,
  sr: SpaceRepo,
  fetchImpl: typeof fetch,
): Promise<string | null> {
  try {
    const token = await installationToken(env, sr.installationId, fetchImpl);
    const res = await fetchImpl(
      `${GH}/repos/${sr.owner}/${sr.repo}/commits/${sr.branch}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "memorylayer-gateway",
          "x-github-api-version": "2022-11-28",
        },
      },
    );
    if (!res.ok) return null;
    return ((await res.json()) as { sha: string }).sha;
  } catch {
    return null;
  }
}

export async function reconcileAll(env: Env): Promise<void> {
  const deps = indexDeps(env);
  if (!deps) return;
  const fetchImpl = env.githubFetch ?? fetch;
  for (const sr of await listSpaceRepos(env)) {
    try {
      const head = await headSha(env, sr, fetchImpl);
      if (!head) continue;
      const indexed = await deps.db.getLastIndexedSha(sr.space);
      if (indexed === head) continue;
      await reindexSpace(env, deps.db, deps.embed, sr, fetchImpl);
    } catch {
      // fail-open per space; next cron tick retries
    }
  }
}
```

- [ ] **Step 10: Wire router and worker**

`gateway/src/router.ts` — change the signature and add routes:

```ts
import type { Env } from "./env.js";
import { handleAdminAddMember } from "./tenancy.js";
import { handleMcp } from "./mcp.js";
import { handleHookRead } from "./hook-read.js";
import { handleWebhook } from "./webhook.js";
import { handleAdminReindex } from "./reindex.js";
import { handleApiRead } from "./api-read.js";

/** Path routing only — each route's logic lives in its own module. */
export async function handleRequest(
  req: Request,
  env: Env,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json({ ok: true });
  }

  if (url.pathname === "/admin/members" && req.method === "POST") {
    return handleAdminAddMember(req, env);
  }

  if (url.pathname === "/admin/reindex" && req.method === "POST") {
    return handleAdminReindex(req, env);
  }

  if (url.pathname === "/webhook/github" && req.method === "POST") {
    return handleWebhook(req, env, ctx);
  }

  // `/mcp` (token in header/query) or `/mcp/<token>` (token in path, for
  // header-less clients like ChatGPT's connector).
  if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
    if (req.method === "POST") return handleMcp(req, env);
    return new Response("stateless server: POST one JSON-RPC message", {
      status: 405,
    });
  }

  if (url.pathname === "/hook/read" && req.method === "GET") {
    return handleHookRead(req, env);
  }

  if (url.pathname === "/api/read" && req.method === "GET") {
    return handleApiRead(req, env);
  }

  return new Response("not found", { status: 404 });
}
```

(NOTE: `handleApiRead` is created in Task 7. To keep Task 5 independently buildable, add the `/api/read` route and import in Task 7 instead — leave them out here.)

`gateway/src/worker.ts`:

```ts
import { handleRequest } from "./router.js";
import { reconcileAll } from "./reindex.js";
import type { Env } from "./env.js";

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

export default {
  fetch(req: Request, env: Env, ctx?: Ctx): Promise<Response> {
    return handleRequest(req, env, ctx);
  },
  /** Cron reconciler: catches dropped webhooks by sha drift (§2.1). */
  scheduled(_event: unknown, env: Env, ctx: Ctx): void {
    ctx.waitUntil(reconcileAll(env));
  },
};
```

- [ ] **Step 11: Run all gateway tests**

Run: `cd gateway && npm test`
Expected: PASS — all existing + rank/index-db/retrieval/ingest/webhook/reindex/tenancy suites

- [ ] **Step 12: Commit**

```bash
git add gateway/src gateway/test
git commit -m "feat(gateway): index bindings, spaces registry, push webhook ingest, admin reindex + cron reconcile"
```

---

### Task 6: MCP surface — `read_context` query param, `search_memory` tool, inline write ingest

**Files:**
- Modify: `gateway/src/mcp.ts`
- Modify: `gateway/test/mcp.test.mjs`

**Interfaces:**
- Consumes: `indexDeps` (Task 5), `retrieve`/`renderSearchResults` (Task 3), `ingestEntries` (Task 4), `DEFAULT_BUDGET_TOKENS`.
- Produces: MCP tool contract changes mirrored by the local plane in Task 8:
  - `read_context` gains optional `query` (string): when set and the index is available, returns relevance-ranked results; otherwise falls back to the recency read.
  - New tool `search_memory` — args: `query` (string, required), `project` (string, optional: omitted = whole space), `kinds` (array of `"decision" | "context"`, optional).
  - `write_context` ingests the written entry inline (await, fail-open) so read-your-own-writes holds on the hosted plane (§2.3).

- [ ] **Step 1: Write the failing tests** (append to `gateway/test/mcp.test.mjs`, reusing its existing helpers for minting members and posting rpc; the snippets below show the assertions to add — adapt the member/token setup lines to the file's existing pattern)

```js
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import { fakeEmbed } from "./helpers.mjs";

// ... inside the file's describe/setup pattern:

test("read_context with query returns ranked matches from the index", async () => {
  const indexDb = new MemoryIndexDb();
  await indexDb.upsertDocs([{
    id: "cursor-fact", space: "s1", project: "memorylayer", kind: "decision",
    tier: "normal", body: "Cursor MCP config is project-scoped, not global.",
    sourceFile: "context/memorylayer/skanda/a.md", sourceAuthor: "Skanda",
    sourceTs: "2026-06-01T00:00:00Z",
    embedding: (await fakeEmbed(["Cursor MCP config is project-scoped, not global."]))[0],
    supersededBy: null, createdAt: "2026-07-08T00:00:00Z",
  }]);
  // env built with makeEnv(<gh mock>, { indexDb, embedder: fakeEmbed });
  // member minted for space "s1" per this file's existing setup
  const res = await rpc("tools/call", {
    name: "read_context",
    arguments: { project: "memorylayer", query: "cursor mcp config" },
  });
  const text = res.result.content[0].text;
  assert.match(text, /Memory search: "cursor mcp config"/);
  assert.match(text, /project-scoped/);
  assert.equal(indexDb.logged[0].trigger, "mcp_read");
});

test("read_context with query but no index falls back to the recency read", async () => {
  // env with NO indexDb/DB — same GitHub tree mocks the existing read tests use
  const res = await rpc("tools/call", {
    name: "read_context",
    arguments: { project: "memorylayer", query: "cursor" },
  });
  assert.match(res.result.content[0].text, /# Shared context: memorylayer/);
});

test("search_memory searches the space, honors kinds, and requires query", async () => {
  // env with indexDb seeded as above plus a context-kind doc in project "other"
  const res = await rpc("tools/call", {
    name: "search_memory",
    arguments: { query: "cursor mcp config" }, // no project: whole space
  });
  assert.match(res.result.content[0].text, /project-scoped/);

  const missing = await rpc("tools/call", { name: "search_memory", arguments: {} });
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /missing required argument: query/);
});

test("tools/list advertises search_memory and read_context.query", async () => {
  const res = await rpc("tools/list", {});
  const names = res.result.tools.map((t) => t.name);
  assert.ok(names.includes("search_memory"));
  const rc = res.result.tools.find((t) => t.name === "read_context");
  assert.ok(rc.inputSchema.properties.query);
});

test("write_context ingests the new entry inline so it is immediately searchable", async () => {
  const indexDb = new MemoryIndexDb();
  // env with indexDb + embedder + the existing write-path GitHub mocks
  await rpc("tools/call", {
    name: "write_context",
    arguments: { project: "memorylayer", payload: "We moved retrieval server-side." },
  });
  const docs = await indexDb.listDocs("s1", "memorylayer");
  assert.equal(docs.length, 1);
  assert.equal(docs[0].body, "We moved retrieval server-side.");
});
```

- [ ] **Step 2: Run to verify failures**

Run: `cd gateway && npm run build; node --test test/mcp.test.mjs`
Expected: new tests FAIL (unknown tool / no query property / no ingest)

- [ ] **Step 3: Implement in `gateway/src/mcp.ts`**

Add imports:

```ts
import { indexDeps } from "./deps.js";
import { retrieve, renderSearchResults } from "./retrieval.js";
import { ingestEntries } from "./ingest.js";
```

Add to the `read_context` tool's `inputSchema.properties`:

```ts
        query: {
          type: "string",
          description:
            "Optional natural-language or keyword query. When given, returns " +
            "relevance-ranked matches from the WHOLE indexed history " +
            "(keyword + semantic search) instead of only the most recent entries. " +
            "Use it when looking for a specific past decision or topic.",
        },
```

Append a third tool definition to `TOOLS`:

```ts
  {
    name: "search_memory",
    title: "Search the shared memory",
    description:
      "Relevance-ranked search over ALL recorded decisions and context in this " +
      "space (keyword + semantic, whole history — not just recent entries). " +
      "Use it BEFORE contradicting or re-deciding anything that may already be " +
      "settled, and when the user references prior work or decisions.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for, e.g. 'cursor mcp config scoping'.",
        },
        project: {
          type: "string",
          description:
            "Restrict to one project/space name. Omit to search every project.",
        },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["decision", "context"] },
          description: "Restrict to entry kinds.",
        },
      },
      required: ["query"],
    },
  },
```

In `toolsCall`, the top currently rejects a missing `project` for every tool. Restructure: keep reading `project` but only enforce it for `read_context`/`write_context`:

```ts
  const args = msg.params?.arguments ?? {};
  const project = typeof args.project === "string" ? args.project : "";
  const toolName = msg.params?.name;
  if ((toolName === "read_context" || toolName === "write_context") && !project)
    return rpcResult(
      msg.id,
      toolText("missing required argument: project", true),
    );
```

`read_context` case — try the index path first when `query` is present:

```ts
      case "read_context": {
        const budget =
          typeof args.budget_tokens === "number" && args.budget_tokens > 0
            ? args.budget_tokens
            : DEFAULT_BUDGET_TOKENS;
        const query = typeof args.query === "string" ? args.query.trim() : "";
        const deps = indexDeps(env);
        if (query && deps) {
          try {
            const { results, total } = await retrieve(deps, {
              space: member.space,
              project: slug(project),
              query,
              budgetTokens: budget,
              trigger: "mcp_read",
            });
            return rpcResult(
              msg.id,
              toolText(renderSearchResults(project, query, results, total)),
            );
          } catch {
            // fail-open to the recency read below
          }
        }
        const { entries, total } = await readEntries(
          env, member, project, budget, fetchImpl,
        );
        return rpcResult(
          msg.id,
          toolText(projectContext(project, entries, total)),
        );
      }
```

New `search_memory` case:

```ts
      case "search_memory": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query)
          return rpcResult(
            msg.id,
            toolText("missing required argument: query", true),
          );
        const deps = indexDeps(env);
        if (!deps)
          return rpcResult(
            msg.id,
            toolText("memory search is not enabled on this gateway", true),
          );
        const kinds = Array.isArray(args.kinds)
          ? args.kinds.filter((k): k is string => typeof k === "string")
          : undefined;
        const { results, total } = await retrieve(deps, {
          space: member.space,
          project: project ? slug(project) : undefined,
          query,
          budgetTokens: DEFAULT_BUDGET_TOKENS,
          kinds,
          trigger: "search_memory",
        });
        return rpcResult(
          msg.id,
          toolText(
            renderSearchResults(project || undefined, query, results, total),
          ),
        );
      }
```

`write_context` case — after the existing cache-invalidation block, before the success `rpcResult`:

```ts
        // Inline index ingest: read-your-own-writes on the hosted plane
        // (§2.3). Fail-open — the ledger write already succeeded, and the
        // webhook/cron paths will index the entry if this misses.
        try {
          const deps = indexDeps(env);
          if (deps) {
            await ingestEntries(deps.db, deps.embed, member.space, project, [
              entry,
            ]);
          }
        } catch {
          // swallow: reconcile cron re-derives the doc from the ledger
        }
```

- [ ] **Step 4: Run tests**

Run: `cd gateway && npm test`
Expected: PASS (all suites, including previously existing mcp tests)

- [ ] **Step 5: Commit**

```bash
git add gateway/src/mcp.ts gateway/test/mcp.test.mjs
git commit -m "feat(gateway): query-conditioned read_context, search_memory tool, inline write ingest"
```

---

### Task 7: `GET /api/read` — the JSON read endpoint for the local CLI

**Files:**
- Create: `gateway/src/api-read.ts`
- Modify: `gateway/src/router.ts` (add the route + import left out in Task 5)
- Test: `gateway/test/api-read.test.mjs`

**Interfaces:**
- Consumes: `resolveMember`, `readEntries`, `projectContext`, `indexDeps`, `retrieve`, `renderSearchResults`, `DEFAULT_BUDGET_TOKENS`, `slug`.
- Produces (consumed by `src/remote-read.ts`, Task 8): `GET /api/read?project=<name>[&query=<q>][&budget=<n>][&kinds=a,b][&trigger=<t>]`, bearer-token auth, returns `200 {"text": string, "total": number, "matched": number}`. `query` present → retrieval pipeline (trigger defaults to `"api_read"`); absent → recency read (`matched` = entries returned). 400 on missing project, 401 unauthorized.

- [ ] **Step 1: Write the failing test**

```js
// gateway/test/api-read.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import { handleRequest } from "../dist/gateway/src/router.js";
import { makeEnv, ghFetch, fakeEmbed } from "./helpers.mjs";
import { sha256Hex } from "../dist/gateway/src/tenancy.js";

const MEMBER = {
  space: "s1", installationId: 7, owner: "o", repo: "r", branch: "main",
  author: "Skanda", authorEmail: "s@x.com",
};

async function authedEnv(indexDb, ghRoutes = []) {
  const env = makeEnv(ghFetch([], ghRoutes), { indexDb, embedder: fakeEmbed });
  await env.ROUTING.put(
    `member:${await sha256Hex("mlk_test")}`,
    JSON.stringify(MEMBER),
  );
  return env;
}

const get = (env, qs) =>
  handleRequest(
    new Request(`https://gw/api/read?${qs}`, {
      headers: { authorization: "Bearer mlk_test" },
    }),
    env,
  );

test("query path returns ranked JSON and logs with the api_read trigger", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([{
    id: "cursor-fact", space: "s1", project: "memorylayer", kind: "decision",
    tier: "normal", body: "Cursor MCP config is project-scoped.",
    sourceFile: "context/memorylayer/skanda/a.md", sourceAuthor: "Skanda",
    sourceTs: "2026-06-01T00:00:00Z",
    embedding: (await fakeEmbed(["Cursor MCP config is project-scoped."]))[0],
    supersededBy: null, createdAt: "2026-07-08T00:00:00Z",
  }]);
  const env = await authedEnv(db);
  const res = await get(env, "project=memorylayer&query=cursor%20mcp%20config");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.text, /project-scoped/);
  assert.equal(body.total, 1);
  assert.equal(body.matched, 1);
  assert.equal(db.logged[0].trigger, "api_read");
});

test("no query falls back to the recency read", async () => {
  const env = await authedEnv(new MemoryIndexDb(), [
    ["/app/installations/", () =>
      Response.json({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" })],
    ["/git/trees/main", () => Response.json({ tree: [] })],
  ]);
  const res = await get(env, "project=memorylayer");
  const body = await res.json();
  assert.equal(body.total, 0);
  assert.match(body.text, /# Shared context: memorylayer/);
});

test("401 without a token; 400 without a project", async () => {
  const env = await authedEnv(new MemoryIndexDb());
  const noAuth = await handleRequest(
    new Request("https://gw/api/read?project=x"), env,
  );
  assert.equal(noAuth.status, 401);
  assert.equal((await get(env, "query=x")).status, 400);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd gateway && npm run build; node --test test/api-read.test.mjs`
Expected: FAIL — 404 from router / module not found

- [ ] **Step 3: Implement**

```ts
// gateway/src/api-read.ts
/**
 * GET /api/read — machine-readable read endpoint for the local plane's
 * remote-first reads (§2.2): the CLI's read_context / search_memory proxy
 * here with the member token and fall back to the local clone on any failure.
 * `query` present = retrieval pipeline; absent = recency read (unchanged
 * contract with the local read).
 */
import type { Env } from "./env.js";
import { resolveMember } from "./tenancy.js";
import { readEntries } from "./github-store.js";
import { projectContext } from "../../src/context-format.js";
import { DEFAULT_BUDGET_TOKENS } from "../../src/token-budget.js";
import { slug } from "../../src/slug.js";
import { indexDeps } from "./deps.js";
import { retrieve, renderSearchResults } from "./retrieval.js";

export async function handleApiRead(req: Request, env: Env): Promise<Response> {
  const member = await resolveMember(req, env);
  if (!member) return new Response("unauthorized", { status: 401 });

  const url = new URL(req.url);
  const project = url.searchParams.get("project")?.trim() ?? "";
  if (!project) return new Response("missing project", { status: 400 });

  const budgetParam = Number(url.searchParams.get("budget"));
  const budget =
    Number.isFinite(budgetParam) && budgetParam > 0
      ? budgetParam
      : DEFAULT_BUDGET_TOKENS;
  const query = url.searchParams.get("query")?.trim() ?? "";
  const kindsParam = url.searchParams.get("kinds")?.trim();
  const kinds = kindsParam ? kindsParam.split(",").filter(Boolean) : undefined;
  const trigger = url.searchParams.get("trigger")?.trim() || "api_read";

  const deps = indexDeps(env);
  if (query && deps) {
    try {
      const { results, total } = await retrieve(deps, {
        space: member.space,
        project: slug(project),
        query,
        budgetTokens: budget,
        kinds,
        trigger,
      });
      return Response.json({
        text: renderSearchResults(project, query, results, total),
        total,
        matched: results.length,
      });
    } catch {
      // fail-open to the recency read below
    }
  }

  const { entries, total } = await readEntries(
    env, member, project, budget, env.githubFetch ?? fetch,
  );
  return Response.json({
    text: projectContext(project, entries, total),
    total,
    matched: entries.length,
  });
}
```

And in `gateway/src/router.ts`, add the import and route exactly as shown in Task 5 Step 10:

```ts
import { handleApiRead } from "./api-read.js";
// ...
  if (url.pathname === "/api/read" && req.method === "GET") {
    return handleApiRead(req, env);
  }
```

- [ ] **Step 4: Run tests**

Run: `cd gateway && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add gateway/src/api-read.ts gateway/src/router.ts gateway/test/api-read.test.mjs
git commit -m "feat(gateway): GET /api/read — JSON read endpoint for remote-first CLI reads"
```

---

### Task 8: Local plane — gateway config, remote-read client, remote-first hook + MCP tools

**Files:**
- Modify: `src/config.ts` (Config fields + allowlist), `src/hook.ts`, `src/index.ts`
- Create: `src/remote-read.ts`
- Test: `test/remote-read.test.mjs`; modify `test/config.test.mjs`, `test/hook.test.mjs`

**Interfaces:**
- Consumes: gateway endpoints `GET /api/read` (Task 7) and `GET /hook/read` (existing).
- Produces:

```ts
// config.ts — Config gains:
gatewayUrl?: string;   // MEMORYLAYER_GATEWAY_URL, trailing slashes stripped
gatewayToken?: string; // MEMORYLAYER_GATEWAY_TOKEN
// both added to HOOK_ENV_ALLOWLIST

// src/remote-read.ts
interface RemoteReadResult { text: string; total: number; matched: number }
async function remoteApiRead(
  cfg: Pick<Config, "gatewayUrl" | "gatewayToken">,
  opts: { project: string; query?: string; budgetTokens?: number;
          kinds?: string[]; trigger?: string },
  fetchImpl?: typeof fetch,
): Promise<RemoteReadResult | null>   // null on ANY failure (fail-open)
async function remoteHookRead(
  cfg: Pick<Config, "gatewayUrl" | "gatewayToken">,
  project: string, budgetTokens: number, fetchImpl?: typeof fetch,
): Promise<string | null>             // /hook/read body ("" = empty store), null on failure
```

- [ ] **Step 1: Write failing config test** (append to `test/config.test.mjs`, matching its existing setup style for env manipulation)

```js
test("loadConfig reads gateway url/token; url is trailing-slash-normalized", () => {
  process.env.MEMORYLAYER_AUTHOR = "A";
  process.env.CONTEXT_REPO_URL = "https://x/y.git";
  process.env.MEMORYLAYER_GATEWAY_URL = "https://gw.example.com/";
  process.env.MEMORYLAYER_GATEWAY_TOKEN = "mlk_abc";
  const cfg = loadConfig();
  assert.equal(cfg.gatewayUrl, "https://gw.example.com");
  assert.equal(cfg.gatewayToken, "mlk_abc");
});

test("loadHookEnv honors the gateway keys", () => {
  // write .memorylayer-hook.env in a temp cwd containing:
  //   MEMORYLAYER_GATEWAY_URL=https://gw.example.com
  //   MEMORYLAYER_GATEWAY_TOKEN=mlk_fromfile
  // then loadHookEnv(tmp) and assert both landed in process.env
});
```

(Write the second test fully using the same tmpdir pattern the existing `loadHookEnv` tests in that file use.)

- [ ] **Step 2: Implement config changes**

In `src/config.ts`: add to `Config`:

```ts
  /** Hosted gateway base URL for remote-first reads (unset = local-only). */
  gatewayUrl?: string;
  /** Member token for the hosted gateway. */
  gatewayToken?: string;
```

Add `"MEMORYLAYER_GATEWAY_URL"` and `"MEMORYLAYER_GATEWAY_TOKEN"` to `HOOK_ENV_ALLOWLIST`. In `loadConfig()`'s return:

```ts
    gatewayUrl:
      process.env.MEMORYLAYER_GATEWAY_URL?.trim().replace(/\/+$/, "") ||
      undefined,
    gatewayToken: process.env.MEMORYLAYER_GATEWAY_TOKEN?.trim() || undefined,
```

Run: `npm test` → config tests PASS.

- [ ] **Step 3: Write failing remote-read test**

```js
// test/remote-read.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteApiRead, remoteHookRead } from "../dist/remote-read.js";

const CFG = { gatewayUrl: "https://gw.example.com", gatewayToken: "mlk_t" };

test("remoteApiRead builds the URL, sends the bearer token, parses JSON", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), init };
    return Response.json({ text: "ranked", total: 5, matched: 2 });
  };
  const out = await remoteApiRead(
    CFG,
    { project: "memorylayer", query: "cursor config", budgetTokens: 1000,
      trigger: "mcp_read" },
    fetchImpl,
  );
  assert.deepEqual(out, { text: "ranked", total: 5, matched: 2 });
  const u = new URL(seen.url);
  assert.equal(u.pathname, "/api/read");
  assert.equal(u.searchParams.get("project"), "memorylayer");
  assert.equal(u.searchParams.get("query"), "cursor config");
  assert.equal(u.searchParams.get("budget"), "1000");
  assert.equal(u.searchParams.get("trigger"), "mcp_read");
  assert.equal(seen.init.headers.authorization, "Bearer mlk_t");
});

test("remoteApiRead returns null on non-200, bad JSON, thrown fetch, or missing config", async () => {
  assert.equal(await remoteApiRead({}, { project: "p" }), null);
  assert.equal(
    await remoteApiRead(CFG, { project: "p" }, async () => new Response("x", { status: 500 })),
    null,
  );
  assert.equal(
    await remoteApiRead(CFG, { project: "p" }, async () => new Response("not json")),
    null,
  );
  assert.equal(
    await remoteApiRead(CFG, { project: "p" }, async () => { throw new Error("net"); }),
    null,
  );
});

test("remoteHookRead returns the body text (empty string preserved), null on failure", async () => {
  assert.equal(
    await remoteHookRead(CFG, "p", 4000, async () => new Response("injected text")),
    "injected text",
  );
  assert.equal(
    await remoteHookRead(CFG, "p", 4000, async () => new Response("")),
    "",
  );
  assert.equal(
    await remoteHookRead(CFG, "p", 4000, async () => new Response("x", { status: 401 })),
    null,
  );
  assert.equal(await remoteHookRead({}, "p", 4000), null);
});
```

- [ ] **Step 4: Implement `src/remote-read.ts`**

```ts
// src/remote-read.ts
/**
 * Remote-first read client (§2.2): the local plane calls the gateway's
 * retrieval service and falls back to the local clone when offline or
 * unconfigured. Every failure returns null — callers treat null as "use the
 * local path", never as an error. Bounded by a timeout so a slow gateway
 * cannot stall a session hook.
 */
import type { Config } from "./config.js";

export interface RemoteReadResult {
  text: string;
  total: number;
  matched: number;
}

const REMOTE_TIMEOUT_MS = 4000;

type GatewayCfg = Pick<Config, "gatewayUrl" | "gatewayToken">;

function configured(cfg: GatewayCfg): cfg is Required<GatewayCfg> {
  return Boolean(cfg.gatewayUrl && cfg.gatewayToken);
}

export async function remoteApiRead(
  cfg: GatewayCfg,
  opts: {
    project: string;
    query?: string;
    budgetTokens?: number;
    kinds?: string[];
    trigger?: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<RemoteReadResult | null> {
  if (!configured(cfg)) return null;
  try {
    const url = new URL(`${cfg.gatewayUrl}/api/read`);
    url.searchParams.set("project", opts.project);
    if (opts.query) url.searchParams.set("query", opts.query);
    if (opts.budgetTokens)
      url.searchParams.set("budget", String(opts.budgetTokens));
    if (opts.kinds?.length) url.searchParams.set("kinds", opts.kinds.join(","));
    if (opts.trigger) url.searchParams.set("trigger", opts.trigger);
    const res = await fetchImpl(url.toString(), {
      headers: { authorization: `Bearer ${cfg.gatewayToken}` },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<RemoteReadResult>;
    if (typeof body.text !== "string" || typeof body.total !== "number")
      return null;
    return {
      text: body.text,
      total: body.total,
      matched: typeof body.matched === "number" ? body.matched : 0,
    };
  } catch {
    return null;
  }
}

export async function remoteHookRead(
  cfg: GatewayCfg,
  project: string,
  budgetTokens: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!configured(cfg)) return null;
  try {
    const url = new URL(`${cfg.gatewayUrl}/hook/read`);
    url.searchParams.set("project", project);
    url.searchParams.set("budget", String(budgetTokens));
    const res = await fetchImpl(url.toString(), {
      headers: { authorization: `Bearer ${cfg.gatewayToken}` },
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
```

Run: `npm test` → remote-read tests PASS.

- [ ] **Step 5: Make the hook remote-first**

In `src/hook.ts`, import `remoteHookRead` and, inside the `try` block, after resolving `project` and `cfg` but BEFORE `new ContextStore(cfg)`:

```ts
    // Remote-first (§2.2): the gateway's index serves the read; the local
    // clone is the offline fallback. remoteHookRead returns ready-to-inject
    // text ("" = empty store) or null meaning "gateway unusable — fall back".
    const remote = await remoteHookRead(cfg, project, cfg.readBudgetTokens);
    if (remote !== null) {
      if (remote === "") emitEmpty();
      process.stdout.write(renderContext(client, remote));
      process.exit(0);
    }
```

(The existing local path below stays byte-identical and runs when `remote === null`.)

Add to `test/hook.test.mjs` (matching its existing spawn/env harness): a test that sets `MEMORYLAYER_GATEWAY_URL` to an unreachable localhost port (e.g. `http://127.0.0.1:1`) plus a token, and asserts the hook still exits 0 and produces the local-store output — proving fallback. (A positive remote-path test would need a live HTTP server; the unit tests in Step 3 cover the client, and the fallback test covers the wiring.)

Run: `npm test` → hook tests PASS.

- [ ] **Step 6: Update the local MCP server (`src/index.ts`)**

Import `remoteApiRead` from `./remote-read.js`. In `read_context`: add to the input schema

```ts
        query: z
          .string()
          .optional()
          .describe(
            "Optional query: relevance-ranked search over the WHOLE history " +
              "(keyword + semantic) instead of the most recent entries. " +
              "Requires the hosted gateway; ignored offline.",
          ),
```

and replace the handler body with:

```ts
    async ({ project, query, budget_tokens }) => {
      const budget = budget_tokens ?? cfg.readBudgetTokens;
      // Remote-first (§2.2): gateway index read, local clone as fallback.
      const remote = await remoteApiRead(cfg, {
        project,
        query: query?.trim() || undefined,
        budgetTokens: budget,
        trigger: "mcp_read",
      });
      if (remote !== null) {
        await recordMetric(cfg, {
          source: "mcp", event: "read", project, total: remote.total,
        });
        return { content: [{ type: "text", text: remote.text }] };
      }
      const { entries, total } = await store.read(project, budget);
      await recordMetric(cfg, { source: "mcp", event: "read", project, total });
      const note = query?.trim()
        ? "(offline fallback: relevance search unavailable — showing the most recent entries)\n\n"
        : "";
      return {
        content: [
          { type: "text", text: note + projectContext(project, entries, total) },
        ],
      };
    },
```

Register the `search_memory` tool after `write_context`:

```ts
  server.registerTool(
    "search_memory",
    {
      title: "Search the shared memory",
      description:
        "Relevance-ranked search over ALL recorded decisions and context " +
        "(keyword + semantic, whole history — not just recent entries). Use it " +
        "BEFORE contradicting or re-deciding anything that may already be " +
        "settled, and when the user references prior work or decisions.",
      inputSchema: {
        query: z
          .string()
          .describe("What to look for, e.g. 'cursor mcp config scoping'."),
        project: z
          .string()
          .optional()
          .describe(
            "Restrict to one project/space name. Omit to search every project.",
          ),
        kinds: z
          .array(z.enum(["decision", "context"]))
          .optional()
          .describe("Restrict to entry kinds."),
      },
    },
    async ({ query, project, kinds }) => {
      const remote = await remoteApiRead(cfg, {
        // /api/read requires a project for its recency fallback; retrieval
        // itself searches the whole space when the gateway gets no project —
        // so pass the default project only as the fallback scope.
        project: project?.trim() || defaultProject(),
        query,
        kinds,
        budgetTokens: cfg.readBudgetTokens,
        trigger: "search_memory",
      });
      if (remote === null) {
        return {
          content: [
            {
              type: "text",
              text:
                "search_memory needs the hosted gateway and it was not reachable " +
                "(set MEMORYLAYER_GATEWAY_URL and MEMORYLAYER_GATEWAY_TOKEN, or retry online). " +
                "Use read_context for the local recency view.",
            },
          ],
          isError: true,
        };
      }
      await recordMetric(cfg, {
        source: "mcp", event: "read", project: project?.trim() || defaultProject(),
        total: remote.total,
      });
      return { content: [{ type: "text", text: remote.text }] };
    },
  );
```

Add `defaultProject` to the existing `./config.js` import in `src/index.ts`.

- [ ] **Step 7: Run the full local suite**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all PASS

- [ ] **Step 8: Commit**

```bash
git add src/config.ts src/remote-read.ts src/hook.ts src/index.ts test/remote-read.test.mjs test/config.test.mjs test/hook.test.mjs
git commit -m "feat(cli): remote-first reads — gateway config, /api/read client, query param, search_memory tool"
```

---

### Task 9: Deploy config + docs + full verification

**Files:**
- Modify: `gateway/wrangler.toml`, `gateway/README.md`

- [ ] **Step 1: Update `gateway/wrangler.toml`**

```toml
name = "memorylayer-gateway"
main = "dist/gateway/src/worker.js"
compatibility_date = "2026-06-01"

# Created in Step 3; paste the id wrangler prints.
[[kv_namespaces]]
binding = "ROUTING"
id = "799c559402d6472993dc63ed26b0fd5e"

# Relevance index (Phase A). Create with `wrangler d1 create memorylayer-index`
# and paste the printed database_id, then apply migrations:
#   wrangler d1 migrations apply memorylayer-index --remote
[[d1_databases]]
binding = "DB"
database_name = "memorylayer-index"
database_id = "PASTE-DATABASE-ID-HERE"
migrations_dir = "migrations"

# Workers AI: embeddings (@cf/baai/bge-base-en-v1.5), free-tier allocation.
[ai]
binding = "AI"

# Webhook-drop reconciler (§2.1): every 15 minutes, reindex spaces whose
# indexed sha lags the ledger HEAD.
[triggers]
crons = ["*/15 * * * *"]
```

- [ ] **Step 2: Document in `gateway/README.md`**

Add a "Relevance index (Phase A)" section covering, in order:
1. One-time provisioning: `wrangler d1 create memorylayer-index` → paste id into `wrangler.toml` → `wrangler d1 migrations apply memorylayer-index --remote` → `wrangler secret put WEBHOOK_SECRET`.
2. GitHub App webhook setup: webhook URL `https://<worker>/webhook/github`, content type `application/json`, secret = the same WEBHOOK_SECRET, event: pushes only.
3. Backfill: `curl -X POST https://<worker>/admin/reindex -H "x-admin-secret: $ADMIN_SECRET" -d '{}'` — rebuilds every registered space from the ledger (registry is populated as members are (re-)minted; re-mint or re-POST existing members once so pre-existing spaces register).
4. New surface: `read_context.query`, `search_memory`, `GET /api/read`, retrieval logged to `retrieval_log` in D1.
5. Local client env: `MEMORYLAYER_GATEWAY_URL` + `MEMORYLAYER_GATEWAY_TOKEN` in `.memorylayer-hook.env` turn on remote-first reads; without them (or offline) everything behaves exactly as before.
6. Degradation table: no DB binding → recency reads only; no AI binding → BM25-only ranking; webhook down → cron reconciles within 15 min; gateway unreachable from CLI → local clone fallback.

- [ ] **Step 3: Full verification**

Run, from the repo root:

```bash
npm test && npm run lint && npm run typecheck && npm run format:check && npm run test:gateway
```

Expected: every suite PASS, no lint/type/format errors.

- [ ] **Step 4: Commit**

```bash
git add gateway/wrangler.toml gateway/README.md
git commit -m "chore(gateway): D1/AI/cron deploy config + Phase A relevance docs"
```

---

## Phase A exit criteria (from roadmap §9)

- The Cursor-miss regression is encoded as automated tests at three levels: `rank.test.mjs` (BM25), `retrieval.test.mjs` (pipeline), `mcp.test.mjs` (tool surface). The seeded golden set = these cases; recall@10 on them must be 1.0 (asserted by the tests themselves).
- `retrieval_log` receives every query-conditioned retrieval with trigger, query, scores, and injected flag — the data Phases B/C need.
- Both planes serve query reads; local reads are remote-first with verified fail-open fallback.
- Post-deploy manual check (operator step, after `npm run deploy` + provisioning): `POST /admin/reindex`, then `search_memory("cursor mcp config")` from a hosted client must surface the 2026-07-04 Cursor decision.
