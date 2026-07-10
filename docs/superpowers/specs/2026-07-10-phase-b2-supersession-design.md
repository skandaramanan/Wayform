---
status: APPROVED
phase: B2 (of the Remote Relevance Engine, docs/roadmap/2026-07-07-remote-relevance-engine.md §9)
supersedes: none
depends_on: Phase B1 facts & briefing (PR #8 + fixes #9–#11, merged 4afc260)
approved: 2026-07-10
---

# Phase B2 — Supersession Detection, `superseded_by` Lifecycle, `conflicts_with` Surfacing

Date: 2026-07-10
Branch: `relevance/phase-b2` (from `main`)

This is the design for the **second half of Phase B** of the remote relevance engine.
It adds **fact lifecycle**: when a new ledger entry (or its extracted facts) replaces an
older decision, the old fact is hidden from every default retrieval via `superseded_by`.
When a new entry **contradicts** an older fact without clearly replacing it, the write
response surfaces `conflicts_with` so the author can resolve it deliberately — never
auto-linking on uncertainty.

Phase B1 shipped extraction, entity tags, canon tier, and briefing. B2 activates the
`superseded_by` column B1 left dormant and closes the roadmap's most dangerous failure
mode: **false supersession silently hides live facts** (§8).

---

## 0. Settled decisions this design rests on

These were decided during the 2026-07-08 B-split brainstorm and the roadmap; B2 does not
re-litigate them:

1. **B2 is isolated from B1.** Supersession lands only after atomic facts, entity tags,
   and `replaceBySource` idempotency are proven. *Because* false supersession is the one
   index-plane failure `reindex` cannot undo by itself — it must be built and audited on
   its own.
2. **Conservative judge policy.** Similarity is **only** a candidate generator; the
   *decision* is an LLM that reads both facts. Auto-link (`superseded_by` write) happens
   **only** on a clear **replaces** verdict. **Contradicts**, **relates**, and
   **uncertain** never auto-link. *Because* hiding a live fact is worse than surfacing
   noise.
3. **Entity-scoped candidates first.** Supersession candidates are live facts in the
   same `(space, project)` sharing ≥1 entity tag with the new fact. Project-wide cosine
   fallback only when the new fact has zero entities (fail-open to whole-entry facts).
4. **Gateway-exclusive; local plane inherits.** All B2 code lives in the gateway. Local
   mode benefits through remote-first reads that already filter `superseded_by IS NULL`.
   No root-package or local CLI write-path changes.
5. **Judge model: Workers AI free-tier ($0).** Reuse the B1 extraction stack
   (`@cf/meta/llama-3.3-70b-instruct-fp8-fast` via the existing `genText` seam). Paid-model
   escalation is metric-gated only if the supersession-accuracy audit fails — not now.
6. **Sync conflict surfacing on every write, async auto-linking.** `write_context` always
   runs a synchronous pre-check (~100–500 ms) after ledger commit: embed the raw
   payload, cosine-rank live facts, LLM-judge the top candidates, surface **contradicts**
   and **uncertain** in the tool response. Full supersession linking runs in the existing
   `ctx.waitUntil` ingest path after extraction. *Because* the roadmap requires
   `conflicts_with` in the write response, but inline extraction + judge on every write
   would reintroduce B1's 1–3 s latency.
7. **Author `supersedes` override (gateway MCP).** Optional `supersedes: string[]` on
   `write_context` — explicit fact ids the author asserts this entry replaces. Skips sync
   conflict checks for those ids; async path links without judge. *Because* agents that
   already know what they're replacing shouldn't wait for or fight the judge.
8. **Operator recovery is first-class.** `clearSupersession` on reindex **and** a
   standalone `POST /admin/clear-supersession` reset all `superseded_by` edges for a
   space before rebuild. *Because* false supersession is the one failure reindex alone
   cannot undo — operators need a documented escape hatch.
9. **Full audit trail.** Every judge call (all four verdicts) is logged to
   `supersession_log`, not only auto-links. Briefing gains an **Unresolved conflicts**
   section from recent `contradicts`/`uncertain` rows. *Because* B2's exit criterion is
   an audit, and agents should see known tensions at session start.

---

## 1. Architecture: lifecycle edges on existing `docs` rows

**Approach chosen (roadmap §4, Approach 1):** `superseded_by` on the existing `docs`
table. A superseded fact remains in D1 (auditable, recoverable via `reindex` clearing
edges) but is excluded from `listDocs` and every retrieval path that calls it.

**Rejected alternatives:**

| Approach | Why rejected |
|---|---|
| Delete superseded facts | Loses audit trail; breaks provenance; reindex cannot reconstruct which fact replaced which |
| Separate `supersedes` edge table | Extra join on every read; `superseded_by` column already exists and is filtered in Phase A code |
| Threshold-only embedding similarity | Roadmap §4 explicitly rejected — similarity cannot distinguish replace vs relate vs contradict |

### Edge semantics

- **Direction:** `old_fact.superseded_by = new_fact.id` — the *new* fact supersedes the
  *old* one. Retrieval queries `WHERE superseded_by IS NULL`.
- **One successor per fact:** a fact has at most one `superseded_by` pointer. If a newer
  write supersedes the same old fact again, the pointer is updated to the latest new fact
  id (idempotent overwrite of the edge).
- **No transitive closure at read time.** If A was superseded by B and B is later
  superseded by C, A still points at B (hidden) and B points at C (hidden). Both are
  excluded. A full chain walk is unnecessary for retrieval.
- **Canon facts can be superseded.** A standing rule that is genuinely replaced should
  disappear from the briefing. The judge prompt treats canon replacement as higher stakes
  (require explicit "replaces" language in the new fact).

### Re-ingest safety (critical)

`replaceBySource` deletes all facts for a `source_id` and inserts a fresh set. Without
care, this orphans or corrupts lifecycle edges:

1. **Inbound pointers:** other facts may have `superseded_by` pointing at a fact id about
   to be deleted → **clear those pointers** (`SET superseded_by = NULL`) before delete, so
   wrongly-hidden facts become live again.
2. **Outbound pointers:** facts being deleted may have superseded others → those others
   stay live (their `superseded_by` already points at the deleted id; step 1 clears it).
3. **After insert:** run the supersession pass for each new fact in the batch.

This logic lives inside `replaceBySource` (or a wrapper `replaceBySourceAndSupersede`)
so every ingest path (inline write, webhook, reindex) gets it automatically.

---

## 2. Components

### 2.1 `gateway/src/supersede.ts` (NEW)

```ts
type GenText = (prompt: string) => Promise<string>;   // reuse B1 seam

type JudgeVerdict = "replaces" | "contradicts" | "relates" | "uncertain";

interface JudgeResult {
  verdict: JudgeVerdict;
  oldFactId: string;
  oldBody: string;
  reason: string;   // one sentence, for audit log
}

interface ConflictHit {
  factId: string;
  body: string;
  reason: string;
}

/** Entity-scoped cosine top-K among live facts; project-wide fallback if no entities. */
function supersessionCandidates(
  liveFacts: IndexedDoc[],
  newFact: IndexedDoc,
  topK?: number,
): IndexedDoc[];

/** Pairwise LLM judge: does newFact replace / contradict / relate to oldFact? */
async function judgePair(
  gen: GenText,
  newFact: { body: string; kind: string },
  oldFact: { id: string; body: string; kind: string },
): Promise<JudgeResult>;

/** Async ingest path: auto-link on "replaces" only; log every judgment. */
async function applySupersession(
  db: IndexDb,
  gen: GenText | null,
  space: string,
  project: string,
  newFacts: IndexedDoc[],
): Promise<void>;

/** Sync write path: entry-level conflict check before tool return. */
async function detectWriteConflicts(
  db: IndexDb,
  embed: Embedder | null,
  gen: GenText | null,
  space: string,
  project: string,
  entryBody: string,
): Promise<ConflictHit[]>;
```

**Judge prompt core (pairwise):**

- Inputs: new fact body + kind, old fact body + kind, both self-contained.
- Output: JSON `{"verdict":"replaces|contradicts|relates|uncertain","reason":"..."}`.
- Instructions:
  - **replaces** — new fact is a direct, intentional update that makes the old fact
    obsolete (same topic, new decision supersedes old decision).
  - **contradicts** — facts cannot both be true; replacement is unclear or partial.
  - **relates** — same topic area, both can coexist.
  - **uncertain** — not enough information; treat like **contradicts** for auto-link
    (never link) but do not surface as conflict unless similarity floor was met.
- **Fidelity:** judge reads only what each fact states; no inference beyond the text.
- **Fail-open:** if `gen` is null, throws, or returns garbage → **no links, no
  conflicts** (ingest and write proceed as B1). Supersession is enhancement, not gate.

**Similarity floors (candidate gating, not verdict):**

| Stage | Floor | Purpose |
|---|---|---|
| Sync write conflict check | cosine ≥ 0.70 on entry embedding vs fact embedding | Skip LLM when nothing is plausibly related |
| Async supersession pass | cosine ≥ 0.60 among entity-scoped candidates | Wider net; judge is conservative |
| Sync candidate count | top **10** live facts in project | Maximize recall of conflicts on write |
| Async candidate count | top **10** entity-scoped (top **10** project-wide if no entities) | Maximize recall of replacements on ingest |

Exact constants are calibration targets; tune in implementation, document in
`gateway/README.md`.

**Sync surfacing policy (max features):** surface both **contradicts** and **uncertain**
verdicts in the write response. **relates** and **replaces** are not surfaced synchronously
(replaces is handled async; relates needs no author action).

### 2.2 `gateway/src/index-db.ts` (MOD)

New `IndexDb` methods:

```ts
/** Point oldFactId's superseded_by at newFactId. Idempotent overwrite. */
markSuperseded(space: string, oldFactId: string, newFactId: string): Promise<void>;

/** Clear superseded_by on any fact that pointed at one of deletedIds. */
clearSupersessionPointersTo(space: string, deletedIds: string[]): Promise<void>;

/** Return ids of all docs with the given source_id (for pre-delete cleanup). */
idsBySource(space: string, sourceId: string): Promise<string[]>;

/** Append-only audit row for supersession-accuracy sampling (§7). */
logSupersession(entry: SupersessionLogEntry): Promise<void>;

/** Recent contradicts/uncertain judgments for briefing (last N days). */
recentConflictLogs(space: string, project: string, sinceIso: string, limit?: number): Promise<SupersessionLogEntry[]>;

/** Wipe all superseded_by edges in a space (operator recovery). */
clearAllSupersession(space: string): Promise<number>;
```

`replaceBySource` gains a pre-delete step:

```
ids ← idsBySource(space, sourceId)
clearSupersessionPointersTo(space, ids)
DELETE fact_entities … DELETE docs … INSERT new docs
```

`MemoryIndexDb` implements the same semantics for tests.

### 2.3 Schema — migration `0003_supersession_log.sql` (NEW)

```sql
CREATE TABLE IF NOT EXISTS supersession_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  space       TEXT NOT NULL,
  project     TEXT NOT NULL,
  new_fact_id TEXT NOT NULL,
  old_fact_id TEXT NOT NULL,
  verdict     TEXT NOT NULL,   -- replaces | contradicts | relates | uncertain
  auto_linked INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,
  ts          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS supersession_log_space_ts
  ON supersession_log (space, ts);
```

No change to `docs.superseded_by` — column exists from `0001`.

### 2.4 `gateway/src/ingest.ts` (MOD)

After `replaceBySource` for each entry:

```ts
await applySupersession(db, gen, space, project, docs);
```

`ingestEntries` signature unchanged; supersession is internal.

**Explicit author override (gateway-only, optional):** `write_context` gains an optional
`supersedes: string[]` argument — an array of live fact ids the author asserts this
entry replaces. When present:

- Sync conflict check is skipped for those ids (author is authoritative).
- Async path calls `markSuperseded` for each id against the **first extracted fact** of
  the new entry (or the whole-entry fail-open fact if extraction degraded).
- Still logged to `supersession_log` with `verdict: "replaces"`, `auto_linked: 1`,
  `reason: "author-supersedes"`.

This does not touch the frozen local CLI write path — only the hosted MCP tool schema.

### 2.5 `gateway/src/mcp.ts` (MOD)

`write_context` handler, after ledger commit and before `rpcResult`:

```ts
const conflicts = await detectWriteConflicts(
  deps.db, deps.embed, deps.gen,
  member.space, project, payload,
);
// … existing waitUntil ingest unchanged …
return rpcResult(msg.id, toolText(formatWriteResult(entry, conflicts)));
```

`formatWriteResult` appends a conflicts section when non-empty:

```
Recorded decision in 'memorylayer' as Skanda at … (context/…/….md).

⚠ Possible conflicts with existing memory (not auto-resolved):
- [e1#0] "Cursor MCP config is project-scoped…" — contradicts: new entry says global scope
```

Conflicts are **informational** — the write already succeeded. The agent must decide
whether to write a clarifying entry or pass `supersedes` on a follow-up call.

### 2.6 Retrieval & briefing (MOD)

`listDocs` already filters `superseded_by IS NULL`. No retrieval-pipeline ranking changes.
Superseded facts do not appear in `search_memory` / `read_context?query` or canon/question
sections.

**Briefing addition — Unresolved conflicts:** `renderBriefing` gains a section built from
`recentConflictLogs` (last 7 days, `verdict IN ('contradicts','uncertain')`, deduped by
`old_fact_id`). Each line: old fact body snippet + reason from the log. Budget-permitting,
after open questions. Fail-open: empty section if log query fails.

### 2.7 Admin endpoints

**`GET /admin/supersession-audit?space=<s>&limit=<n>[&auto_linked_only=1]`**
(ADMIN_SECRET-guarded):

- Default: `n` most recent rows where `auto_linked = 1` (supersession-accuracy sample).
- `auto_linked_only=0`: all recent verdicts (full audit trail export).

**`POST /admin/clear-supersession`** body `{"space":"<s>"}` (ADMIN_SECRET-guarded):

- `UPDATE docs SET superseded_by = NULL WHERE space = ?`; returns `{ cleared: <count> }`.
- Does not delete facts or reindex — operator runs reindex separately if desired.

Reindex body also accepts `clearSupersession: true` (runs clear before rebuild).

---

## 3. Data flow

**Gateway write (happy path):**

1. `write_context` → commit entry to ledger (unchanged).
2. **Sync:** embed `payload` → cosine top-10 live facts in project → judge pairs with
   similarity ≥ 0.70 → collect `contradicts` + `uncertain` hits → include in tool response
   (skip ids listed in `supersedes` if author override present).
3. Return immediately.
4. **Async (`waitUntil`):** extract facts → embed → `replaceBySource` (with pointer
   cleanup) → `applySupersession` per new fact → `markSuperseded` on **replaces** only.

**Local write:** git push → webhook → same ingest + supersession path.

**Reindex / backfill:** `POST /admin/reindex` rebuilds facts through ingest; supersession
runs on every entry. For the ~70-entry pilot corpus this is a one-time `$0` LLM cost
(~N facts × M candidates × judge). Acceptable at pilot scale.

**Recovery:** `POST /admin/clear-supersession` or `POST /admin/reindex` with
`{"clearSupersession": true}` wipes all `superseded_by` edges for the space(s), then
(optionally) rebuilds facts. Document the full operator runbook in README.

---

## 4. Error handling / fail-open invariants

| Failure | Behavior |
|---|---|
| Judge null / throw / garbage JSON | No `superseded_by` writes; no conflicts surfaced |
| Embed null on sync conflict check | Skip sync check; async path still runs if embed available there |
| `markSuperseded` throws inside `waitUntil` | Swallowed; cron/webhook re-derive on next ingest |
| False positive auto-link | Operator runs reindex with `clearSupersession`; fix judge prompt; re-run |
| Author passes invalid `supersedes` id | Ignore unknown ids; log warning; proceed with normal judge for others |

**Non-negotiable:** supersession failure never blocks a write or breaks a read.

---

## 5. Testing

Same seams as B1 (`node:test`, `fakeGenText`, `MemoryIndexDb`, no miniflare/model):

- **Judge parsing:** canned JSON → correct verdict enum; garbage → fail-open (no op).
- **Auto-link:** `replaces` verdict → `old.supersededBy === new.id`; `contradicts` → no write.
- **Conservative default:** `uncertain` and `relates` → no write.
- **Re-ingest safety:** fact A supersedes B; re-ingest A's source → B becomes live again
  (pointer cleared) unless the new extraction re-links.
- **listDocs exclusion:** superseded fact absent from retrieval candidates.
- **Sync conflicts:** high-similarity contradicting pair → `detectWriteConflicts` returns
  hit; included in formatted write response.
- **Author `supersedes`:** explicit id → `markSuperseded` without judge call.
- **Cursor regression** (Phase A/B1) still passes — supersession must not hide the
  Cursor MCP config fact unless a genuine replacement entry exists.
- Both suites green (`npm test`, `cd gateway && npm test`) + lint/typecheck/format.

---

## 6. B2 exit criterion (roadmap §9)

**Supersession-accuracy audit passes on the corpus** — a sampled check (via
`/admin/supersession-audit` or SQL against `supersession_log`) that auto-linked edges are
legitimate replacements, with **zero false supersessions** on the sample (or ≤1 on a
≥20-pair sample at pilot scale, documented as a known risk if the free judge errs once).

The extraction-fidelity audit is B1's exit gate (may still be pending operationally).
The golden-set recall harness remains Phase C.

---

## 7. Explicitly out of scope for B2

- `/hook/prompt` thresholded push → **Phase C**
- `memory_feedback` tool, LLM-judge dashboards, τ calibration loop → **Phase C**
- Automatic *un*-supersession on author request (tombstone / undo UI) → future; manual
  `clearSupersession` reindex flag is the operator escape hatch
- Cross-project supersession within a space → deferred (entity+project scoping is the
  default; space-wide canon conflicts are rare at pilot scale)
- Digest/compaction of facts → deferred until live-fact volume pressures budgets
- Client-structured `supersedes` on the frozen local CLI write path → gateway MCP only
- Paid judge model → metric-gated escalation only

---

## 8. File-touch summary

```
gateway/src/supersede.ts                       NEW  judge, candidates, applySupersession, detectWriteConflicts, formatWriteResult
gateway/src/index-db.ts                        MOD  markSuperseded, clearSupersessionPointersTo, idsBySource, logSupersession, recentConflictLogs, clearAllSupersession; replaceBySource pre-delete cleanup
gateway/src/ingest.ts                          MOD  applySupersession after replaceBySource; authorSupersedes option
gateway/src/mcp.ts                             MOD  sync conflict check on every write; supersedes arg; TOOLS schema
gateway/migrations/0003_supersession_log.sql   NEW  audit log table
gateway/src/router.ts                          MOD  GET /admin/supersession-audit, POST /admin/clear-supersession
gateway/src/reindex.ts                         MOD  clearSupersession body flag
gateway/src/retrieval.ts                       MOD  renderBriefing unresolved-conflicts section
gateway/src/hook-read.ts                       MOD  recentConflictLogs into briefing
gateway/test/supersede.test.mjs                NEW  judge, auto-link, re-ingest safety, conflicts
gateway/test/ingest.test.mjs                   MOD  supersession integration
gateway/test/mcp.test.mjs                      MOD  conflicts + supersedes in write response
gateway/test/index-db.test.mjs                 MOD  markSuperseded, pointer cleanup, clearAllSupersession
gateway/test/retrieval.test.mjs                MOD  briefing conflicts section
gateway/test/router.test.mjs                   MOD  admin endpoints
gateway/README.md                              MOD  Phase B2 model, migration, audit runbook, clearSupersession
```

No root-package or local-plane source changes. No new npm dependencies.
