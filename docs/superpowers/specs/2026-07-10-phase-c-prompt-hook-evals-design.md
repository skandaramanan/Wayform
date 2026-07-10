# Phase C — Prompt hook + evals (design)

Date: 2026-07-10
Roadmap: `docs/roadmap/2026-07-07-remote-relevance-engine.md` §6 (retrieval
intelligence) and §7 (evaluation). Builds on merged Phase A (pipeline +
`retrieval_log` + τ) and Phase B1/B2 (facts, briefing, supersession).

## Goal

Close the "agents don't pull" gap structurally and make retrieval **measured,
not vibes**. Four additive, fail-open components:

1. `/hook/prompt` — prompt-conditioned server-side push (the core deliverable).
2. Golden-set recall@k harness (hybrid: deterministic CI fixture + real-miss
   logging path).
3. `memory_feedback(fact_id, verdict)` MCP tool + soft-demote in ranking.
4. τ calibration script (recommend-only).

**Exit criterion (roadmap):** the prompt hook holds <10% unnecessary-injection
at <500ms p95. Everything here is additive — no change to Phase A/B behavior —
and every path fails open (an error injects nothing / breaks nothing).

## Component 1 — `/hook/prompt`

The structural answer to "agents don't pull": move the retrieval decision
server-side, where it is a calibrated scoring problem instead of a hope about
model behavior.

- **Route:** `POST /hook/prompt`, body `{ project, prompt, budget? }`. POST
  (not GET like `/hook/read`) because it carries free-text prompt content. Auth
  via bearer token → `resolveMember`, identical to the other hooks.
- **Logic:** thin handler → `retrieve(deps, { space, project: slug(project),
  query: prompt, budgetTokens, trigger: "hook_prompt" })`. The existing pipeline
  (BM25 ∪ cosine ∪ entity → RRF → priors/decay → **τ floor** → token-budget
  packing) already implements "inject only above τ." No new ranking code.
- **Response:**
  - Above-τ hits → `200` with a compact injection block from a new
    `renderPromptInjection(project, results)` using data-not-instructions
    framing (like the `/hook/read` preamble), **not** the "# Memory search"
    search framing.
  - Nothing clears τ → **empty `200` body** (silent; the client shim injects
    nothing).
  - Any error/timeout → **empty `200` body** (fail-open silent).
- **No caching:** the query is unique per prompt; per-prompt-hash caching is not
  worth it at pilot volume.
- **Latency:** no LLM on this path (already true of `retrieve`). Budget
  p95 < 500ms is met by embed (~50ms) + D1 `listDocs` + in-Worker scoring.
- **Canonical regression:** the confirmed Cursor miss — the prompt mentioning
  Cursor MCP config MUST return the 2026-07-04 fact — becomes a `/hook/prompt`
  integration test.

## Component 2 — Golden-set harness (hybrid)

Deterministic CI recall@k against a checked-in fixture, plus a production path
that captures real observed misses for human promotion.

- **Fixture** `gateway/eval/golden.json`: two arrays —
  - `corpus`: curated `IndexedDoc`-shaped facts (the 2026-07-04 Cursor fact +
    realistic distractors), the source-of-truth seed corpus for CI.
  - `cases`: `{ query, expectedIds[], note }`, seeded with the Cursor miss as
    case #1.
- **Harness** `gateway/test/golden.test.mjs` (a `node:test`): seeds a
  `MemoryIndexDb` from `corpus`, runs `retrieve()` per case with the real
  `fakeEmbed`, computes **recall@10** across cases, asserts ≥ a floor constant
  (start 0.9 per the roadmap Phase A exit, tighten toward 0.95). A recall miss
  fails CI loudly and names the missing query. Deterministic, $0, every push.
- **`recallAtK` helper** `gateway/src/eval-golden.ts`: pure
  `recallAtK(cases, retrievedByCase, k) → { recall: number, perCase: [...] }`,
  its own module so the calibration script reuses it.
- **Real-miss logging:** admin endpoint `POST /admin/golden-candidate`, body
  `{ project, query, expectedFactId, note? }`, inserts into a new
  `golden_candidate` table. Captures live-audit misses **without** mutating the
  deterministic CI fixture. A human periodically reviews candidates and promotes
  real ones into `golden.json` (manual edit — keeps the checked-in set curated,
  not auto-grown by noise). Separate from `memory_feedback`.

## Component 3 — `memory_feedback` tool + soft-demote

- **MCP tool** `memory_feedback(fact_id, verdict)`, `verdict ∈ {useful, wrong,
  stale}`, added to `TOOLS` in `gateway/src/mcp.ts`. Identity from the bearer
  token (a member cannot vote as another). Fail-open: a recording failure
  returns a soft "couldn't record" text, never a hard error.
- **Storage** `memory_feedback` table (migration `0004`): `space, project,
  fact_id, member, verdict, ts`. One row per vote — an audit trail, not a
  mutable counter — so penalties can be recomputed and votes attributed.
- **Soft-demote in ranking:** a new `FEEDBACK_PENALTY` multiplier in
  `gateway/src/rank.ts`. `retrieve()` loads a per-fact net-negative count via a
  new `IndexDb.feedbackPenalties(space, project) → Map<factId, number>` (count
  of `wrong`+`stale` minus `useful`, floored at 0) and passes it into
  `adjustScores`. A flagged fact's score is multiplied by
  `FEEDBACK_PENALTY ** netNegative` (start `0.8`): it ranks lower but is **not**
  removed — one member's click nudges, never silences; `useful` votes offset.
  If the map load throws, `adjustScores` runs with no penalties (fail-open —
  feedback must never break retrieval).
- **Hot-path cost:** adds one D1 read (`feedbackPenalties`) to retrieval. The
  query returns only facts that *have* feedback (empty for most spaces), so it
  is ~free until feedback exists and stays inside the p95<500ms budget.
- **Rationale:** wiring a single member's signal into production ranking (chosen
  over pure signal-collection) is bounded and reversible here — the demote is
  small and the raw votes are retained to recalibrate the magnitude once the log
  has data.

## Component 4 — τ calibration script (recommend-only)

- **Script** `gateway/eval/calibrate-tau.mjs` (node, run manually). Consumes a
  **`retrieval_log` export** rather than touching live D1 directly, so
  export → judge → recommend stays offline and a bad run never moves
  production.
- **Export endpoint** `GET /admin/retrieval-log?since=<iso>&limit=<n>`: returns
  sampled logged retrievals (query + returned facts + scores + injected flag) as
  JSON. `retrieval_log` already exists (Phase A); this path only reads it.
- **Computation:** for each sampled injected fact, an LLM-judge call (the
  existing free-tier `gen` model, same judge style as `supersede.ts`) labels it
  relevant/irrelevant to its query. Bucket injections by adjusted score, compute
  judged-relevance per bucket, report the τ where the curve crosses the
  precision target (default 0.9). Output: a printed bucket table + a
  **recommended τ** (a human edits the `TAU` constant to apply) + current
  silence-rate and unnecessary-injection-rate (the exit metric) from the sample.
- **Pure core** `recommendTau(judged[]) → { tau, buckets }` lives in
  `eval-golden.ts` alongside `recallAtK`, unit-testable with synthetic judged
  data (no LLM in the test). Only the script driver calls the real judge.

## Data model — migration `0004_phase_c_eval_feedback.sql`

```sql
CREATE TABLE memory_feedback (
  space TEXT, project TEXT, fact_id TEXT,
  member TEXT, verdict TEXT, ts TEXT
);
CREATE INDEX idx_feedback_fact ON memory_feedback(space, project, fact_id);

CREATE TABLE golden_candidate (
  space TEXT, project TEXT, query TEXT,
  expected_fact_id TEXT, note TEXT, ts TEXT, promoted INTEGER DEFAULT 0
);
```

`retrieval_log` already exists (Phase A) — calibration only reads it.

## Test plan (TDD, red-green per unit)

- `renderPromptInjection` — silent on empty results, compact framing on hits.
- `/hook/prompt` handler — Cursor regression returns the fact; below-τ → empty
  body; embed failure → empty body (fail-open).
- `recallAtK` / `recommendTau` — pure-function unit tests with synthetic data.
- `golden.test.mjs` — recall@10 ≥ floor on the seeded fixture.
- `feedbackPenalties` + `adjustScores` penalty — a `wrong`-flagged fact ranks
  below an identical unflagged one; `useful` offsets; empty map is a no-op.
- `memory_feedback` MCP tool — records a row; unknown verdict rejected;
  fail-open on write error.

## Build sequence (each step merges green)

1. `renderPromptInjection` + `/hook/prompt` route + Cursor regression test.
2. Migration `0004` + `recallAtK` + `golden.json` fixture + `golden.test.mjs`.
3. `memory_feedback` tool + `feedbackPenalties` + soft-demote.
4. `/admin/golden-candidate` + `/admin/retrieval-log` export + `recommendTau` +
   `calibrate-tau.mjs`.

## Non-goals (YAGNI)

- No auto-applied τ (recommend-only; a human edits the constant).
- No auto-promotion of golden candidates (human curates the fixture).
- No fact-lifecycle action from feedback beyond the soft ranking demote (no
  auto-supersede/hide).
- No learned ranker — only earns consideration once the log holds thousands of
  judged examples (roadmap §7).
