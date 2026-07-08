# Phase B1 — Atomic Facts, Entity Tags, Canon Tier, Briefing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase A's naive per-entry indexing with server-side LLM-extracted atomic facts, entity tags, a canon tier, and a selective session-start briefing + topic manifest — all in the gateway, so the local plane inherits it via existing remote-first reads.

**Architecture:** A fact is a `docs` row (`id = ${entry.id}#${n}`, new `source_id` column). Ingest extracts N facts per ledger entry via a $0 Workers AI text-gen model, embeds each, and writes them with delete-then-insert idempotency (`replaceBySource`). The proven Phase A retrieval pipeline is unchanged except for a canon-tier boost and an entity-tag candidate generator. `/hook/read` builds a briefing (canon + open questions + 7-day decisions + topic manifest) from the index, falling back to the Phase A recency dump on any failure. Extraction on the gateway write path runs async via `ctx.waitUntil`.

**Tech Stack:** TypeScript, Cloudflare Workers + D1 + Workers AI (embeddings `@cf/baai/bge-base-en-v1.5` + text-gen `@cf/meta/llama-3.1-8b-instruct`), `node:test`, no new npm dependencies.

## Global Constraints

- **Branch:** `relevance/phase-b1` from `main` (already created; the spec is committed there).
- **Gateway-exclusive:** no changes to any root-package (`src/**`) source or the local CLI write path. The local plane is frozen (2026-07-08 decision); it inherits B1 via remote-first reads.
- **Ledger format unchanged:** no changes to `src/frontmatter.ts`, entry paths, or `write_context` schema.
- **Fail-open everywhere:** extraction unavailable/failed/malformed → single whole-entry `normal` fact (= Phase A behavior); briefing build failed/index empty → verbatim recency dump; no `DB`/`AI` binding → recency everywhere. A broken index must never surface an error to a session.
- **$0 infra:** D1 free tier, Workers AI free allocation. No Queues, no Vectorize, no paid models.
- **No new npm dependencies.**
- **Test seams follow the existing pattern:** `Env` carries optional injected fakes (`indexDb`, `embedder`; add `genText`); production leaves them unset. Fakes for models are deterministic (`fakeEmbed`, add `fakeGenText`), no miniflare, no network.
- **Tenant scoping:** every index read/write is parameterized by `member.space`, exactly like Phase A.
- **Gateway suite:** `cd gateway && npm test` (runs `npm run build` first). Root suite `npm test` must stay green (it exercises no gateway code but must not regress). Also `npm run lint`, `npm run typecheck`, `npm run format:check` at the root.

## File Structure

```
gateway/src/extract.ts        NEW  GenText type, ExtractedFact, extractFacts + fail-open floor, prompt
gateway/src/index-db.ts       MOD  IndexedDoc gains sourceId+entities; replaceBySource; listDocs hydrates entities; d1 + memory impls
gateway/src/rank.ts           MOD  canon boost in adjustScores; entityRank candidate generator
gateway/src/retrieval.ts      MOD  entity candidate list into RRF; renderBriefing helper
gateway/src/ingest.ts         MOD  factToDoc; ingestEntries = extract→embed→replaceBySource; gen param threaded
gateway/src/env.ts            MOD  AiBinding text-gen overload; genText test seam
gateway/src/deps.ts           MOD  EXTRACT_MODEL; indexDeps resolves genText
gateway/src/mcp.ts            MOD  handleMcp(req,env,ctx); write_context ingest via ctx.waitUntil; thread gen
gateway/src/router.ts         MOD  pass ctx to handleMcp
gateway/src/hook-read.ts      MOD  briefing + manifest from index, recency fallback
gateway/src/reindex.ts        MOD  thread gen into reindex/reconcile ingest calls
gateway/src/webhook.ts        MOD  thread gen into webhook ingest call
gateway/migrations/0002_facts_entities.sql   NEW  source_id column + fact_entities table
gateway/test/helpers.mjs      MOD  fakeGenText seam; makeEnv gains genText
gateway/test/extract.test.mjs        NEW
gateway/test/index-db.test.mjs       MOD  replaceBySource + entity hydration
gateway/test/rank.test.mjs           MOD  canon boost + entityRank
gateway/test/retrieval.test.mjs      MOD  entity rescue + renderBriefing
gateway/test/ingest.test.mjs         MOD  entry→N facts, fail-open→1, idempotent re-ingest
gateway/test/deps.test.mjs           NEW  genText resolution
gateway/test/mcp.test.mjs            MOD  waitUntil deferral
gateway/test/hook-read.test.mjs      MOD  briefing composition + fallback
gateway/README.md             MOD  Phase B ingest/model/migration/backfill notes
```

---

### Task 1: Fact extraction (`extract.ts`)

**Files:**
- Create: `gateway/src/extract.ts`
- Modify: `gateway/test/helpers.mjs` (add `fakeGenText`)
- Test: `gateway/test/extract.test.mjs`

**Interfaces:**
- Consumes: `ParsedEntry` from `../../src/frontmatter.js`; `slug` from `../../src/slug.js`.
- Produces (used by Tasks 4, 5):

```ts
type GenText = (prompt: string) => Promise<string>;
interface ExtractedFact { kind: string; tier: "canon" | "normal"; body: string; entities: string[] }
function buildExtractionPrompt(entry: ParsedEntry): string
async function extractFacts(gen: GenText | null, entry: ParsedEntry): Promise<ExtractedFact[]>
```

- [ ] **Step 1: Add `fakeGenText` to `gateway/test/helpers.mjs`**

Append to the existing file:

```js
/** Deterministic text-gen seam: returns a JSON fact array driven by the entry
 *  body so extraction tests need no model. Recognizes marker substrings; else
 *  echoes the whole body as one normal fact (mirrors the real floor). */
export function fakeGenText(script = {}) {
  return async (prompt) => {
    for (const [marker, json] of Object.entries(script)) {
      if (prompt.includes(marker)) return json;
    }
    return "__PASSTHROUGH__"; // caller's parser will reject → fail-open floor
  };
}
```

- [ ] **Step 2: Write the failing test**

```js
// gateway/test/extract.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFacts, buildExtractionPrompt } from "../dist/gateway/src/extract.js";
import { fakeGenText } from "./helpers.mjs";

const entry = (payload, type = "decision") => ({
  author: "Skanda", type, timestamp: "2026-07-04T00:00:00Z",
  id: "abc123", payload, file: "context/memorylayer/skanda/f.md",
});

test("buildExtractionPrompt includes the entry body and the fidelity instruction", () => {
  const p = buildExtractionPrompt(entry("Cursor MCP config is project-scoped."));
  assert.match(p, /Cursor MCP config is project-scoped\./);
  assert.match(p, /do not infer|only what the (entry|source) states/i);
});

test("extractFacts parses a valid JSON array into normalized facts", async () => {
  const gen = fakeGenText({
    "Cursor MCP": JSON.stringify([
      { kind: "constraint", tier: "canon", body: "Cursor MCP config is project-scoped, not global.", entities: ["Cursor", "MCP Config"] },
      { kind: "context", tier: "normal", body: "Verified on 2026-07-04.", entities: [] },
    ]),
  });
  const facts = await extractFacts(gen, entry("Cursor MCP config is project-scoped."));
  assert.equal(facts.length, 2);
  assert.equal(facts[0].tier, "canon");
  assert.deepEqual(facts[0].entities, ["cursor", "mcp-config"]); // slugged + deduped
});

test("extractFacts tolerates code-fenced JSON", async () => {
  const gen = fakeGenText({ marker: "```json\n[{\"kind\":\"decision\",\"tier\":\"normal\",\"body\":\"We picked D1.\",\"entities\":[]}]\n```" });
  const facts = await extractFacts(gen, entry("marker: chose D1"));
  assert.equal(facts.length, 1);
  assert.equal(facts[0].body, "We picked D1.");
});

test("fail-open floor: null gen → one normal fact = whole entry body", async () => {
  const facts = await extractFacts(null, entry("some prose", "context"));
  assert.deepEqual(facts, [{ kind: "context", tier: "normal", body: "some prose", entities: [] }]);
});

test("fail-open floor: malformed / non-JSON / throwing gen → one normal fact", async () => {
  const bad = await extractFacts(async () => "not json at all", entry("prose body"));
  assert.deepEqual(bad, [{ kind: "decision", tier: "normal", body: "prose body", entities: [] }]);
  const boom = await extractFacts(async () => { throw new Error("model down"); }, entry("prose body"));
  assert.equal(boom.length, 1);
  assert.equal(boom[0].body, "prose body");
});

test("fail-open floor: valid JSON but empty array → one normal fact (never index nothing)", async () => {
  const facts = await extractFacts(async () => "[]", entry("prose body"));
  assert.equal(facts.length, 1);
  assert.equal(facts[0].body, "prose body");
});

test("extractFacts drops facts with an empty body but keeps the rest", async () => {
  const gen = async () => JSON.stringify([
    { kind: "decision", tier: "normal", body: "", entities: [] },
    { kind: "decision", tier: "normal", body: "kept", entities: [] },
  ]);
  const facts = await extractFacts(gen, entry("x"));
  assert.deepEqual(facts.map((f) => f.body), ["kept"]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd gateway && npm run build; node --test test/extract.test.mjs`
Expected: FAIL — `Cannot find module '../dist/gateway/src/extract.js'`

- [ ] **Step 4: Write the implementation**

```ts
// gateway/src/extract.ts
/**
 * LLM fact extraction (roadmap §3): condense a multi-fact prose ledger entry
 * into atomic, self-contained facts. This is the ONLY new LLM call in Phase B1
 * and it runs off the write hot path (mcp.ts uses ctx.waitUntil).
 *
 * Fail-open is central and non-negotiable: whenever extraction cannot produce
 * a valid non-empty fact set (no model, thrown call, unparseable or
 * schema-invalid output, empty array), we fall back to ONE fact = the whole
 * entry body at `normal` tier — byte-for-byte Phase A behavior, so recall never
 * regresses. The ledger stays the recoverable source of truth: a better prompt
 * later just means a reindex.
 */
import type { ParsedEntry } from "../../src/frontmatter.js";
import { slug } from "../../src/slug.js";

export type GenText = (prompt: string) => Promise<string>;

export interface ExtractedFact {
  kind: string;
  tier: "canon" | "normal";
  body: string;
  entities: string[];
}

const VALID_KINDS = new Set([
  "decision", "constraint", "preference", "reference", "context", "status", "question",
]);

export function buildExtractionPrompt(entry: ParsedEntry): string {
  return [
    "You extract atomic planning facts from a single shared-memory entry.",
    "Rules:",
    "- Output ONLY a JSON array; no prose, no code fence required.",
    "- Each element: {\"kind\", \"tier\", \"body\", \"entities\"}.",
    "- kind ∈ decision|constraint|preference|reference|context|status|question.",
    "- Split the entry into 1–5 self-contained facts, each understandable ALONE.",
    "- Fidelity over fluency: state only what the entry states; do not infer.",
    "- Include the 'because' when the entry gives one.",
    "- tier = \"canon\" ONLY for standing rules/conventions/environment invariants",
    "  (\"always X\", \"never Y\"); status updates are NEVER canon; else \"normal\".",
    "- entities: short normalized topic tags (e.g. \"cursor\", \"mcp-config\").",
    "",
    `Entry type: ${entry.type}`,
    "Entry body:",
    entry.payload,
  ].join("\n");
}

/** The Phase A floor: one whole-entry normal fact. */
function floor(entry: ParsedEntry): ExtractedFact[] {
  return [{ kind: entry.type, tier: "normal", body: entry.payload, entities: [] }];
}

function coerce(raw: unknown, entry: ParsedEntry): ExtractedFact[] | null {
  if (!Array.isArray(raw)) return null;
  const facts: ExtractedFact[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const body = typeof o.body === "string" ? o.body.trim() : "";
    if (!body) continue;
    const kind = typeof o.kind === "string" && VALID_KINDS.has(o.kind) ? o.kind : entry.type;
    const tier = o.tier === "canon" ? "canon" : "normal";
    const entities = Array.isArray(o.entities)
      ? [...new Set(
          o.entities
            .filter((e): e is string => typeof e === "string")
            .map((e) => slug(e))
            .filter((e) => e.length > 0),
        )]
      : [];
    facts.push({ kind, tier, body, entities });
  }
  return facts.length > 0 ? facts : null;
}

/** Strip an optional ```json ... ``` fence, then JSON.parse. */
function parseModelJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  return JSON.parse(body);
}

export async function extractFacts(
  gen: GenText | null,
  entry: ParsedEntry,
): Promise<ExtractedFact[]> {
  if (!gen) return floor(entry);
  try {
    const out = await gen(buildExtractionPrompt(entry));
    const coerced = coerce(parseModelJson(out), entry);
    return coerced ?? floor(entry);
  } catch {
    return floor(entry);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd gateway && npm run build && node --test test/extract.test.mjs`
Expected: PASS (7 tests)

- [ ] **Step 6: Commit**

```bash
git add gateway/src/extract.ts gateway/test/extract.test.mjs gateway/test/helpers.mjs
git commit -m "feat(gateway): LLM fact extraction with fail-open whole-entry floor"
```

---

### Task 2: Storage — `source_id`, entities, `replaceBySource`, schema `0002`

**Files:**
- Modify: `gateway/src/index-db.ts`
- Create: `gateway/migrations/0002_facts_entities.sql`
- Test: `gateway/test/index-db.test.mjs` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 3–7):

```ts
// IndexedDoc gains:
//   sourceId: string          // ledger entry id; groups a fact set
//   entities: string[]        // normalized tags (write-side; hydrated on listDocs)
// IndexDb gains:
interface IndexDb {
  // ...existing...
  replaceBySource(space: string, sourceId: string, docs: IndexedDoc[]): Promise<void>;
}
// listDocs now returns docs with `entities` populated.
```

- [ ] **Step 1: Write the failing test** (append to `gateway/test/index-db.test.mjs`)

```js
import { d1IndexDb } from "../dist/gateway/src/index-db.js"; // (already imported at top; keep one import)

test("MemoryIndexDb: replaceBySource is idempotent — re-running leaves no duplicate/orphan facts", async () => {
  const db = new MemoryIndexDb();
  const f = (id, body, entities = []) => ({
    id, space: "s1", project: "memorylayer", kind: "decision", tier: "normal",
    body, sourceFile: "context/memorylayer/skanda/e.md", sourceAuthor: "Skanda",
    sourceTs: "2026-07-04T00:00:00Z", embedding: [], supersededBy: null,
    createdAt: "2026-07-08T00:00:00Z", sourceId: "e1", entities,
  });
  await db.replaceBySource("s1", "e1", [f("e1#0", "a", ["cursor"]), f("e1#1", "b")]);
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
  const base = { space: "s1", project: "p", kind: "decision", tier: "normal",
    body: "x", sourceFile: "f", sourceAuthor: "A", sourceTs: "2026-01-01T00:00:00Z",
    embedding: [], supersededBy: null, createdAt: "2026-07-08T00:00:00Z", entities: [] };
  await db.replaceBySource("s1", "e1", [{ ...base, id: "e1#0", sourceId: "e1" }]);
  await db.replaceBySource("s1", "e2", [{ ...base, id: "e2#0", sourceId: "e2" }]);
  await db.replaceBySource("s1", "e1", []); // clears only e1's facts
  assert.deepEqual((await db.listDocs("s1")).map((d) => d.id), ["e2#0"]);
});

test("d1IndexDb.replaceBySource batches deletes (docs + fact_entities) then inserts", async () => {
  const executed = [];
  const stmt = (sql) => ({
    sql, params: [],
    bind(...v) { this.params = v; return this; },
    async run() { executed.push(this); return {}; },
    async all() { executed.push(this); return { results: [] }; },
    async first() { return null; },
  });
  const fake = { prepare: (sql) => stmt(sql), async batch(s) { executed.push(...s); return []; } };
  const db = d1IndexDb(fake);
  await db.replaceBySource("s1", "e1", [{
    id: "e1#0", space: "s1", project: "p", kind: "decision", tier: "canon",
    body: "b", sourceFile: "f", sourceAuthor: "A", sourceTs: "2026-01-01T00:00:00Z",
    embedding: [0.5], supersededBy: null, createdAt: "2026-07-08T00:00:00Z",
    sourceId: "e1", entities: ["cursor", "d1"],
  }]);
  assert.ok(executed.some((s) => /DELETE FROM docs WHERE space = \? AND source_id = \?/i.test(s.sql)));
  assert.ok(executed.some((s) => /DELETE FROM fact_entities WHERE space = \? AND fact_id = \?/i.test(s.sql)));
  assert.ok(executed.some((s) => /INSERT OR REPLACE INTO docs/i.test(s.sql) && s.params.includes("e1#0")));
  assert.ok(executed.some((s) => /INSERT OR REPLACE INTO fact_entities/i.test(s.sql) && s.params.includes("cursor")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npm run build; node --test test/index-db.test.mjs`
Expected: FAIL — `db.replaceBySource is not a function` / missing `sourceId`.

- [ ] **Step 3: Write the implementation**

In `gateway/src/index-db.ts`, extend `IndexedDoc`:

```ts
export interface IndexedDoc {
  id: string;
  space: string;
  project: string;
  kind: string;
  tier: string;
  body: string;
  sourceFile: string;
  sourceAuthor: string;
  sourceTs: string;
  embedding: number[];
  supersededBy: string | null;
  createdAt: string;
  sourceId: string; // ledger entry id; groups the fact set for idempotent re-ingest
  entities: string[]; // normalized tags; hydrated on listDocs, written to fact_entities
}
```

Add to the `IndexDb` interface:

```ts
  /** Delete-then-insert every fact for one ledger entry, in one batch —
   *  idempotent under non-deterministic extraction (roadmap §3). */
  replaceBySource(space: string, sourceId: string, docs: IndexedDoc[]): Promise<void>;
```

In `MemoryIndexDb`, add `replaceBySource` and ensure `entities`/`sourceId` round-trip
(the map already stores whole docs, so entities are preserved; just add the method):

```ts
  async replaceBySource(space: string, sourceId: string, docs: IndexedDoc[]): Promise<void> {
    for (const [key, d] of this.docs) {
      if (d.space === space && d.sourceId === sourceId) this.docs.delete(key);
    }
    for (const d of docs) this.docs.set(`${d.space} ${d.id}`, d);
  }
```

In `d1IndexDb`: (a) add `replaceBySource`; (b) make `listDocs` hydrate `entities`;
(c) map the new columns in `listDocs`. Add the method:

```ts
    async replaceBySource(space, sourceId, docs) {
      const stmts = [
        db.prepare("DELETE FROM docs WHERE space = ? AND source_id = ?").bind(space, sourceId),
        db.prepare("DELETE FROM fact_entities WHERE space = ? AND fact_id IN " +
          "(SELECT id FROM docs WHERE space = ? AND source_id = ?)").bind(space, space, sourceId),
      ];
      for (const d of docs) {
        stmts.push(
          db.prepare(
            "INSERT OR REPLACE INTO docs (id, space, project, kind, tier, body, " +
              "source_file, source_author, source_ts, embedding, superseded_by, created_at, source_id) " +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          ).bind(
            d.id, d.space, d.project, d.kind, d.tier, d.body, d.sourceFile,
            d.sourceAuthor, d.sourceTs, encodeEmbedding(d.embedding), d.supersededBy,
            d.createdAt, d.sourceId,
          ),
        );
        for (const e of d.entities) {
          stmts.push(
            db.prepare(
              "INSERT OR REPLACE INTO fact_entities (space, fact_id, entity) VALUES (?, ?, ?)",
            ).bind(d.space, d.id, e),
          );
        }
      }
      await db.batch(stmts);
    },
```

Update `d1IndexDb.listDocs` to hydrate entities (fetch tags for the space once, attach):

```ts
    async listDocs(space, project) {
      const sql =
        "SELECT * FROM docs WHERE space = ? AND superseded_by IS NULL" +
        (project !== undefined ? " AND project = ?" : "");
      const stmt = project !== undefined
        ? db.prepare(sql).bind(space, project)
        : db.prepare(sql).bind(space);
      const { results } = await stmt.all();
      const { results: tagRows } = await db
        .prepare("SELECT fact_id, entity FROM fact_entities WHERE space = ?")
        .bind(space)
        .all();
      const tags = new Map<string, string[]>();
      for (const r of tagRows) {
        const id = r.fact_id as string;
        (tags.get(id) ?? tags.set(id, []).get(id)!).push(r.entity as string);
      }
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
        sourceId: (r.source_id as string | null) ?? "",
        entities: tags.get(r.id as string) ?? [],
      }));
    },
```

- [ ] **Step 4: Create the migration**

```sql
-- gateway/migrations/0002_facts_entities.sql
-- Phase B1: a fact is a docs row; source_id groups the fact set of one ledger
-- entry for idempotent delete-then-insert re-ingest. Entity tags power the
-- retrieval candidate generator and the briefing topic manifest.
ALTER TABLE docs ADD COLUMN source_id TEXT;
CREATE INDEX IF NOT EXISTS docs_source ON docs (space, source_id);

CREATE TABLE IF NOT EXISTS fact_entities (
  space   TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  entity  TEXT NOT NULL,
  PRIMARY KEY (space, fact_id, entity)
);
CREATE INDEX IF NOT EXISTS fact_entities_lookup ON fact_entities (space, entity);
```

- [ ] **Step 5: Update every existing `IndexedDoc` literal in tests to include `sourceId`/`entities`**

Existing Phase A tests build `IndexedDoc` literals (in `index-db.test.mjs`, `ingest.test.mjs`, `retrieval.test.mjs`). Add `sourceId: "<id>", entities: []` to each so they typecheck against the widened interface. Run the full gateway build to surface every site:

Run: `cd gateway && npm run build 2>&1 | grep -i "sourceId\|entities" || echo "clean"`

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd gateway && npm run build && node --test test/index-db.test.mjs`
Expected: PASS (existing + 3 new tests)

- [ ] **Step 7: Commit**

```bash
git add gateway/src/index-db.ts gateway/migrations/0002_facts_entities.sql gateway/test/index-db.test.mjs
git commit -m "feat(gateway): fact storage — source_id, entity tags, replaceBySource idempotency, schema 0002"
```

---

### Task 3: Canon boost + entity candidate generator (`rank.ts`)

**Files:**
- Modify: `gateway/src/rank.ts`
- Test: `gateway/test/rank.test.mjs` (extend)

**Interfaces:**
- Consumes: `Scored` (existing); `tokenize` (existing).
- Produces (used by Task 4/retrieval):

```ts
// adjustScores signature widens to read `tier`:
function adjustScores(
  fused: Map<string, number>,
  docsById: Map<string, { kind: string; sourceTs: string; tier: string }>,
  now: Date,
): Scored[]
function entityRank(docs: { id: string; entities: string[] }[], query: string): Scored[]
const CANON_BOOST: number // 1.5
```

- [ ] **Step 1: Write the failing test** (append to `gateway/test/rank.test.mjs`)

```js
import { entityRank, CANON_BOOST } from "../dist/gateway/src/rank.js"; // merge with existing import line

test("adjustScores: a canon fact outranks a same-similarity normal decision", () => {
  const now = new Date("2026-07-08T00:00:00Z");
  const docsById = new Map([
    ["canon", { kind: "constraint", tier: "canon", sourceTs: "2026-01-01T00:00:00Z" }],
    ["norm", { kind: "decision", tier: "normal", sourceTs: "2026-07-08T00:00:00Z" }],
  ]);
  const fused = new Map([["canon", 0.02], ["norm", 0.02]]);
  const out = adjustScores(fused, docsById, now);
  assert.equal(out[0].id, "canon");
});

test("CANON_BOOST exceeds the strongest kind prior (1.2) so canon wins its slot", () => {
  assert.ok(CANON_BOOST > 1.2);
});

test("entityRank: docs whose entity tags overlap the query rank; others score 0/absent", () => {
  const docs = [
    { id: "hit", entities: ["cursor", "mcp-config"] },
    { id: "miss", entities: ["gateway-auth"] },
  ];
  const ranked = entityRank(docs, "how is cursor scoped");
  assert.deepEqual(ranked.map((r) => r.id), ["hit"]);
});

test("entityRank returns [] when the query names no known entity", () => {
  assert.deepEqual(entityRank([{ id: "a", entities: ["cursor"] }], "unrelated nonsense"), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npm run build; node --test test/rank.test.mjs`
Expected: FAIL — `entityRank`/`CANON_BOOST` not exported; `adjustScores` ignores `tier`.

- [ ] **Step 3: Write the implementation**

In `gateway/src/rank.ts`, add the constant and generator, and widen `adjustScores`:

```ts
/** Canon tier boost (§5.3): a standing rule relevant to the query should
 *  essentially always clear a slot, so this sits above the strongest kind
 *  prior (1.2). Calibration target once retrieval_log accumulates data (§7). */
export const CANON_BOOST = 1.5;

/**
 * Entity candidate generator (§5.1, the third generator alongside BM25 and
 * cosine): a doc is a candidate when any token of any of its entity tags
 * appears in the query. Rescues canonical topics that paraphrase-embeddings
 * blur and multi-word tags BM25 splits. Score = overlap count (RRF only uses
 * rank, so exact magnitude is irrelevant).
 */
export function entityRank(
  docs: { id: string; entities: string[] }[],
  query: string,
): Scored[] {
  const qTerms = new Set(tokenize(query));
  if (qTerms.size === 0) return [];
  const out: Scored[] = [];
  for (const d of docs) {
    let overlap = 0;
    for (const e of d.entities) {
      if (tokenize(e).some((t) => qTerms.has(t))) overlap += 1;
    }
    if (overlap > 0) out.push({ id: d.id, score: overlap });
  }
  return out.sort((a, b) => b.score - a.score);
}
```

Change `adjustScores` to consume `tier` and apply the boost:

```ts
export function adjustScores(
  fused: Map<string, number>,
  docsById: Map<string, { kind: string; sourceTs: string; tier: string }>,
  now: Date,
): Scored[] {
  const out: Scored[] = [];
  for (const [id, score] of fused) {
    const doc = docsById.get(id);
    if (!doc) continue;
    let s = score * (KIND_PRIOR[doc.kind] ?? 1.0);
    if (doc.tier === "canon") s *= CANON_BOOST;
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd gateway && npm run build && node --test test/rank.test.mjs`
Expected: PASS (existing adjusted + 4 new). The existing `adjustScores` test passes `{kind, sourceTs}` literals with no `tier`; update those literals to include `tier: "normal"` so they typecheck.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/rank.ts gateway/test/rank.test.mjs
git commit -m "feat(gateway): canon-tier boost + entity-tag candidate generator"
```

---

### Task 4: Ingest rewrite — extract → embed → replaceBySource (`ingest.ts`)

**Files:**
- Modify: `gateway/src/ingest.ts`
- Test: `gateway/test/ingest.test.mjs` (extend)

**Interfaces:**
- Consumes: `extractFacts`, `GenText`, `ExtractedFact` (Task 1); `IndexedDoc`, `replaceBySource` (Task 2); `Embedder` (existing).
- Produces: `ingestEntries(db, embed, gen, space, project, entries)` — note the new `gen`
  parameter, inserted after `embed`. `ingestFiles`/`reindexSpace` gain a `gen` param too.

```ts
function factToDoc(space: string, project: string, entry: ParsedEntry, fact: ExtractedFact, idx: number, embedding: number[]): IndexedDoc
async function ingestEntries(db: IndexDb, embed: Embedder | null, gen: GenText | null, space: string, project: string, entries: ParsedEntry[]): Promise<number>
```

- [ ] **Step 1: Write the failing test** (append to `gateway/test/ingest.test.mjs`)

```js
import { fakeGenText } from "./helpers.mjs"; // merge with existing import

const twoFacts = JSON.stringify([
  { kind: "constraint", tier: "canon", body: "Cursor MCP config is project-scoped.", entities: ["cursor", "mcp-config"] },
  { kind: "context", tier: "normal", body: "Verified 2026-07-04.", entities: [] },
]);

test("ingestEntries extracts N facts per entry as docs rows with synthetic ids + source_id", async () => {
  const db = new MemoryIndexDb();
  const gen = fakeGenText({ "Cursor MCP": twoFacts });
  const entry = { author: "Skanda", type: "decision", timestamp: "2026-07-04T00:00:00Z",
    id: "e1", payload: "Cursor MCP config is project-scoped. Verified.", file: "context/memorylayer/skanda/e.md" };
  const n = await ingestEntries(db, fakeEmbed, gen, "s1", "memorylayer", [entry]);
  assert.equal(n, 2);
  const docs = await db.listDocs("s1", "memorylayer");
  assert.deepEqual(docs.map((d) => d.id).sort(), ["e1#0", "e1#1"]);
  assert.ok(docs.every((d) => d.sourceId === "e1"));
  assert.equal(docs.find((d) => d.id === "e1#0").tier, "canon");
  assert.equal(docs.find((d) => d.id === "e1#0").embedding.length, 16);
});

test("ingestEntries fail-open: no gen → one whole-entry normal fact (Phase A behavior)", async () => {
  const db = new MemoryIndexDb();
  const entry = { author: "A", type: "decision", timestamp: "2026-01-01T00:00:00Z",
    id: "e1", payload: "we picked D1", file: "context/p/a/f.md" };
  assert.equal(await ingestEntries(db, fakeEmbed, null, "s1", "p", [entry]), 1);
  const docs = await db.listDocs("s1", "p");
  assert.equal(docs[0].id, "e1#0");
  assert.equal(docs[0].body, "we picked D1");
  assert.equal(docs[0].tier, "normal");
});

test("ingestEntries is idempotent per entry: re-ingesting replaces the fact set", async () => {
  const db = new MemoryIndexDb();
  const entry = { author: "A", type: "decision", timestamp: "2026-01-01T00:00:00Z",
    id: "e1", payload: "Cursor MCP note", file: "context/p/a/f.md" };
  await ingestEntries(db, fakeEmbed, fakeGenText({ "Cursor MCP": twoFacts }), "s1", "p", [entry]);
  assert.equal((await db.listDocs("s1", "p")).length, 2);
  // second run, single-fact extraction → old e1#1 must be gone
  await ingestEntries(db, fakeEmbed, fakeGenText({ "Cursor MCP": JSON.stringify([
    { kind: "decision", tier: "normal", body: "single fact now", entities: [] },
  ]) }), "s1", "p", [entry]);
  const docs = await db.listDocs("s1", "p");
  assert.equal(docs.length, 1);
  assert.equal(docs[0].body, "single fact now");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npm run build; node --test test/ingest.test.mjs`
Expected: FAIL — `ingestEntries` arity/shape (no `gen`), ids are `e1` not `e1#0`.

- [ ] **Step 3: Write the implementation**

Replace `entryToDoc` with `factToDoc` and rewrite `ingestEntries` in `gateway/src/ingest.ts`
(add imports for `extractFacts`, `GenText`, `ExtractedFact`):

```ts
import { extractFacts, type GenText, type ExtractedFact } from "./extract.js";
```

```ts
export function factToDoc(
  space: string,
  project: string,
  entry: ParsedEntry,
  fact: ExtractedFact,
  idx: number,
  embedding: number[],
): IndexedDoc {
  const sourceId = entry.id || entry.file;
  return {
    id: `${sourceId}#${idx}`,
    space,
    project: slug(project),
    kind: fact.kind,
    tier: fact.tier,
    body: fact.body,
    sourceFile: entry.file,
    sourceAuthor: entry.author,
    sourceTs: entry.timestamp,
    embedding,
    supersededBy: null,
    createdAt: new Date().toISOString(),
    sourceId,
    entities: fact.entities,
  };
}

export async function ingestEntries(
  db: IndexDb,
  embed: Embedder | null,
  gen: GenText | null,
  space: string,
  project: string,
  entries: ParsedEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  let count = 0;
  for (const entry of entries) {
    const facts = await extractFacts(gen, entry);
    let vecs: number[][] = facts.map(() => []);
    if (embed) {
      try {
        vecs = await embed(facts.map((f) => f.body));
      } catch {
        // fail-open: index facts without vectors — BM25 still serves recall
      }
    }
    const docs = facts.map((f, i) => factToDoc(space, project, entry, f, i, vecs[i] ?? []));
    await db.replaceBySource(space, entry.id || entry.file, docs);
    count += docs.length;
  }
  return count;
}
```

Update `ingestFiles` and `reindexSpace` to accept and forward `gen`. In `ingestFiles`,
change the signature to `(env, db, embed, gen, sr, paths, headSha, fetchImpl, opts)` and
the inner call to `ingestEntries(db, embed, gen, sr.space, project, entries)`. In
`reindexSpace`, change the signature to `(env, db, embed, gen, sr, fetchImpl, opts)` and
forward `gen` to `ingestFiles`.

- [ ] **Step 4: Update Phase A ingest tests for the new arity**

The existing `ingest.test.mjs` calls `ingestEntries(db, fakeEmbed, "s1", ...)`,
`ingestFiles(env, db, fakeEmbed, SR, ...)`, `reindexSpace(env, db, fakeEmbed, SR, ...)`.
Insert `null` (or `fakeGenText(...)`) as the new `gen` argument in each existing call, and
update expected doc ids from `a.md`/entry-id to `<id>#0` where those tests assert ids.
For the `reindexSpace`/`ingestFiles` count assertions (which expect 2), keep `gen = null`
so each entry yields exactly one fact and the counts stay 2.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd gateway && npm run build && node --test test/ingest.test.mjs`
Expected: PASS (updated existing + 3 new)

- [ ] **Step 6: Commit**

```bash
git add gateway/src/ingest.ts gateway/test/ingest.test.mjs
git commit -m "feat(gateway): ingest extracts atomic facts per entry with idempotent replaceBySource"
```

---

### Task 5: Bindings + deps + write-path waitUntil (`env.ts`, `deps.ts`, `mcp.ts`, `router.ts`, `webhook.ts`, `reindex.ts`)

**Files:**
- Modify: `gateway/src/env.ts`, `gateway/src/deps.ts`, `gateway/src/mcp.ts`, `gateway/src/router.ts`, `gateway/src/webhook.ts`, `gateway/src/reindex.ts`
- Modify: `gateway/test/helpers.mjs` (makeEnv gains `genText`)
- Test: `gateway/test/deps.test.mjs` (new), `gateway/test/mcp.test.mjs` (extend)

**Interfaces:**
- Consumes: `GenText` (Task 1); `ingestEntries`/`ingestFiles`/`reindexSpace` new arity (Task 4).
- Produces:

```ts
// AiBinding: overloaded run() — embeddings AND text-gen.
// indexDeps(env) now returns { db, embed, gen: GenText | null }.
const EXTRACT_MODEL = "@cf/meta/llama-3.1-8b-instruct"
```

- [ ] **Step 1: Write the failing test** — `gateway/test/deps.test.mjs`

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { indexDeps } from "../dist/gateway/src/deps.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";

test("indexDeps resolves gen from env.AI text-gen; null when no AI", async () => {
  const calls = [];
  const env = {
    indexDb: new MemoryIndexDb(),
    AI: { async run(model, input) {
      calls.push({ model, input });
      return input.text ? { data: [[1]] } : { response: "[]" };
    } },
  };
  const deps = indexDeps(env);
  assert.ok(deps.gen);
  const out = await deps.gen("hello");
  assert.equal(out, "[]");
  assert.ok(calls.some((c) => c.input.prompt === "hello"));

  const noai = indexDeps({ indexDb: new MemoryIndexDb() });
  assert.equal(noai.gen, null);
});

test("indexDeps prefers the env.genText seam over env.AI", async () => {
  const deps = indexDeps({ indexDb: new MemoryIndexDb(), genText: async () => "seam" });
  assert.equal(await deps.gen("x"), "seam");
});
```

- [ ] **Step 2: Extend `gateway/test/mcp.test.mjs`** — assert write ingest is deferred to `ctx.waitUntil`

```js
test("write_context defers index ingest to ctx.waitUntil and still returns success", async () => {
  const calls = [];
  const env = makeEnv(/* existing github routes that accept a write */ ghWriteRoutes(calls), {
    indexDb: new MemoryIndexDb(),
    embedder: fakeEmbed,
    genText: async () => JSON.stringify([{ kind: "decision", tier: "normal", body: "f", entities: [] }]),
  });
  const deferred = [];
  const ctx = { waitUntil: (p) => deferred.push(p) };
  const res = await handleMcp(writeReq("memorylayer", "we decided X"), env, ctx);
  const body = await res.json();
  assert.match(body.result.content[0].text, /Recorded decision/);
  // ingest has NOT run yet — it was deferred
  assert.equal((await env.indexDb.listDocs("s1", "memorylayer")).length, 0);
  await Promise.all(deferred); // drain the background task
  assert.equal((await env.indexDb.listDocs("s1", "memorylayer")).length, 1);
});
```

(Use the file's existing write-request + github-route helpers; if none is exported, mirror
the pattern already used by the Phase A `write_context` test in this file.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd gateway && npm run build; node --test test/deps.test.mjs test/mcp.test.mjs`
Expected: FAIL — `deps.gen` undefined; `handleMcp` ignores `ctx`.

- [ ] **Step 4: Implement — `env.ts`**

Overload `AiBinding.run` for text-gen and add the `genText` seam:

```ts
/** Minimal Workers AI surface: embeddings and text generation. */
export interface AiBinding {
  run(model: string, input: { text: string[] }): Promise<{ data: number[][] }>;
  run(model: string, input: { prompt: string }): Promise<{ response: string }>;
}
```

In the `Env` interface add:

```ts
  /** Test seam: injected text-gen. Production leaves it unset (uses AI). */
  genText?: (prompt: string) => Promise<string>;
```

- [ ] **Step 5: Implement — `deps.ts`**

```ts
import type { GenText } from "./extract.js";

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EXTRACT_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export function indexDeps(
  env: Env,
): { db: IndexDb; embed: Embedder | null; gen: GenText | null } | null {
  const db = env.indexDb ?? (env.DB ? d1IndexDb(env.DB) : null);
  if (!db) return null;
  const embed =
    env.embedder ??
    (env.AI ? async (texts: string[]) => (await env.AI!.run(EMBED_MODEL, { text: texts })).data : null);
  const gen: GenText | null =
    env.genText ??
    (env.AI ? async (prompt: string) => (await env.AI!.run(EXTRACT_MODEL, { prompt })).response : null);
  return { db, embed, gen };
}
```

- [ ] **Step 6: Implement — `router.ts` + `mcp.ts`**

In `router.ts`, pass `ctx`: `if (req.method === "POST") return handleMcp(req, env, ctx);`

In `mcp.ts`: change `handleMcp(req, env)` → `handleMcp(req, env, ctx?)` and thread `ctx`
into `toolsCall(msg, member, env, ctx)`. In the `write_context` case, replace the inline
`await ingestEntries(...)` block with a deferred task, and thread `gen`:

```ts
        const runIngest = async () => {
          try {
            const deps = indexDeps(env);
            if (deps) {
              await ingestEntries(deps.db, deps.embed, deps.gen, member.space, project, [entry]);
            }
          } catch {
            // swallow: reconcile cron / webhook re-derive from the ledger
          }
        };
        if (ctx) ctx.waitUntil(runIngest());
        else await runIngest(); // tests / no-ctx runtime: keep read-your-own-writes
```

(Keep the best-effort `ROUTING.delete` cache invalidation exactly as is, before the ingest.)

- [ ] **Step 7: Implement — thread `gen` through `webhook.ts` and `reindex.ts`**

Both call `ingestFiles`/`reindexSpace`. Resolve `deps` via `indexDeps(env)` (they already
do for `db`/`embed`) and pass `deps.gen` as the new argument. Update
`handleAdminReindex` and `reconcileAll` call sites accordingly. No behavior change beyond
carrying `gen`.

- [ ] **Step 8: Update `makeEnv` in `helpers.mjs`**

Ensure `makeEnv(routes, overrides)` spreads `genText`, `indexDb`, `embedder` from
`overrides` onto the returned env (it already does for `indexDb`/`embedder` per Phase A;
add `genText`).

- [ ] **Step 9: Run tests to verify they pass**

Run: `cd gateway && npm run build && node --test test/deps.test.mjs test/mcp.test.mjs test/webhook.test.mjs test/reindex.test.mjs`
Expected: PASS (existing + new; webhook/reindex unchanged behavior)

- [ ] **Step 10: Commit**

```bash
git add gateway/src/env.ts gateway/src/deps.ts gateway/src/mcp.ts gateway/src/router.ts gateway/src/webhook.ts gateway/src/reindex.ts gateway/test/helpers.mjs gateway/test/deps.test.mjs gateway/test/mcp.test.mjs
git commit -m "feat(gateway): Workers AI text-gen binding + async waitUntil write-path ingest"
```

---

### Task 6: Briefing + topic manifest (`retrieval.ts` render helper, `hook-read.ts`)

**Files:**
- Modify: `gateway/src/retrieval.ts` (add `renderBriefing`)
- Modify: `gateway/src/hook-read.ts`
- Test: `gateway/test/retrieval.test.mjs` (extend), `gateway/test/hook-read.test.mjs` (extend)

**Interfaces:**
- Consumes: `IndexedDoc` (Task 2); `entityRank` (Task 3); `estimateTokens`, `ENTRY_OVERHEAD_TOKENS` (existing).
- Produces:

```ts
function renderBriefing(project: string, docs: IndexedDoc[], budgetTokens: number, now: Date): string
```

This task also wires Task 3's `entityRank` into the live `retrieve()` pipeline (the
candidate generator is dead code until unioned into the RRF inputs).

- [ ] **Step 0: Wire the entity candidate generator into `retrieve()`**

In `gateway/src/retrieval.ts`, import `entityRank` from `./rank.js` and add it as a third
candidate list. Change:

```ts
  const lists: Scored[][] = [bm25Rank(docs, opts.query)];
  if (deps.embed) {
    try {
      const [queryVec] = await deps.embed([opts.query]);
      lists.push(cosineTopK(docs, queryVec ?? []));
    } catch {
      // fail-open: BM25 alone still rescues exact-term matches (§5.1)
    }
  }
```

to also push `lists.push(entityRank(docs, opts.query));` after the cosine block. Add a
retrieval test asserting a doc whose ONLY query overlap is an entity tag (no BM25 term
match, `embed: null`) is still retrieved:

```js
test("entity-tag rescue: a fact retrievable only by its entity tag still surfaces", async () => {
  const db = new MemoryIndexDb();
  await db.replaceBySource("s1", "e1", [{
    id: "e1#0", space: "s1", project: "memorylayer", kind: "constraint", tier: "normal",
    body: "Config is project-scoped, not global.", sourceFile: "f", sourceAuthor: "Skanda",
    sourceTs: "2026-06-01T00:00:00Z", embedding: [], supersededBy: null,
    createdAt: "2026-07-08T00:00:00Z", sourceId: "e1", entities: ["cursor"],
  }]);
  const { results } = await retrieve(
    { db, embed: null }, // no BM25 overlap ("cursor" absent from body), no vectors
    { space: "s1", project: "memorylayer", query: "cursor", budgetTokens: 4000, trigger: "test" },
  );
  assert.equal(results[0].doc.id, "e1#0");
});
```

- [ ] **Step 1: Write the failing test** (append to `gateway/test/retrieval.test.mjs`)

```js
import { renderBriefing } from "../dist/gateway/src/retrieval.js"; // merge with existing import

function bdoc(id, kind, tier, body, entities, sourceTs) {
  return { id, space: "s1", project: "memorylayer", kind, tier, body,
    sourceFile: `context/memorylayer/skanda/${id}.md`, sourceAuthor: "Skanda",
    sourceTs, embedding: [], supersededBy: null, createdAt: "2026-07-08T00:00:00Z",
    sourceId: id, entities };
}

test("renderBriefing includes canon, open questions, 7-day decisions, and a topic manifest", () => {
  const now = new Date("2026-07-08T00:00:00Z");
  const docs = [
    bdoc("c", "constraint", "canon", "Infra cost must stay $0/free-tier.", ["infra-cost"], "2026-02-01T00:00:00Z"),
    bdoc("q", "question", "normal", "Should preferences travel across spaces?", ["multi-space"], "2026-07-07T00:00:00Z"),
    bdoc("d", "decision", "normal", "Chose D1 for the index.", ["d1", "index"], "2026-07-07T00:00:00Z"),
    bdoc("old", "decision", "normal", "Ancient decision.", ["legacy"], "2026-01-01T00:00:00Z"),
  ];
  const text = renderBriefing("memorylayer", docs, 4000, now);
  assert.match(text, /Infra cost must stay \$0/);      // canon always shown
  assert.match(text, /Should preferences travel/);      // open question
  assert.match(text, /Chose D1 for the index/);         // recent decision (<7d)
  assert.doesNotMatch(text, /Ancient decision/);        // >7d decision excluded from the recent section
  assert.match(text, /memory covers:/);                 // topic manifest line
  assert.match(text, /infra-cost \(1\)/);               // manifest counts entities
});

test("renderBriefing on an empty index returns an empty string (caller falls back)", () => {
  assert.equal(renderBriefing("memorylayer", [], 4000, new Date()), "");
});
```

- [ ] **Step 2: Extend `gateway/test/hook-read.test.mjs`** — briefing path + fail-open fallback

```js
test("/hook/read serves the index briefing when facts exist", async () => {
  const db = new MemoryIndexDb();
  await db.replaceBySource("s1", "c", [{
    id: "c#0", space: "s1", project: "memorylayer", kind: "constraint", tier: "canon",
    body: "Infra cost must stay $0.", sourceFile: "f", sourceAuthor: "Skanda",
    sourceTs: "2026-02-01T00:00:00Z", embedding: [], supersededBy: null,
    createdAt: "2026-07-08T00:00:00Z", sourceId: "c", entities: ["infra-cost"],
  }]);
  const env = makeEnv(hookGhRoutes([]), { indexDb: db });
  const res = await handleHookRead(hookReq("memorylayer"), env);
  const text = await res.text();
  assert.match(text, /loaded automatically at session start/); // preamble kept
  assert.match(text, /Infra cost must stay \$0/);
  assert.match(text, /memory covers:/);
});

test("/hook/read falls back to the recency dump when the index is empty/unconfigured", async () => {
  // No indexDb → deps null → must use readEntries recency path (Phase A behavior)
  const env = makeEnv(hookGhRoutesWithEntries(), {}); // routes return ledger entries
  const res = await handleHookRead(hookReq("memorylayer"), env);
  const text = await res.text();
  assert.match(text, /loaded automatically at session start/);
  // recency projection marker (projectContext output), NOT the manifest
  assert.doesNotMatch(text, /memory covers:/);
});
```

(Reuse the file's existing hook-request / github-route helpers; if the Phase A
`hook-read.test.mjs` already defines `hookReq`/route builders, use those names.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd gateway && npm run build; node --test test/retrieval.test.mjs test/hook-read.test.mjs`
Expected: FAIL — `renderBriefing` missing; `/hook/read` never emits a manifest.

- [ ] **Step 4: Implement `renderBriefing` in `retrieval.ts`**

```ts
const BRIEFING_RECENT_DECISION_DAYS = 7;

/**
 * The session-start briefing (§6): selective, not a dump. Canon facts (always,
 * budget-permitting) + open questions + decisions from the last 7 days + a
 * one-line topic manifest so an agent can see what the store knows and pull
 * mid-session. Returns "" on an empty corpus so the caller can fail-open to
 * the recency read.
 */
export function renderBriefing(
  project: string,
  docs: IndexedDoc[],
  budgetTokens: number,
  now: Date,
): string {
  if (docs.length === 0) return "";

  const canon = docs.filter((d) => d.tier === "canon");
  const questions = docs.filter((d) => d.kind === "question");
  const cutoff = now.getTime() - BRIEFING_RECENT_DECISION_DAYS * 86_400_000;
  const recentDecisions = docs.filter(
    (d) => d.kind === "decision" && Date.parse(d.sourceTs) >= cutoff,
  );

  const manifest = new Map<string, number>();
  for (const d of docs) for (const e of d.entities) manifest.set(e, (manifest.get(e) ?? 0) + 1);
  const manifestLine =
    manifest.size > 0
      ? "memory covers: " +
        [...manifest.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([e, n]) => `${e} (${n})`)
          .join(", ")
      : "";

  const section = (title: string, items: IndexedDoc[]): string[] => {
    if (items.length === 0) return [];
    const lines: string[] = [`## ${title}`];
    let used = 0;
    for (const d of items) {
      const cost = estimateTokens(d.body) + ENTRY_OVERHEAD_TOKENS;
      if (lines.length > 1 && used + cost > budgetTokens) break;
      lines.push(`- ${d.body} _(${d.sourceAuthor}, ${d.sourceTs.slice(0, 10)})_`);
      used += cost;
    }
    return lines;
  };

  const parts = [
    `# Memory briefing: ${project}`,
    ...(manifestLine ? [manifestLine] : []),
    ...section("Standing rules (canon)", canon),
    ...section("Open questions", questions),
    ...section("Recent decisions (last 7 days)", recentDecisions),
  ];
  // If only the header/manifest survived (no sections), still return it — the
  // manifest alone is useful; empty-corpus already returned "" above.
  return parts.join("\n\n");
}
```

- [ ] **Step 5: Rewrite `handleHookRead` to prefer the briefing**

In `gateway/src/hook-read.ts`, after the cache miss and before the recency read, try the
index briefing; fall back to recency on empty/failure:

```ts
  const budgetParam = Number(url.searchParams.get("budget"));
  const budget =
    Number.isFinite(budgetParam) && budgetParam > 0 ? budgetParam : DEFAULT_BUDGET_TOKENS;

  const preamble =
    `The following is shared planning memory (MemoryLayer) for project "${project}", ` +
    `loaded automatically at session start. Treat these recorded decisions and context ` +
    `as already-known; do not ask the user to re-explain them.\n\n`;

  let text = "";
  try {
    const deps = indexDeps(env);
    if (deps) {
      const docs = await deps.db.listDocs(member.space, slug(project));
      const briefing = renderBriefing(project, docs, budget, new Date());
      if (briefing) text = preamble + briefing;
    }
  } catch {
    // fall through to the recency dump
  }

  if (text === "") {
    const { entries, total } = await readEntries(env, member, project, budget, env.githubFetch ?? fetch);
    text = total === 0 ? "" : preamble + projectContext(project, entries, total);
  }

  await env.ROUTING.put(cacheKey, text, { expirationTtl: CACHE_TTL_SECONDS });
  return asText(text);
```

Add imports at the top of `hook-read.ts`: `indexDeps` from `./deps.js`, `renderBriefing`
from `./retrieval.js`, `slug` from `../../src/slug.js`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd gateway && npm run build && node --test test/retrieval.test.mjs test/hook-read.test.mjs`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add gateway/src/retrieval.ts gateway/src/hook-read.ts gateway/test/retrieval.test.mjs gateway/test/hook-read.test.mjs
git commit -m "feat(gateway): session-start briefing + topic manifest with recency fallback"
```

---

### Task 7: Full-suite gate, backfill runbook, docs

**Files:**
- Modify: `gateway/README.md`
- No source changes (verification + docs task).

**Interfaces:** none.

- [ ] **Step 1: Run the whole gateway suite**

Run: `cd gateway && npm test`
Expected: PASS — all suites green (Phase A + all B1). If any Phase A test fails on the
widened `IndexedDoc`/`ingestEntries`/`adjustScores` shapes, fix the literal/arity at the
call site (do not weaken the assertion).

- [ ] **Step 2: Run the root gates**

Run (from repo root): `npm test && npm run lint && npm run typecheck && npm run format:check`
Expected: root suite 118/118 (unchanged — B1 touches no root source), lint/typecheck/format PASS.

- [ ] **Step 3: Document the model, migration, and one-time backfill in `gateway/README.md`**

Add a "Phase B — facts & briefing" subsection stating: (a) ingest now extracts atomic
facts via Workers AI `@cf/meta/llama-3.1-8b-instruct` ($0 free-tier), embeds with
`bge-base-en-v1.5`, fail-open to whole-entry indexing; (b) apply the new migration with
`wrangler d1 migrations apply memorylayer-index` (local and `--remote`); (c) one-time
backfill: after deploy, `POST /admin/reindex` per space rebuilds every fact from the
ledger — paginate with `limit`/`nextOffset` for large spaces (existing reindex contract);
(d) the briefing replaces the recency dump on `/hook/read` and falls back to recency when
the index is empty/unavailable.

- [ ] **Step 4: Commit**

```bash
git add gateway/README.md
git commit -m "docs(gateway): Phase B1 model, migration, and backfill runbook"
```

- [ ] **Step 5: Deploy-time backfill (operator, not automated in this plan)**

After `wrangler deploy` + `wrangler d1 migrations apply memorylayer-index --remote`, run
`POST /admin/reindex` for the `memorylayer` space to extract facts from the ~70 existing
ledger entries. Verify: `search_memory` with the Cursor query returns the atomic
project-scoped config fact, and `/hook/read` shows a topic manifest. This is the B1 exit
gate's input — the extraction-fidelity audit samples these backfilled facts against their
source entries.

---

## Self-Review

**Spec coverage** (checked against `2026-07-08-phase-b1-facts-briefing-design.md`):
- §2.1 extraction + fail-open floor → Task 1. ✓
- §2.2 AiBinding text-gen + genText seam → Task 5. ✓
- §2.3 ingest extract→embed→replaceBySource → Task 4. ✓
- §2.4 mcp waitUntil + ctx → Task 5. ✓
- §2.5 canon boost + entity candidates → Task 3 (rank) wired in retrieval via Task 4/6 consumers. **Gap check:** the entity candidate list must actually be unioned into `retrieve()`'s RRF inputs. Covered below by the retrieval wiring note.
- §2.6 briefing + manifest + fallback → Task 6. ✓
- §2.7 schema 0002 → Task 2. ✓
- §5 tests → each task's tests + Task 7 gate. ✓
- §6 exit (fidelity audit on backfill) → Task 7 Step 5. ✓

**Resolved in self-review (entity candidates into the pipeline):** Task 3 produces
`entityRank`, but `retrieve()` must union it into the RRF lists for it to affect ranking —
otherwise the entity generator is dead code. This is now **Task 6 Step 0** (the pipeline
edit + an entity-rescue retrieval test), since Task 6 already owns `retrieval.ts`. The
canon + entity work is therefore exercised end-to-end.

**Placeholder scan:** no TBD/TODO; all code blocks complete; canon boost = 1.5, extract
model pinned. ✓

**Type consistency:** `ingestEntries(db, embed, gen, space, project, entries)` arity is
consistent across Tasks 4/5; `IndexedDoc` gains `sourceId`+`entities` in Task 2 and every
later literal includes them; `adjustScores` third-map-field `tier` added in Task 3 and
supplied by `retrieve()` (which builds `byId` from full `IndexedDoc`s that carry `tier`). ✓
