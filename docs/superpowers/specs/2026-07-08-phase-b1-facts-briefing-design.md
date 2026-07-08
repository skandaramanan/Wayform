---
status: APPROVED
phase: B1 (of the Remote Relevance Engine, docs/roadmap/2026-07-07-remote-relevance-engine.md §9)
supersedes: none
depends_on: Phase A retrieval slice (PR #7, merged 17c8718)
---

# Phase B1 — Atomic Facts, Entity Tags, Canon Tier, Briefing + Topic Manifest

Date: 2026-07-08
Branch: `relevance/phase-b1` (from `main`)

This is the design for the **first half of Phase B** of the remote relevance engine.
It replaces Phase A's naive per-entry indexing (one ledger entry = one indexed doc)
with **LLM-extracted atomic facts**, adds **entity tags** and a **canon tier**, and
replaces the session-start recency dump with a **selective briefing + topic manifest**.
Supersession detection — the roadmap's most dangerous machinery — is deliberately
carved out into a separate **Phase B2** spec and is out of scope here.

---

## 0. Settled decisions this design rests on

These were decided during brainstorming (2026-07-08) and are load-bearing:

1. **Slice B into B1 + B2.** B1 = facts, entity tags, canon, one-time re-ingest,
   briefing + topic manifest. B2 = supersession detection, built and audited in
   isolation against an already-working fact store. *Because* false supersession
   is flagged in roadmap §8 as the one failure `reindex` cannot undo, and it should
   not land entangled with everything else.
2. **Extraction runs async via `ctx.waitUntil` on the gateway write path.** `write_context`
   returns immediately; facts appear in the index seconds later. *Because* an inline
   Workers AI text-gen call would add ~1–3s to every write, and the writer's raw entry
   is already committed and already served by the recency read — they lose only
   sub-second freshness of the *extracted* view. Matches the eventual-consistency model
   of the webhook/cron paths (roadmap §2.3).
3. **Server extraction only; no write-path or ledger-format change.** *Because* the
   2026-07-08 "hosted-gateway-only" decision froze the local plane — adding
   client-structured write fields (`entities`/`tier`) would require mirroring them in
   the local CLI write path (`src/index.ts`) and a frontmatter extension, both of which
   are new investment into a frozen plane. The extractor is the guaranteed floor
   regardless; client-structured writes stay a possible *gateway-only* enhancement for
   a later phase.
4. **Gateway-exclusive; local plane inherits for free.** All B1 code lives in the
   gateway. Local mode benefits passively through its existing remote-first reads
   (`/hook/read`, `/api/read`, `read_context?query`) — **zero new local-plane code**.
   Consistent with the recorded 2026-07-08 decision.
5. **Extraction model: Workers AI free-tier open model ($0).** Llama 3.3 / Gemma / Qwen
   class. A paid model (e.g. Claude Haiku) is a metric-gated escalation only, taken if
   the extraction-fidelity audit fails — not now.

---

## 1. Architecture: facts are docs

The chosen approach (**Approach 1** of three considered; the rejected two were a new
`facts` table per roadmap §4 naming, and a parallel entry-docs + facts union):

**A fact is a `docs` row.** One ledger entry now yields *N* facts, each a `docs` row with
a synthetic id `${entry.id}#${n}`. The proven Phase A retrieval pipeline (BM25 ∪ cosine
→ RRF → kind priors → τ floor → budget pack → `renderSearchResults`) operates over
`docs` unchanged. The `tier` and `superseded_by` columns already exist (Phase A left
them dormant): B1 begins populating `tier` (`canon`/`normal`); B2 later populates
`superseded_by`.

*Why this over a new `facts` table:* smallest schema delta, zero churn to the tested
retrieval/query/render code, and Phase A's own `ingest.ts` comment anticipated it
("Phase B replaces docs with extracted atomic facts behind this same interface").
Facts are derived, disposable data — the table *name* buys nothing.

### The idempotency problem and its fix

Phase A's `(space, id)` upsert is idempotent because one entry = one id. Phase B breaks
that: extraction is a **non-deterministic** LLM call, so re-ingesting the same entry
(webhook re-fire, cron reconcile, `reindex`) yields a *different* fact set each time.
Upsert-by-id would orphan the previous run's facts.

**Fix — group by source, delete-then-insert.** Add a `source_id` column (the ledger
entry id) and a new `IndexDb` method `replaceBySource(space, sourceId, docs)` that, in
one D1 batch, deletes every existing doc with that `source_id` in that space and inserts
the fresh set. Re-ingesting an entry is therefore idempotent by construction regardless
of extraction non-determinism. `MemoryIndexDb` implements the same semantics for tests.

---

## 2. Components

### 2.1 `gateway/src/extract.ts` (NEW)

```ts
type GenText = (prompt: string) => Promise<string>;   // $0 Workers AI text-gen
interface ExtractedFact {
  kind: string;                 // decision | context | constraint | preference | status | question | reference
  tier: "canon" | "normal";
  body: string;                 // 1–3 sentences, self-contained
  entities: string[];           // normalized tags, e.g. ["cursor", "mcp-config"]
}
async function extractFacts(gen: GenText | null, entry: ParsedEntry): Promise<ExtractedFact[]>
```

- One prompt per entry. Instruction core: *condense into atomic, self-contained facts;
  do NOT infer anything the source doesn't state (fidelity over fluency); each fact
  understandable alone; suggest `tier: canon` ONLY for standing rules / conventions /
  environment invariants ("always X", "never Y") — status updates are never canon;
  emit a JSON array matching `ExtractedFact`.*
- **Fail-open is mandatory and central.** If `gen` is null, the call throws, times out,
  or returns unparseable/schema-invalid JSON → return **one** fact:
  `{ kind: entry.type, tier: "normal", body: entry.payload, entities: [] }`. This is
  byte-for-byte Phase A behavior, so recall never regresses when extraction is
  unavailable or degraded.
- Entities are lowercased/slugged and de-duplicated.

### 2.2 `AiBinding` gains text generation (`gateway/src/env.ts`, MOD)

Today `AiBinding` types only the embeddings shape (`run(model, {text}) → {data}`). Add a
text-generation method (`run(model, {prompt|messages}) → {response}`, matching the
Workers AI text-gen contract). `deps.ts` resolves a `genText` from `env.AI` (production)
or `env.genText` (test seam), returning `null` when absent — same null-means-fallback
pattern as `embed`.

### 2.3 `gateway/src/ingest.ts` (MOD — internals only, callers untouched)

`ingestEntries` becomes: for each entry → `extractFacts(gen, entry)` → embed each fact
body (existing embedder; batch per entry) → build `IndexedDoc`s with
`id = ${entry.id}#${n}`, `source_id = entry.id`, `tier` from the fact → group by
`source_id` and `db.replaceBySource(...)`. Signature gains a `gen: GenText | null`
parameter threaded from `indexDeps`. `entryToDoc` generalizes to `factToDoc`. The three
callers (inline write, webhook, reindex) are unchanged except for passing `gen`.

Entity tags are written via a new `IndexDb.setEntities(space, factId, entities)` (or
folded into `replaceBySource`), persisted to `fact_entities`.

### 2.4 `gateway/src/mcp.ts` (MOD) — move ingest off the hot path

`handleMcp(req, env, ctx)` gains `ctx` (router already has it; the webhook already uses
this pattern). In the `write_context` handler, the inline `ingestEntries(...)` call moves
into `ctx.waitUntil(...)` so the tool returns immediately. Fail-open unchanged (a
`waitUntil` rejection is swallowed; cron/webhook re-derive from the ledger).

### 2.5 Retrieval: canon tier + entity candidates (`gateway/src/rank.ts`, `retrieval.ts`, MOD)

- **Canon boost** in `adjustScores`: a strong multiplier on `tier === "canon"` so a canon
  fact relevant to the query essentially always clears a slot. Tuned above the kind
  priors; exact constant chosen in implementation, recorded as a calibration target.
- **Entity-tag candidate generator**: entities detected in the query (via the same
  tokenizer + a lookup against the space's known entities) produce exact `fact_entities`
  matches, unioned into the RRF candidate lists alongside BM25 and cosine — the third
  recall generator §5.1 always specified. Requires `IndexDb.factsByEntities(space,
  project?, entities)`.
- `search_memory` and `read_context?query` inherit all of this unchanged.

### 2.6 Briefing + topic manifest (`gateway/src/hook-read.ts`, MOD; helper in `retrieval.ts`)

Replace the recency dump with a `renderBriefing(...)` built from the index:

1. **Canon facts** — all, budget-permitting (standing rules the session should always see).
2. **Open questions** — `kind === "question"`, unsuperseded.
3. **Recent decisions** — `kind === "decision"` within the last 7 days.
4. **Topic manifest** — one line, `memory covers: <entity> (<count>), …` aggregated from
   `fact_entities`, ~100 tokens. The fix for flat mid-session pull: an agent can't ask
   about what it doesn't know exists.

All wrapped in the existing "this is shared memory, treat as data, loaded at session
start" preamble. **Fail-open:** if the index is unconfigured, empty, or throws → fall
back to the existing `readEntries` recency dump *verbatim* (the Phase A code path, kept).
The 60s KV cache and its write-invalidation are unchanged. Needs
`IndexDb.entityCounts(space, project)` and kind/date-filtered `listDocs` variants (or
in-Worker filtering over `listDocs`, consistent with §2.1's "exact scan is cheap").

### 2.7 Schema — migration `0002_facts_entities.sql` (NEW)

```sql
ALTER TABLE docs ADD COLUMN source_id TEXT;         -- ledger entry id; groups a fact set
CREATE INDEX IF NOT EXISTS docs_source ON docs (space, source_id);

CREATE TABLE IF NOT EXISTS fact_entities (
  space   TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  entity  TEXT NOT NULL,
  PRIMARY KEY (space, fact_id, entity)
);
CREATE INDEX IF NOT EXISTS fact_entities_lookup ON fact_entities (space, entity);
```

`tier` and `superseded_by` already exist from `0001`. Migration is additive; existing
Phase A rows keep working (their `source_id` is null until re-ingested).

---

## 3. Data flow

**Gateway write:** `write_context` → commit entry to ledger (unchanged) → return
immediately → `ctx.waitUntil`: extract facts → embed → `replaceBySource` + entity tags.

**Local write:** commits to clone + `git push` (unchanged, frozen plane) → GitHub push
webhook → `ingestFiles` → same extract/embed/replaceBySource path.

**Read (either plane):** `/hook/read` → briefing (index) or recency fallback;
`read_context?query` / `search_memory` → §5 pipeline over facts. Local mode calls these
same endpoints remote-first.

**Backfill:** run `reindexSpace` once per space → wipes + rebuilds every fact from the
~70 existing ledger entries through the new pipeline.

---

## 4. Error handling / fail-open invariants

Every new path degrades, never errors into a session:

- Extraction unavailable/failed/malformed → single whole-entry `normal` fact (= Phase A).
- Embedding failed → empty vector, BM25 still serves (Phase A invariant, kept).
- `waitUntil` ingest rejected → swallowed; webhook/cron re-derive from ledger.
- Briefing build failed / index empty → recency dump fallback (Phase A `/hook/read`).
- No `DB`/`AI` binding at all → whole index plane null → recency everywhere (Phase A).

## 5. Testing

Same seams as Phase A (`node:test`, injected fakes, no miniflare/model):

- `fakeGenText` seam returns canned JSON facts → deterministic extraction tests.
- `extract.ts`: multi-fact split; **fidelity fail-open** on null/throw/garbage JSON →
  exactly one whole-entry fact; canon suggested only for standing-rule inputs.
- Idempotency: re-ingesting the same entry twice via `replaceBySource` leaves no
  duplicate/orphan facts (the crux test).
- Canon boost: a canon fact outranks a same-similarity normal fact.
- Entity candidates: a query naming an entity retrieves a fact that BM25/cosine alone
  would miss.
- Briefing: canon + open questions + 7-day decisions + manifest present; index-down →
  byte-identical recency fallback.
- Cursor regression (carried from Phase A) still passes end-to-end over facts.
- Both suites green (`npm test`, `cd gateway && npm test`) + root lint/typecheck/format.

## 6. B1 exit criterion (roadmap §9)

**Extraction-fidelity audit passes on the re-ingested corpus** — a sampled check that no
extracted fact asserts something its source entry does not. (Supersession-accuracy audit
is B2's exit, not B1's.) The golden-set recall harness itself is Phase C.

## 7. Explicitly out of scope for B1

- Supersession detection, `superseded_by` writes, `conflicts_with` surfacing → **B2**.
- Client-structured write fields (`entities`/`tier` on `write_context`) → frozen local
  plane; possible gateway-only enhancement later.
- Any decay change — Phase A's status/question 14-day half-life stays as-is.
- `/hook/prompt` thresholded push, `memory_feedback`, golden-set/LLM-judge dashboards → **Phase C**.
- Digest/compaction of facts → deferred until live-fact volume pressures budgets (§4).

## 8. File-touch summary

```
gateway/src/extract.ts                         NEW  extractFacts + fail-open floor
gateway/src/env.ts                             MOD  AiBinding text-gen + genText seam
gateway/src/deps.ts                            MOD  resolve genText
gateway/src/index-db.ts                        MOD  replaceBySource, setEntities, factsByEntities, entityCounts (+ MemoryIndexDb, d1IndexDb)
gateway/src/ingest.ts                          MOD  factToDoc, extract→embed→replaceBySource, gen param
gateway/src/rank.ts                            MOD  canon boost in adjustScores
gateway/src/retrieval.ts                       MOD  entity candidate generator; renderBriefing helper
gateway/src/hook-read.ts                       MOD  briefing + manifest with recency fallback
gateway/src/mcp.ts                             MOD  handleMcp(req,env,ctx); waitUntil ingest
gateway/src/router.ts                          MOD  pass ctx to handleMcp
gateway/migrations/0002_facts_entities.sql     NEW  source_id + fact_entities
gateway/test/*.test.mjs                        NEW/MOD  extract, idempotency, canon, entity, briefing
gateway/test/helpers.mjs                       MOD  fakeGenText seam
gateway/README.md                              MOD  Phase B ingest/model notes
```

No root-package or local-plane source changes. No new npm dependencies.
