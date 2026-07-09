---
status: ACTIVE
supersedes:
  - docs/roadmap/2026-07-03-graph-memory-store.md
  - docs/retrieval-relevance-findings.md
---

# Remote Relevance Engine — Ground-Up Redesign of Memory Storage & Retrieval

Date: 2026-07-07
Branch: gateway/url-token-auth (design authored here; implementation branches from main)

This document replaces the 2026-07-03 graph memory store plan and absorbs the
2026-07-07 retrieval-relevance findings. It is the single authoritative design for
how MemoryLayer stores, indexes, retrieves, and injects memory across all clients.

---

## 0. Verdict on the existing design, up front

The 2026-07-03 plan was architected for a world that no longer exists. Its load-bearing
premise — *every client has a local git clone and rebuilds a private SQLite index from
it* — was invalidated the week it was written, when the hosted gateway shipped a second,
stateless, clone-less execution plane. Its "no network dependency" embedding promise
(bundled ONNX model, native better-sqlite3) bought vendor purity at the cost of a
native-module build matrix, tens of MB of package weight, and an index that cannot serve
ChatGPT/hosted members at all. Under the remote-first mandate, that entire local-index
architecture is **removed**, not deferred.

What survives from it — because it is genuinely strong:

1. **Git as the durable, vendor-neutral ledger.** Append-only markdown entries,
   commit-per-write, repo-per-space tenant isolation. This is the moat and it is
   unchanged, byte-for-byte. No migration of stored data, ever.
2. **The disposable-index property.** The index is *derived* from the ledger and can be
   deleted and rebuilt with zero data loss. This kills the "ledger and index disagree"
   bug class permanently. We keep the property; we move where the index lives.
3. **Token-budget packing** (`packToBudget`) — shipped, correct, retained as the final
   stage of every read.
4. **Supersession as a first-class lifecycle** — the single most valuable "graph" idea.
   Retained, redesigned (§4).
5. **Fail-open hooks** — a broken retrieval must never break a session. Retained as an
   invariant on every new path.

What is removed, with reasons:

| Removed | Why |
|---|---|
| Per-clone SQLite index, WAL piggybacking on `serialize()` | Cannot serve the hosted plane; N divergent indexes for one space; native dep |
| Bundled ONNX embedding model in the npm package | Remote-first makes "no network on write" a non-goal; package bloat for nothing |
| Rule-based-only classification ("decided", "?" density) | It existed only to avoid a network call. Server-side ingest is async, so a real model is free to use; keyword heuristics misclassify exactly the prose-buried facts we most need |
| One `.md` file = one node = one embedding | **Confirmed** failure mode: multi-fact entries blur into one vector; the Cursor-decision miss is this. The unit of memory must be the fact, not the file (§3) |
| Pull-triggered incremental indexing in every client | Replaced by one server-side ingest triggered by GitHub push webhooks — one index, one ingest path, both planes covered |
| `relates_to` / `blocks` / `mentions` edges | Materialized "relatedness" is redundant with query-time embedding similarity; `blocks` had no consumer; entity mentions become tags, not edges (§4) |
| Fixed lexicographic ranking `unresolved > recency > similarity` | Unproven, and lexicographic ordering means similarity never overcomes recency — precisely the failure we observed. Replaced by fused scoring (§5) |
| Gating the retrieval fix on the 4-week reliance test | The gate's premise was "unmeasured problem." We now have a confirmed, reproducible recall miss. The retrieval slice is un-gated; the *reliance* test continues in parallel as an adoption metric, not an engineering gate |

---

## 1. The problem, restated precisely

Retrieval today is `recency + token budget` on both planes. Confirmed consequences:

- A settled decision 40 entries deep was not surfaced when its exact topic came up,
  and the agent gave contradicting advice. Old-but-relevant always loses to
  new-but-irrelevant.
- `read_context` has no `query` parameter; retrieval cannot be conditioned on what the
  agent is doing.
- Mid-session pull is flat: reads cluster at session start. Agents don't re-query
  because nothing tells them what the store *might* know.
- Multi-fact prose entries are unretrievable by their minor topics even on a full read.
- No distinction between durable standing rules and transient status updates.
- Zero recall-quality instrumentation: we count reads/writes but cannot measure "was
  the relevant decision surfaced."

The redesign has to fix all six, for both planes, without touching the ledger format.

---

## 2. Architecture: one ledger, one remote index, thin clients

```
                          WRITES (either plane)                READS (all planes)
                                  |                                   |
 local CLI ── git push ──► GitHub repo (per space) ◄── Contents API ──┤ (gateway write)
                                  │                                   │
                                  │ push webhook (GitHub App)         │
                                  ▼                                   ▼
                        ┌────────────────────────────────────────────────────┐
                        │        Relevance Service (Cloudflare Worker)       │
                        │                                                    │
                        │  INGEST (async):                                   │
                        │   diff since last_indexed_sha → parse entries      │
                        │   → LLM fact extraction → embed → supersession     │
                        │   check → upsert D1                                │
                        │                                                    │
                        │  STORAGE: D1 (facts, FTS5, embeddings, edges,      │
                        │           retrieval log)   KV (tenancy, caches)    │
                        │                                                    │
                        │  RETRIEVE: candidates (FTS ∪ vector) → fuse →      │
                        │   lifecycle/tier adjust → threshold → pack →       │
                        │   render with provenance                           │
                        └────────────────────────────────────────────────────┘
                                  ▲                    ▲                  ▲
                          MCP tools (hosted)    /hook/read &        local CLI reads
                          Claude/ChatGPT/…      /hook/prompt        (remote-first, git
                                                                    fallback offline)
```

### 2.1 Placement decisions

- **The index lives in the gateway, in D1.** One SQLite-family database, one `space`
  column, tenant scoping enforced the same way tool calls already are: the member token
  resolves to exactly one space, and every query is parameterized by it. D1 supports
  FTS5, is serverless, and is already in the account's platform. No native modules,
  no per-client state.
- **Embeddings are stored in D1 and scored by brute-force cosine in the Worker.**
  This is deliberate. A space at pilot scale holds hundreds to low-thousands of facts;
  exact scan over ≤10k 384-dim vectors is single-digit milliseconds and has zero
  operational surface. Vectorize (or any ANN index) is a swap-in behind the same
  candidate-generation interface when a space crosses ~50k facts. Do not build ANN
  infrastructure before exact search is the bottleneck.
- **Embedding model: Workers AI `bge-base-en-v1.5`** (or current equivalent) — in-platform,
  ~50ms, free-tier allocation covers pilot volume. Vendor neutrality is preserved where
  it matters: vectors are *derived data*. If we switch models, `reindex` re-embeds the
  ledger. The neutrality promise lives in the ledger, never in the index.
- **Fact extraction & supersession-judge model: Workers AI open models** (Llama
  3.3 / Gemma / Qwen class), free-tier allocation — $0 recurring, preserving the
  production roadmap's constraint. This is safe because the model choice is
  *reversible*: facts are derived data, so a better extractor later just means a
  `reindex` re-run, and the client-structured write path (§3) makes server extraction
  a safety net rather than the primary quality gate. A paid model (e.g. Claude Haiku,
  <$1/month at pilot volume) is the escalation path, taken only if the extraction-
  fidelity or supersession-accuracy audits (§7) fail on the free model — the metric
  decides, not taste. Condition on going free: the supersession judge must be tuned
  conservative (prefer surfacing `conflicts_with` over auto-linking), because false
  supersession is the one failure reindex does not undo by itself (§8).
- **No Queues dependency.** Gateway writes ingest via `ctx.waitUntil`; local-plane
  writes arrive via the GitHub push webhook; a scheduled cron (free) reconciles
  `last_indexed_sha` against each space's HEAD to catch dropped webhooks. Queues become
  worth their paid plan only if ingest volume makes webhook-inline processing miss the
  Worker CPU budget.

### 2.2 The two planes after this design

- **Hosted plane**: unchanged auth/tenancy; MCP tools and hook endpoints now call the
  relevance service instead of raw recency reads.
- **Local plane becomes remote-first for reads.** The CLI/hook calls the gateway's
  retrieval API (same member token) and falls back to today's local recency+budget read
  only when offline or unconfigured — fail-open preserved, and the fallback is the
  code that already exists and works. Local *writes* keep committing to the clone and
  pushing (offline-capable, durable); the webhook indexes them seconds later. The local
  clone's role narrows to: durable offline write buffer + human-browsable archive +
  escape hatch. This is the honest consequence of remote-first: we stop pretending the
  clone is a retrieval engine.

### 2.3 Consistency model

The index is **eventually consistent** with the ledger, seconds behind (webhook
latency). This is acceptable because: (a) a writer's own gateway write is ingested
inline before the tool call returns its response, so read-your-own-writes holds on the
hosted plane; (b) cross-author staleness of seconds is far inside the minutes-to-days
cadence of planning memory; (c) the cron reconciler bounds divergence, and
`POST /admin/reindex` rebuilds a space from the ledger from scratch — the disposability
guarantee, kept.

---

## 3. The unit of memory: facts, not files

**Confirmed lesson:** authors write multi-fact prose, and no amount of prompt
discipline will stop them. So atomicity is enforced at *ingest*, not at write time.

Ingest runs LLM extraction over each new ledger entry and emits **atomic facts**:

```
fact {
  id, space, project
  kind:  decision | constraint | preference | status | question | reference
  tier:  canon | normal          -- canon = standing rule, always eligible for injection
  body:  1–3 sentences, self-contained, includes the "because" when the source has one
  entities: [normalized tags]    -- e.g. ["cursor", "mcp-config"]
  source_file, source_author, source_ts   -- provenance: every fact points at its ledger entry
  embedding, created_at
  superseded_by: fact_id | null
}
```

Extraction rules that matter:

- **Self-containment**: each fact must be understandable with zero surrounding context
  ("Cursor MCP config is project-scoped, not global — verified 2026-07-04"), because it
  will be injected alone.
- **Fidelity over fluency**: the extractor quotes and condenses; it must not infer facts
  the source doesn't state. Every fact carries its provenance link so a reader can
  audit the source entry. Extraction drift is a named risk (§8) with a named eval.
- **Tier assignment**: the extractor *suggests* `canon` for standing rules/constraints
  ("always X", "never Y", conventions, environment invariants); `write_context` also
  gains an optional explicit `tier` field for authors who know. Status updates
  ("implemented X on branch Y") are never canon.
- **Client-structured writes first, server extraction as the floor.** The writing
  agent (Claude Code, Codex, Cursor) is itself a strong model with full conversation
  context — better placed than any server-side extractor to state a fact atomically
  and explain the "because". So `write_context`'s schema and description invite
  structured atomic writes directly: one fact per call, optional `entities`, `tier`,
  and `supersedes` fields. Entries that arrive already atomic pass through ingest
  with little or no extraction work (cost → 0, fidelity → source-perfect). Server
  extraction remains mandatory as the safety net because prompt discipline across
  heterogeneous clients demonstrably degrades — the confirmed Cursor miss WAS a
  well-instructed client writing a multi-fact blob. Best case is structured at the
  source; guaranteed floor is extraction at ingest.
- The ~70 existing entries are re-ingested once by the same pipeline (this is just
  `reindex`). Prose-buried history becomes retrievable without rewriting the ledger.

The ledger entry format is **unchanged**. Facts are index-plane objects. A fact is
never the source of truth; its source entry is.

## 4. The graph, right-sized

Re-evaluated from zero: at this corpus size and shape, a general knowledge graph is
complexity theater. Embedding similarity already answers "what is related" at query
time, better than any materialized `relates_to` edge we would write at ingest time.
Graph structure earns its place in exactly three relationships:

1. **`supersedes` (fact → fact).** The lifecycle edge. A superseded fact is excluded
   from every default retrieval — this is what keeps the store honest as it grows, and
   no ranking function can substitute for it. Detection at ingest: candidate generation
   by embedding NN *among facts sharing an entity tag* in the same project, then a
   cheap LLM judgment ("does new fact replace, contradict, or merely relate to old
   fact?"). This resolves the old plan's unresolvable similarity-threshold question:
   similarity is only a candidate generator; the *decision* is made by a model that can
   actually read both facts. Contradiction without clear replacement is surfaced in the
   write response (`conflicts_with: [...]`) rather than auto-linked.
2. **`derived_from` (fact → ledger entry).** Provenance. Non-negotiable for audit and
   for the injection trust story.
3. **Entity tags (fact → normalized string).** Not nodes with their own lifecycle —
   just an indexed tag table. They power: supersession candidate scoping, metadata
   filtering, and the **topic manifest** (§6), which is the retrieval-intelligence
   keystone. If cross-entity reasoning ever earns its place, tags can be promoted to
   nodes; today that would be speculative structure.

Temporal relevance and decay, redesigned: **decisions and constraints do not decay by
clock — they decay by supersession.** A 6-month-old unsuperseded constraint is exactly
as binding as a new one; age-based decay of decisions is how you re-lose the Cursor
fact. Time decay applies only to `status` and `question` kinds (half-life ~14 days on
their ranking boost), because "implemented X on branch Y" genuinely rots. Compaction
into digest nodes is **deferred entirely**: superseded-exclusion plus fact granularity
already bounds the default read; build digests when live-fact volume, not raw-entry
volume, pressures the budget.

### D1 schema (index plane, disposable)

```sql
facts(id TEXT PK, space TEXT, project TEXT, kind TEXT, tier TEXT,
      body TEXT, source_file TEXT, source_author TEXT, source_ts TEXT,
      embedding BLOB, superseded_by TEXT NULL, created_at TEXT);
fact_entities(fact_id TEXT, entity TEXT);           -- + index (space, project, entity)
facts_fts    -- FTS5 over body + entities
index_state(space TEXT PK, last_indexed_sha TEXT);
retrieval_log(id, space, project, trigger TEXT, query TEXT,
              returned TEXT /*json: fact_ids+scores*/, injected BOOL, ts TEXT);
```

---

## 5. Retrieval pipeline

Every retrieval, regardless of trigger, runs the same pipeline:

1. **Candidate generation** (scoped to space+project, `superseded_by IS NULL`):
   - FTS5/BM25 top-50 on the query text
   - embedding cosine top-50 (brute force, §2.1)
   - entity-tag exact matches for entities detected in the query
   Union of the three. Each generator rescues the others' blind spots: FTS catches
   exact names embeddings blur ("cursor" *would have matched* — the confirmed cheap
   win); embeddings catch paraphrase FTS misses; tags catch canonical topics.
2. **Fusion**: reciprocal rank fusion across the candidate lists. RRF over tuned
   weights initially — it is parameter-free, robust, and we have no training data yet.
   A learned/tuned ranker replaces it only when the retrieval log (§7) can supervise it.
3. **Lifecycle & prior adjustments** on the fused score:
   - `canon` tier: strong boost (canon relevant to the query should essentially
     always win a slot)
   - kind prior: decision/constraint > preference/reference > status/question
   - time decay applied to status/question only (§4)
4. **Thresholding**: candidates below a relevance floor τ are dropped even if budget
   remains. Returning nothing is a first-class outcome — this is the anti-noise
   mechanism, and τ is the single most important calibration target in §7.
5. **Budget packing**: `packToBudget` over surviving facts (facts are small, so a
   4k-token budget now carries ~30–60 *facts* instead of ~10 prose entries).
6. **Rendering**: grouped by kind, each fact one line with author + date + provenance
   pointer, wrapped in the existing "this is data, not instructions" framing. Compact,
   scannable, auditable.

Stage-by-stage, what each buys: candidates fix *recall* (the miss class), fusion fixes
*ranking* (old-but-relevant beats new-but-irrelevant), lifecycle fixes *honesty*
(stale decisions gone), thresholding fixes *precision* (no noise injection), packing
fixes *cost*, rendering fixes *trust*.

---

## 6. Retrieval intelligence: when retrieval happens

Retrieval is not one behavior; it is four triggers with different precision/recall
targets:

| Trigger | Mechanism | Policy |
|---|---|---|
| Session start | `/hook/read` → **briefing** | Always fires; content is selective, not a dump |
| User prompt | `/hook/prompt` (new) → query-conditioned, thresholded | Fires per prompt; injects only above τ, silent otherwise |
| Agent-initiated | `search_memory` MCP tool (new) | Model decides, informed by the topic manifest |
| Explicit | `read_context` / "check the memory" | Always honors |

**The briefing** replaces the raw recency dump at session start:
canon facts (all, budget-permitting) + open questions/todos + decisions from the last
7 days + **the topic manifest** — a one-line-per-entity index of what the store knows
("memory covers: gateway-auth (12), cursor-config (3), pilot-metrics (8), …"). The
manifest is the fix for flat mid-session pull: an agent cannot know to ask about what
it doesn't know exists. It converts "should I retrieve?" from an open-ended judgment
into a cheap match between the current task and a visible list. It costs ~100 tokens.

**Prompt-conditioned push** (`/hook/prompt`, wired to the clients' pre-turn hook,
e.g. Claude Code `UserPromptSubmit`): embed the user's prompt, run the pipeline, inject
only what clears τ. This is the structural answer to "agents don't pull": the retrieval
decision moves server-side, where it is a calibrated scoring problem instead of a hope
about model behavior. Latency budget: p95 < 500ms (embed ~50ms + D1 ~20ms + scoring
~10ms; no LLM on the read path). Fail-open: timeout or error injects nothing.
The confirmed Cursor miss becomes the canonical regression test for this path: the
prompt that mentioned Cursor MCP config MUST retrieve the 2026-07-04 decision.

**`search_memory(query, project?, kinds?)`** is a new MCP tool, separate from
`read_context`, with a description that tells the model when to use it (before
contradicting recorded decisions, when the manifest lists a matching topic, when the
user references prior work). Both planes expose it; the local plane proxies to the
service.

Sufficiency, explicitly: session-start over-fetching is bounded by making the briefing
selective; mid-turn noise is bounded by τ; the manifest bounds *missed* retrievals by
making the knowable visible. We do not retrieve on every interaction — we retrieve on
every *prompt*, and inject on the small fraction that clears the bar.

---

## 7. Evaluation: measured, not vibes

Everything below is computable from two sources: the `retrieval_log` table (every
trigger, query, candidate set, scores, injected set) and a **golden set** — curated
(query → expected fact) pairs built from real history, seeded with the Cursor miss and
grown by logging every future observed miss. This directly closes today's gap of "no
precision/recall metric exists."

**Retrieval quality**
- `recall@k` on the golden set (target: ≥0.95 at k=10) — the headline metric
- `precision@k` via periodic LLM-judge over sampled logged retrievals (judge sees
  query + injected facts, scores each relevant/irrelevant)
- useful-context rate: fraction of injected facts referenced by the agent's subsequent
  turn (LLM-judged on sampled transcripts where available; proxy elsewhere)
- user acceptance: explicit signal — the write path already sees "record this";
  add a lightweight `memory_feedback(fact_id, useful|wrong|stale)` tool and count it

**Retrieval timing**
- unnecessary-injection rate: prompt-hook injections judged irrelevant (target <10%)
- missed-retrieval rate: sessions where a stored fact contradicting/answering the turn
  existed but wasn't injected — measured by post-hoc audit of sampled sessions (this is
  exactly how the Cursor miss was found; make it a routine, not an accident)
- trigger calibration: bucket injections by score, plot judged-relevance per bucket;
  τ is set where the curve crosses the precision target, re-checked monthly
- silence rate: fraction of prompts where nothing cleared τ (a health signal — near-0%
  means τ is too low; near-100% with misses means too high)

**System performance**
- p50/p95 latency per endpoint (prompt-hook p95 < 500ms is a hard budget)
- cost per retrieval and per write (embedding + extraction API spend / event counts)
- index growth: facts per space, live-vs-superseded ratio (a healthy store's live set
  plateaus while the ledger grows — this ratio IS the "graph quality" metric)
- supersession accuracy: sampled audit of auto-written `supersedes` edges (false
  supersession silently *hides* live facts — the most dangerous failure in the design,
  so it gets its own audit)
- extraction fidelity: sampled facts checked against source entries for hallucination

**How metrics govern iteration**: recall misses → new golden-set entries → candidate-gen
fixes. Precision misses → τ/prior tuning. Only when the log holds thousands of judged
examples does a learned ranker earn consideration. No component is upgraded without a
metric showing it is the current bottleneck.

---

## 8. Risks and open questions

**Major technical risks**

1. **Extraction infidelity.** An LLM summarizing a decision can distort it, and the
   distorted fact is what gets injected. Mitigations: condense-don't-infer prompt,
   provenance link on every fact, fidelity audit metric, and the ledger as recoverable
   truth (re-extract with a better prompt = reindex).
2. **False supersession** hides live facts silently — and unlike extraction quality,
   reindex alone does not undo it. Sharpened by the $0 model choice (a weaker judge
   errs more). Mitigations: LLM-judged (not threshold-judged) linking, entity-scoped
   candidates only, a conservative judge policy (`conflicts_with` surfacing instead of
   auto-link whenever unsure), the supersession-accuracy audit, and metric-gated
   escalation to a paid judge model if that audit fails.
3. **Prompt injection through memory**, now amplified: extraction *reads* untrusted
   entries and the prompt hook *auto-injects* on every turn. The production roadmap's
   "context is data, not instructions" wrapper is now load-bearing on the hook path;
   extraction output is constrained to the fact schema; within-space trust boundary
   stays as documented.
4. **Webhook fragility.** Missed webhooks stall ingest for local-plane writes.
   Mitigated by cron reconciliation against HEAD sha and `reindex`; residual risk is
   minutes of staleness, which the consistency model already accepts.
5. **Platform concentration.** The index plane is now Cloudflare-shaped (Workers, D1,
   Workers AI). Accepted deliberately: everything above the ledger is disposable and
   re-derivable, so the exit cost is a re-implementation of the service, not a data
   migration.

**Unresolved research questions**

- τ calibration with near-zero initial labeled data — start conservative (favor
  silence), lower it as the golden set grows?
- Can "useful context rate" be measured without transcript access on all clients, or
  does it stay a sampled-clients-only metric?
- Cross-project retrieval within a space (a canon fact about the team's conventions
  lives in one project bucket today) — probably a `space`-scoped canon tier, but the
  fragmentation-by-slug history says be careful.
- Multi-space members: should a person's preferences travel across spaces? (Out of
  scope until a real member asks.)
- When live-fact volume finally pressures budgets: digests, clustering, or per-entity
  summarization? Decide with data; all three are compatible with this schema.

---

## 9. Build order

Phased so every phase ships a measurable retrieval improvement and nothing blocks on
the phase after it.

**Phase A — retrieval slice (un-gated, first):**
D1 schema + webhook/waitUntil ingest with *naive* per-entry indexing (one entry = one
indexed doc, no extraction yet) + FTS5 + embeddings + the pipeline (§5) + `query` param
on `read_context` + `search_memory` tool + `retrieval_log`. This alone fixes the
confirmed miss class (FTS on "cursor" matches) on both planes, and starts collecting
the data every later phase needs. Local CLI reads go remote-first with git fallback.

**Phase B — facts and lifecycle:**
LLM extraction → atomic facts, entity tags, canon tier, supersession detection,
one-time re-ingest of existing entries, the session-start briefing + topic manifest
replacing the recency dump.

**Phase C — retrieval intelligence and evals:**
`/hook/prompt` thresholded push, golden-set harness + LLM-judge sampling + metrics
dashboards, τ calibration loop, `memory_feedback` tool.

Each phase's exit is a metric, not a feeling: A exits when golden-set recall@10 ≥ 0.9;
B when extraction-fidelity and supersession audits pass on the re-ingested corpus;
C when the prompt hook holds <10% unnecessary-injection at <500ms p95.

---
---
