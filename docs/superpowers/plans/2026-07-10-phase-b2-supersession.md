# Phase B2 — Supersession Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fact lifecycle to the gateway relevance index — conservative LLM-judged supersession (`superseded_by` writes), sync `conflicts_with` surfacing on every `write_context`, author `supersedes` overrides, full audit logging, briefing conflict section, and operator recovery endpoints.

**Architecture:** New `gateway/src/supersede.ts` owns candidate generation (entity-scoped cosine top-10), pairwise LLM judging (`replaces|contradicts|relates|uncertain`), and two call paths: **sync** `detectWriteConflicts` (before MCP return) and **async** `applySupersession` (after B1 `replaceBySource` in ingest). `index-db.ts` gains lifecycle methods + pre-delete pointer cleanup inside `replaceBySource`. Every judgment logs to `supersession_log`; auto-link only on `replaces`.

**Tech Stack:** TypeScript, Cloudflare Workers + D1 + Workers AI (reuse `@cf/meta/llama-3.3-70b-instruct-fp8-fast` via existing `genText` seam), `node:test`, no new npm dependencies.

**Spec:** `docs/superpowers/specs/2026-07-10-phase-b2-supersession-design.md` (APPROVED 2026-07-10)

## Global Constraints

- **Branch:** `relevance/phase-b2` from `main`.
- **Gateway-exclusive:** no root-package (`src/**`) or local CLI write-path changes.
- **Fail-open everywhere:** judge/embed null, throw, or garbage JSON → no links, no conflicts surfaced; never block writes or reads.
- **Conservative auto-link:** only `replaces` writes `superseded_by`; `contradicts`, `relates`, `uncertain` never auto-link.
- **Test seams:** reuse `fakeGenText` from `gateway/test/helpers.mjs`; add `fakeJudge` script map keyed by old-fact body substrings.
- **Suites:** `cd gateway && npm test` (builds first); root `npm test`, `npm run lint`, `npm run typecheck`, `npm run format:check`.

## File Structure

```
gateway/migrations/0003_supersession_log.sql   NEW
gateway/src/index-db.ts                        MOD  SupersessionLogEntry; lifecycle methods; replaceBySource pre-delete
gateway/src/supersede.ts                       NEW  judge, candidates, applySupersession, detectWriteConflicts, formatWriteResult
gateway/src/ingest.ts                          MOD  authorSupersedes option; call applySupersession
gateway/src/mcp.ts                             MOD  sync conflicts; supersedes arg; TOOLS schema
gateway/src/reindex.ts                         MOD  clearSupersession flag
gateway/src/router.ts                          MOD  admin audit + clear-supersession routes
gateway/src/retrieval.ts                       MOD  renderBriefing conflicts section
gateway/src/hook-read.ts                       MOD  fetch recentConflictLogs for briefing
gateway/test/supersede.test.mjs                NEW
gateway/test/index-db.test.mjs                 MOD
gateway/test/ingest.test.mjs                   MOD
gateway/test/mcp.test.mjs                      MOD
gateway/test/retrieval.test.mjs                MOD
gateway/test/router.test.mjs                   MOD
gateway/README.md                              MOD
```

---

### Task 1: Schema + index-db lifecycle methods

**Files:**
- Create: `gateway/migrations/0003_supersession_log.sql`
- Modify: `gateway/src/index-db.ts`
- Test: `gateway/test/index-db.test.mjs`

- [ ] **Step 1: Write the migration**

```sql
-- gateway/migrations/0003_supersession_log.sql
CREATE TABLE IF NOT EXISTS supersession_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  space       TEXT NOT NULL,
  project     TEXT NOT NULL,
  new_fact_id TEXT NOT NULL,
  old_fact_id TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  auto_linked INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,
  ts          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS supersession_log_space_ts
  ON supersession_log (space, ts);
CREATE INDEX IF NOT EXISTS supersession_log_verdict
  ON supersession_log (space, verdict, ts);
```

- [ ] **Step 2: Write failing tests**

Append to `gateway/test/index-db.test.mjs`:

```js
test("markSuperseded sets old fact's supersededBy; listDocs excludes it", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([doc({ id: "old1" }), doc({ id: "new1" })]);
  await db.markSuperseded("s1", "old1", "new1");
  const live = await db.listDocs("s1");
  assert.deepEqual(live.map((d) => d.id), ["new1"]);
});

test("clearSupersessionPointersTo un-hides facts pointing at deleted ids", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([
    doc({ id: "victim" }),
    doc({ id: "soon-gone", supersededBy: null }),
  ]);
  await db.markSuperseded("s1", "victim", "soon-gone");
  await db.clearSupersessionPointersTo("s1", ["soon-gone"]);
  const live = await db.listDocs("s1");
  assert.ok(live.some((d) => d.id === "victim"));
});

test("replaceBySource clears inbound pointers before delete", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([doc({ id: "e1#0", sourceId: "e1" })]);
  await db.markSuperseded("s1", "other", "e1#0");
  await db.replaceBySource("s1", "e1", [doc({ id: "e1#0", sourceId: "e1", body: "rewritten" })]);
  const live = await db.listDocs("s1");
  assert.ok(live.some((d) => d.id === "other"));
});

test("clearAllSupersession wipes edges and returns count", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([doc({ id: "a" }), doc({ id: "b" })]);
  await db.markSuperseded("s1", "a", "b");
  const n = await db.clearAllSupersession("s1");
  assert.equal(n, 1);
  assert.equal((await db.listDocs("s1")).length, 2);
});

test("logSupersession + recentConflictLogs round-trip", async () => {
  const db = new MemoryIndexDb();
  await db.logSupersession({
    space: "s1", project: "p", newFactId: "n1", oldFactId: "o1",
    verdict: "contradicts", autoLinked: false, reason: "scope mismatch", ts: "2026-07-10T00:00:00Z",
  });
  const rows = await db.recentConflictLogs("s1", "p", "2026-07-09T00:00:00Z", 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict, "contradicts");
});
```

- [ ] **Step 3: Run tests — expect FAIL**

Run: `cd gateway && npm run build && node --test test/index-db.test.mjs`
Expected: FAIL — `markSuperseded is not a function`

- [ ] **Step 4: Implement in `index-db.ts`**

Add exports:

```ts
export interface SupersessionLogEntry {
  space: string;
  project: string;
  newFactId: string;
  oldFactId: string;
  verdict: string;
  autoLinked: boolean;
  reason: string;
  ts: string;
}
```

Extend `IndexDb`:

```ts
markSuperseded(space: string, oldFactId: string, newFactId: string): Promise<void>;
clearSupersessionPointersTo(space: string, deletedIds: string[]): Promise<void>;
idsBySource(space: string, sourceId: string): Promise<string[]>;
logSupersession(entry: SupersessionLogEntry): Promise<void>;
recentConflictLogs(space: string, project: string, sinceIso: string, limit?: number): Promise<SupersessionLogEntry[]>;
clearAllSupersession(space: string): Promise<number>;
```

`MemoryIndexDb.markSuperseded`: find `space oldFactId` key, set `supersededBy = newFactId`.

`clearSupersessionPointersTo`: for each doc in space where `supersededBy ∈ deletedIds`, set `supersededBy = null`.

`idsBySource`: filter docs by `space` + `sourceId`, return ids.

`logSupersession` / `recentConflictLogs`: in-memory array on `MemoryIndexDb` (filter `verdict ∈ {contradicts, uncertain}` + `ts >= since`).

`clearAllSupersession`: count docs with non-null `supersededBy`, set all to null.

**Modify `replaceBySource`** (both Memory + d1): before DELETE, call `idsBySource` → `clearSupersessionPointersTo`.

D1 SQL for `markSuperseded`:
```sql
UPDATE docs SET superseded_by = ? WHERE space = ? AND id = ?
```

D1 `clearSupersessionPointersTo`:
```sql
UPDATE docs SET superseded_by = NULL WHERE space = ? AND superseded_by IN (...)
```

- [ ] **Step 5: Run tests — expect PASS**

- [ ] **Step 6: Commit**

```bash
git add gateway/migrations/0003_supersession_log.sql gateway/src/index-db.ts gateway/test/index-db.test.mjs
git commit -m "feat(gateway): index-db supersession lifecycle methods + audit log"
```

---

### Task 2: Supersession judge core (`supersede.ts`)

**Files:**
- Create: `gateway/src/supersede.ts`
- Modify: `gateway/test/helpers.mjs` (add `fakeJudge`)
- Test: `gateway/test/supersede.test.mjs`

- [ ] **Step 1: Add `fakeJudge` helper**

```js
/** Returns canned judge JSON when the prompt contains a marker substring. */
export function fakeJudge(script = {}) {
  return async (prompt) => {
    for (const [marker, json] of Object.entries(script)) {
      if (prompt.includes(marker)) return json;
    }
    return '{"verdict":"relates","reason":"default"}';
  };
}
```

- [ ] **Step 2: Write failing tests**

```js
// gateway/test/supersede.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildJudgePrompt,
  parseJudgeVerdict,
  supersessionCandidates,
  SYNC_COSINE_FLOOR,
} from "../dist/gateway/src/supersede.js";
import { cosineTopK } from "../dist/gateway/src/rank.js";
import { fakeJudge } from "./helpers.mjs";
import { judgePair } from "../dist/gateway/src/supersede.js";

const liveDoc = (id, body, entities = [], embedding = [1, 0]) => ({
  id, space: "s1", project: "p", kind: "decision", tier: "normal", body,
  sourceFile: "f.md", sourceAuthor: "A", sourceTs: "2026-01-01T00:00:00Z",
  embedding, supersededBy: null, createdAt: "2026-01-01T00:00:00Z", sourceId: id, entities,
});

test("buildJudgePrompt includes both fact bodies", () => {
  const p = buildJudgePrompt(
    { body: "new text", kind: "decision" },
    { id: "o1", body: "old text", kind: "decision" },
  );
  assert.match(p, /new text/);
  assert.match(p, /old text/);
  assert.match(p, /replaces|contradicts|relates|uncertain/);
});

test("parseJudgeVerdict accepts valid JSON", () => {
  assert.equal(parseJudgeVerdict('{"verdict":"replaces","reason":"direct update"}').verdict, "replaces");
});

test("parseJudgeVerdict fail-open on garbage", () => {
  assert.equal(parseJudgeVerdict("not json").verdict, "uncertain");
});

test("supersessionCandidates prefers shared entity tags", () => {
  const newF = liveDoc("n#0", "cursor scoped", ["cursor"]);
  const tagged = liveDoc("t1", "cursor fact", ["cursor"], [0.9, 0.1]);
  const untagged = liveDoc("u1", "unrelated", [], [1, 0]);
  const cands = supersessionCandidates([tagged, untagged], newF, 10);
  assert.ok(cands.some((d) => d.id === "t1"));
  assert.ok(!cands.some((d) => d.id === "u1"));
});

test("judgePair returns replaces from fake judge", async () => {
  const gen = fakeJudge({ "old scope": '{"verdict":"replaces","reason":"updated policy"}' });
  const r = await judgePair(gen,
    { body: "new scope", kind: "decision" },
    { id: "o1", body: "old scope", kind: "decision" },
  );
  assert.equal(r.verdict, "replaces");
});
```

- [ ] **Step 3: Run — expect FAIL**

- [ ] **Step 4: Implement `supersede.ts`**

Constants:
```ts
export const SYNC_COSINE_FLOOR = 0.70;
export const ASYNC_COSINE_FLOOR = 0.60;
export const SYNC_CANDIDATE_K = 10;
export const ASYNC_CANDIDATE_K = 10;
export type JudgeVerdict = "replaces" | "contradicts" | "relates" | "uncertain";
```

`supersessionCandidates(liveFacts, newFact, topK)`:
- If `newFact.entities.length > 0`: filter live facts sharing ≥1 entity slug with new fact.
- Else: use all live facts in project (caller pre-filters project).
- Rank by `cosineTopK` on embeddings; return top K with score ≥ ASYNC_COSINE_FLOOR (caller may use SYNC floor for sync path).

`buildJudgePrompt(newFact, oldFact)`: pairwise instructions per spec §2.1; output JSON only.

`parseJudgeVerdict(text)`: try JSON parse; validate verdict enum; else `{ verdict: "uncertain", reason: "parse-failed" }`.

`judgePair(gen, newFact, oldFact)`: call gen, parse, return `{ verdict, oldFactId: oldFact.id, oldBody: oldFact.body, reason }`.

Export all; **do not** implement `applySupersession` / `detectWriteConflicts` yet.

- [ ] **Step 5: Run tests — PASS**

- [ ] **Step 6: Commit**

```bash
git add gateway/src/supersede.ts gateway/test/supersede.test.mjs gateway/test/helpers.mjs
git commit -m "feat(gateway): supersession judge core + entity-scoped candidates"
```

---

### Task 3: Async `applySupersession` + ingest wiring

**Files:**
- Modify: `gateway/src/supersede.ts`, `gateway/src/ingest.ts`
- Test: `gateway/test/supersede.test.mjs`, `gateway/test/ingest.test.mjs`

- [ ] **Step 1: Write failing ingest test**

```js
test("ingestEntries auto-links on replaces verdict", async () => {
  const db = new MemoryIndexDb();
  const old = { /* doc old#0 with body about cursor scope, entities cursor */ };
  await db.upsertDocs([old]);
  const gen = fakeGenText({ cursor: '[{"kind":"decision","tier":"normal","body":"Cursor is global now","entities":["cursor"]}]' });
  const judge = fakeJudge({ "project-scoped": '{"verdict":"replaces","reason":"policy change"}' });
  // ingestEntries needs optional judge seam OR applySupersession called with gen that includes judge
  // Pass judge via extended ingest: ingestEntries(..., { judgeGen: judge })
  await ingestEntries(db, fakeEmbed, gen, "s1", "p", [entry("Cursor is global now")], { judgeGen: judge });
  const live = await db.listDocs("s1");
  assert.equal(live.find((d) => d.id.startsWith("old"))?.supersededBy ?? "hidden", "hidden");
});
```

*Implementation note:* thread `judgeGen: GenText | null` through `ingestEntries` → `applySupersession`. Production uses same `gen` from `indexDeps`; tests inject separate `fakeJudge`.

- [ ] **Step 2: Implement `applySupersession`**

```ts
export async function applySupersession(
  db: IndexDb,
  gen: GenText | null,
  space: string,
  project: string,
  newFacts: IndexedDoc[],
  opts: { authorSupersedes?: string[] } = {},
): Promise<void> {
  if (newFacts.length === 0) return;
  const primaryId = newFacts[0].id;
  const live = await db.listDocs(space, project);

  // Author overrides first
  if (opts.authorSupersedes?.length) {
    for (const oldId of opts.authorSupersedes) {
      if (!live.some((d) => d.id === oldId)) continue;
      await db.markSuperseded(space, oldId, primaryId);
      await db.logSupersession({ /* verdict replaces, reason author-supersedes, autoLinked true */ });
    }
  }

  if (!gen) return;
  for (const newFact of newFacts) {
    const skip = new Set(opts.authorSupersedes ?? []);
    const cands = supersessionCandidates(live, newFact, ASYNC_CANDIDATE_K)
      .filter((c) => !skip.has(c.id) && c.id !== newFact.id);
    for (const old of cands) {
      const result = await judgePair(gen, { body: newFact.body, kind: newFact.kind }, old);
      await db.logSupersession({
        space, project, newFactId: newFact.id, oldFactId: old.id,
        verdict: result.verdict, autoLinked: result.verdict === "replaces",
        reason: result.reason, ts: new Date().toISOString(),
      });
      if (result.verdict === "replaces") {
        await db.markSuperseded(space, old.id, newFact.id);
        old.supersededBy = newFact.id; // keep live list consistent in-loop
      }
    }
  }
}
```

- [ ] **Step 3: Wire `ingestEntries`**

After each `replaceBySource`, call:
```ts
await applySupersession(db, judgeGen ?? gen, space, slug(project), docs, { authorSupersedes: opts.authorSupersedes });
```

Extend signature:
```ts
export async function ingestEntries(
  db, embed, gen, space, project, entries,
  opts: { authorSupersedes?: string[]; judgeGen?: GenText | null } = {},
): Promise<number>
```

- [ ] **Step 4: Add supersede unit tests for applySupersession** (replaces links, contradicts does not, relates/uncertain do not)

- [ ] **Step 5: Run `cd gateway && npm test` — PASS**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(gateway): async applySupersession wired into ingest"
```

---

### Task 4: Sync `detectWriteConflicts` + `formatWriteResult`

**Files:**
- Modify: `gateway/src/supersede.ts`
- Test: `gateway/test/supersede.test.mjs`

- [ ] **Step 1: Write failing test**

```js
test("detectWriteConflicts surfaces contradicts and uncertain", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([
    liveDoc("o1", "MCP is project-scoped", ["cursor"], [1, 0]),
  ]);
  const embed = async (texts) => texts.map(() => [1, 0]);
  const gen = fakeJudge({ "project-scoped": '{"verdict":"contradicts","reason":"now claims global"}' });
  const hits = await detectWriteConflicts(db, embed, gen, "s1", "p", "MCP is global", { skipIds: [] });
  assert.equal(hits.length, 1);
  assert.match(hits[0].reason, /global/i);
});

test("formatWriteResult appends conflict section", () => {
  const text = formatWriteResult(
    { type: "decision", author: "A", timestamp: "2026-07-10T00:00:00Z", file: "f.md" },
    "memorylayer",
    [{ factId: "o1", body: "old", reason: "clash" }],
    [],
  );
  assert.match(text, /Possible conflicts/);
  assert.match(text, /clash/);
});
```

- [ ] **Step 2: Implement**

```ts
export async function detectWriteConflicts(
  db: IndexDb,
  embed: Embedder | null,
  gen: GenText | null,
  space: string,
  project: string,
  entryBody: string,
  opts: { skipIds?: string[] } = {},
): Promise<ConflictHit[]> {
  if (!embed || !gen) return [];
  const live = (await db.listDocs(space, project)).filter((d) => !opts.skipIds?.includes(d.id));
  if (live.length === 0) return [];
  let queryVec: number[];
  try { [queryVec] = await embed([entryBody]); } catch { return []; }
  const ranked = cosineTopK(live, queryVec ?? [], SYNC_CANDIDATE_K)
    .filter((s) => s.score >= SYNC_COSINE_FLOOR);
  const hits: ConflictHit[] = [];
  for (const s of ranked) {
    const old = live.find((d) => d.id === s.id)!;
    const r = await judgePair(gen, { body: entryBody, kind: "decision" }, old);
    await db.logSupersession({ /* newFactId: "(pending)", oldFactId: old.id, sync pass */ });
    if (r.verdict === "contradicts" || r.verdict === "uncertain") {
      hits.push({ factId: old.id, body: old.body, reason: r.reason, verdict: r.verdict });
    }
  }
  return hits;
}

export function formatWriteResult(
  entry: { type: string; author: string; timestamp: string; file: string },
  project: string,
  conflicts: ConflictHit[],
  authorSupersedes: string[],
): string {
  let text = `Recorded ${entry.type} in '${project}' as ${entry.author} at ${entry.timestamp} (${entry.file}).`;
  if (authorSupersedes.length > 0) {
    text += `\n\nSupersedes: ${authorSupersedes.join(", ")}`;
  }
  if (conflicts.length > 0) {
    text += "\n\n⚠ Possible conflicts with existing memory (not auto-resolved):";
    for (const c of conflicts) {
      text += `\n- [${c.factId}] "${c.body.slice(0, 120)}" — ${c.verdict}: ${c.reason}`;
    }
  }
  return text;
}
```

- [ ] **Step 3: Run tests — PASS**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(gateway): sync write conflict detection + formatted MCP response"
```

---

### Task 5: MCP `write_context` integration

**Files:**
- Modify: `gateway/src/mcp.ts`
- Test: `gateway/test/mcp.test.mjs`

- [ ] **Step 1: Update TOOLS `write_context` inputSchema**

Add properties:

```ts
supersedes: {
  type: "array",
  items: { type: "string" },
  description:
    "Optional live fact ids this entry replaces. Skips conflict checks for those ids; links after ingest without judge.",
},
```

Update description to mention conflicts may be returned.

- [ ] **Step 2: Write failing MCP test**

Test that `write_context` response includes conflict section when index has opposing fact and judge returns contradicts (use injected `indexDb`, `embedder`, `genText` as judge).

- [ ] **Step 3: Modify handler**

```ts
const authorSupersedes = Array.isArray(args.supersedes)
  ? args.supersedes.filter((x): x is string => typeof x === "string")
  : [];
const deps = indexDeps(env);
let conflicts: ConflictHit[] = [];
if (deps) {
  conflicts = await detectWriteConflicts(
    deps.db, deps.embed, deps.gen,
    member.space, project, payload,
    { skipIds: authorSupersedes },
  );
}
// waitUntil ingest passes authorSupersedes:
await ingestEntries(deps.db, deps.embed, deps.gen, member.space, project, [entry], { authorSupersedes });
return rpcResult(msg.id, toolText(formatWriteResult(entry, project, conflicts, authorSupersedes)));
```

- [ ] **Step 4: Run gateway tests — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(gateway): write_context sync conflicts + supersedes arg"
```

---

### Task 6: Admin endpoints + reindex `clearSupersession`

**Files:**
- Modify: `gateway/src/router.ts`, `gateway/src/reindex.ts`
- Create: `gateway/src/admin-supersession.ts` (optional — or inline in router)
- Test: `gateway/test/router.test.mjs`

- [ ] **Step 1: Write failing router tests**

```js
test("GET /admin/supersession-audit requires admin secret", async () => { /* 403 without header */ });
test("POST /admin/clear-supersession clears edges", async () => { /* 200 + cleared count */ });
```

- [ ] **Step 2: Implement handlers**

`handleAdminSupersessionAudit(req, env)`:
- Parse `space`, `limit` (default 20), `auto_linked_only` (default 1).
- Query `supersession_log` ordered by `ts DESC`.

`handleAdminClearSupersession(req, env)`:
- Parse body `{ space }`, call `db.clearAllSupersession(space)`.

Router additions:
```ts
if (url.pathname === "/admin/supersession-audit" && req.method === "GET") ...
if (url.pathname === "/admin/clear-supersession" && req.method === "POST") ...
```

- [ ] **Step 3: Extend `handleAdminReindex`**

```ts
let body: { /* existing */ clearSupersession?: boolean };
if (body.clearSupersession) {
  for (const sr of repos) await deps.db.clearAllSupersession(sr.space);
}
// then existing reindex loop
```

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(gateway): admin supersession audit + clear endpoints"
```

---

### Task 7: Briefing unresolved conflicts

**Files:**
- Modify: `gateway/src/retrieval.ts`, `gateway/src/hook-read.ts`
- Test: `gateway/test/retrieval.test.mjs`, `gateway/test/hook-read.test.mjs`

- [ ] **Step 1: Write failing test**

```js
test("renderBriefing includes unresolved conflicts when provided", () => {
  const text = renderBriefing("p", [/* docs */], 4000, new Date(), [
    { oldFactId: "o1", reason: "scope clash", oldBody: "project-scoped" },
  ]);
  assert.match(text, /Unresolved conflicts/);
  assert.match(text, /scope clash/);
});
```

- [ ] **Step 2: Extend `renderBriefing`**

Add optional 5th param `conflicts: { oldFactId, oldBody, reason }[]`; render `## Unresolved conflicts` section after open questions.

- [ ] **Step 3: `hook-read.ts`**

When index available, call `db.recentConflictLogs(space, project, sevenDaysAgo, 10)` and pass to `renderBriefing`. Join old fact bodies from `listDocs` or store `old_body` in log — **spec simplification:** log `reason` only + fetch old body from docs table even if superseded (add `getDocById` or query without superseded filter for briefing). Add `IndexDb.getDoc(space, id)` returning doc regardless of superseded_by.

- [ ] **Step 4: Run tests — PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(gateway): briefing unresolved conflicts section"
```

---

### Task 8: README + full verification

**Files:**
- Modify: `gateway/README.md`

- [ ] **Step 1: Add "Phase B2 — supersession" section**

Document:
- Sync conflict check on every write
- `supersedes` MCP arg
- Migration apply: `wrangler d1 migrations apply memorylayer-index --remote`
- Post-deploy: reindex (optionally with `clearSupersession`)
- Audit: `curl /admin/supersession-audit?space=...`
- Recovery: `POST /admin/clear-supersession`
- B2 exit: supersession-accuracy audit on auto_linked rows

- [ ] **Step 2: Full suite**

```bash
npm test
cd gateway && npm test
npm run lint && npm run typecheck && npm run format:check
```

Expected: all green; Phase A/B1 Cursor regression still passes.

- [ ] **Step 3: Commit**

```bash
git commit -m "docs(gateway): Phase B2 supersession runbook"
```

---

## Spec Coverage Checklist

| Spec § | Task |
|---|---|
| §0 decisions 1–9 | Tasks 2–7 |
| §1 edge semantics + re-ingest safety | Task 1, 3 |
| §2.1 supersede.ts | Tasks 2, 3, 4 |
| §2.2 index-db | Task 1 |
| §2.3 migration | Task 1 |
| §2.4 ingest + authorSupersedes | Task 3, 5 |
| §2.5 mcp sync conflicts | Task 4, 5 |
| §2.6 briefing conflicts | Task 7 |
| §2.7 admin endpoints | Task 6 |
| §3 data flow + recovery | Tasks 5, 6, 8 |
| §4 fail-open | All tasks |
| §5 testing | All tasks |
| §6 exit criterion | Task 8 runbook |

## B2 Exit Verification (operator, post-deploy)

1. `wrangler deploy` + apply migration `0003`
2. `POST /admin/reindex` (with `clearSupersession: true` on first B2 deploy)
3. Write a contradicting entry → tool response shows conflicts section
4. Write a replacing entry → old fact absent from `search_memory`
5. `GET /admin/supersession-audit?space=memorylayer&limit=20` → sample auto-links
6. Manual audit: zero false supersessions on sample
