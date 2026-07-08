# Retrieval Relevance — Findings Handoff (2026-07-07)

> **ABSORBED (2026-07-07)** into `docs/roadmap/2026-07-07-remote-relevance-engine.md`,
> which is now the authoritative design. This file remains as the evidence record.

Handoff for a fresh architecture discussion. **No final architecture proposed here.**
Tags: **[CONFIRMED]** = verified this session (code read, live test, or store entry).
**[SPECULATION]** = analysis/inference, not verified. **[NOT VERIFIED]** = referenced
in docs but source not read this session.

---

## 1. Approaches tried

- **[CONFIRMED] v1 — flat `.md` + count cap.** `read_context` returned the last N (~30)
  entry files in a project dir, concatenated verbatim. Original design.
- **[CONFIRMED] Phase 1 (shipped) — token-budget read.** Count cap replaced by a
  token-budget pack (`packToBudget` / `DEFAULT_BUDGET_TOKENS`). This is item #2 of the
  graph plan; shipped. Zero new dependencies.
- **[CONFIRMED] Graph plan Phase 2 — DESIGNED, NOT BUILT.** SQLite derived index +
  embeddings + FTS5 + typed nodes + auto-supersession + compaction. Fully architected in
  `docs/roadmap/2026-07-03-graph-memory-store.md`, all items ACCEPTED, but **gated on the
  4-week reliance-test data** and not implemented.
- **[CONFIRMED] Hosted gateway (shipped, live).** A second execution plane: stateless
  Cloudflare Worker, no local clone, reads/writes via GitHub API. Retrieval on this plane
  is the same recency+budget logic, further capped (≤40 newest files).

## 2. What failed and why

- **[CONFIRMED] Live recall miss this session.** A real, settled decision — "Cursor MCP
  config is project-scoped" (entry dated 2026-07-04T08:30) — existed in the store but was
  NOT surfaced when the exact topic came up. The assistant initially gave advice
  contradicting it. Root causes (mechanism confirmed):
  1. **Recency+budget window.** Session-start injection loaded only ~11 most recent of
     41 entries; the decision sat ~40 entries deep, outside the window.
  2. **No relevance ranking.** Retrieval is write-order/recency, so old-but-relevant loses
     to new-but-irrelevant.
  3. **No query-conditioned retrieval.** Injection is topic-agnostic; nothing re-queried
     for "cursor" when it surfaced. `read_context` has **no `query` param** (confirmed via
     tool schema: only `project` + `budget_tokens`).
  4. **Prose-buried, coarse granularity.** The decision was a "SCOPING AUDIT" sub-paragraph
     inside a larger entry whose headline subject was the clone-isolation bug fix — not
     retrievable by topic even on a full read.
  - It only surfaced when `read_context` was manually called with `budget_tokens=6000`
    (17 entries), and even then it was the oldest one shown.
- **[CONFIRMED] "Opportunistic pull is flat"** (prior pilot finding in the store): reads
  cluster at session-start (push); agents rarely re-query mid-session (pull). Same disease
  as the miss above.

## 3. Problems discovered

- **[CONFIRMED] Two retrieval planes have diverged.** The graph plan assumes a **local**
  SQLite index each client rebuilds from its git clone. The hosted gateway is **stateless
  with no clone**, so Phase 2 as written does not apply to hosted/ChatGPT members. Hosted
  retrieval intelligence would require the plan's **DEFERRED item #7 (hosted multi-tenant
  index service)** — the gateway pivot quietly moved #7 onto the critical path.
- **[SPECULATION] Multi-fact entries defeat one-node-per-file indexing.** The plan
  classifies/embeds one `.md` → one node with one `kind`/embedding. An entry holding
  several decisions (as the offending one did) yields a blurred vector dominated by its
  headline topic; semantic recall for a minor sub-fact would rank poorly. FTS5 keyword
  would still match, so #1 alone likely rescues the by-subject case.
- **[SPECULATION] No "canon" tier.** No distinction between durable standing rules
  (should always inject) and transient status updates ("implemented X on branch Y").
  Everything is one flat, equally-weighted stream.

## 4. Current codebase understanding

Two planes over one git ledger:

- **Local stdio plane** (`memorylayer` npm CLI, `src/`). Hooks + stdio MCP server. Pulls a
  git clone, reads/writes `.md`, commits/pushes.
- **Hosted gateway plane** (`gateway/`, Cloudflare Worker). Stateless; per-request GitHub
  API calls; no persistent local state beyond Workers KV (tenancy routing only).

Both write **byte-identical** entries to the same private repo per space, so the planes
coexist ("migration = coexist, no import"). Retrieval logic is equivalent (recency+budget)
on both; the gateway adds a hard ≤40-file fetch cap.

## 5. Important files / components

**[CONFIRMED] read directly this session:**
- `gateway/src/worker.ts` → `gateway/src/router.ts` (path routing).
- `gateway/src/mcp.ts` — hand-rolled stateless JSON-RPC; `handleMcp`; `TOOLS` defs;
  `resolveMember` gate. `PROTOCOL_VERSION = "2025-03-26"`.
- `gateway/src/tenancy.ts` — token→space KV mapping; `resolveMember`, `extractToken`.
- `gateway/src/hook-read.ts` — `/hook/read` injectable-text endpoint (uses `resolveMember`).
- `docs/roadmap/2026-07-03-graph-memory-store.md` — the ACTIVE graph plan (authoritative
  design for Phase 2).

**[NOT VERIFIED] referenced but source not read this session** (descriptions come from the
graph plan + gateway imports):
- `src/store.ts` — `ContextStore`, `readImpl`/`writeImpl`, `serialize()` mutex (per-clone
  git op serialization), `repo.pull()` on read+write.
- `src/context-format.ts` — `projectContext()` concatenation/projection.
- `src/token-budget.ts` — `packToBudget`, `DEFAULT_BUDGET_TOKENS` (import confirmed to
  exist; internals not read).
- `src/slug.ts`, `src/frontmatter.ts`, `src/config.ts` (clone-path keying, `defaultProject()`).

Other relevant docs: `docs/specs/2026-07-03-token-budget-read-design.md`,
`docs/plans/2026-07-05-hosted-gateway-core.md`, `docs/roadmap/2026-07-04-production-roadmap.md`.

## 6. Current data model

- **[CONFIRMED]** Append-only markdown, one file per entry:
  `context/<project>/<author>/<ISO-timestamp>-<id>.md`, with frontmatter (`type`, author,
  timestamp). On the hosted tool, `type ∈ {decision, context}`.
- **[CONFIRMED]** Git repo = source of truth ("ledger"), immutable/append-only.
- **[CONFIRMED]** Project names are **slugged (lowercased, punctuation→`-`)**; a different
  spelling = a different bucket (has caused real fragmentation bugs).
- **[CONFIRMED]** Filenames are ISO-timestamp-prefixed, so **basename sort = recency order**.
- **[CONFIRMED, FUTURE]** Graph plan proposes node `kind ∈ {decision, constraint, question,
  todo, person-note, digest, unclassified}` and edges `{supersedes, relates_to, blocks,
  mentions}` — NOT implemented; the live model has no nodes/edges, only files.

## 7. Current retrieval pipeline (as built today)

1. Client calls `read_context(project, budget_tokens?)` OR the session-start hook fires.
2. Local: `repo.pull()` then collect `.md` under `context/<project>/`. Gateway: GitHub API
   tree + fetch **≤40 newest** blobs (Workers 50-subrequest cap); `total` still full count.
3. Order by write order / recency (timestamp filename).
4. Pack into `budget_tokens` (`packToBudget`).
5. Render via `projectContext()` concatenation → plain text with a session-start preamble.

**[CONFIRMED] Absent today:** embeddings, FTS/keyword search, graph expansion, relevance
ranking, dedup, supersession filtering, and any `query` parameter. Retrieval is
recency + budget only.

## 8. Observed failure cases

- **[CONFIRMED]** The Cursor-decision recall miss (§2) — the primary case motivating this.
- **[CONFIRMED]** Flat opportunistic pull (agents don't re-query mid-session).
- **[CONFIRMED, separate cause]** Skanda-local duplicate hook fires inflating read counts
  (a config/dedup artifact, not a retrieval-quality issue; already noted in the store).

## 9. Hypotheses worth investigating — [SPECULATION]

- FTS5/keyword recall alone may rescue most by-subject misses cheaply (keyword "cursor"
  would have matched), before investing in embeddings.
- Semantic recall needs **atomic entries** (one fact per write) or **sub-entry chunking**;
  otherwise multi-fact entries blur.
- A **durable-canon / always-inject tier** for standing rules/constraints, independent of
  the budget-ranked recency window.
- **Query-conditioned retrieval** (add `query` param + nearest-neighbor) may matter more
  than simply enlarging the budget.
- Hosted-plane retrieval probably needs a **server-side index** (Workers KV / D1 /
  Vectorize) = graph plan #7, not the local SQLite design.
- Plan's proposed ranking `unresolved > recency > similarity` — plausible but unproven.

## 10. Things we should not repeat

- **[CONFIRMED lesson]** Don't bury multiple decisions in one prose entry — unretrievable
  by topic.
- **[CONFIRMED lesson]** Don't rely on session-start push alone; it's recency+budget-capped
  and misses aged/relevant facts.
- **[CONFIRMED lesson]** Don't assume the local-clone SQLite model covers hosted members —
  it doesn't.
- **[SPECULATION/opinion]** Don't gate the *retrieval* fix solely on reliance-test duration
  now that a concrete miss is observed — the gate's premise ("unmeasured problem") is
  partly satisfied.

## 11. Unanswered questions

- **Local-first index vs server-side hosted index**, given the hosted pivot? (open fork —
  the central architecture question)
- Should the **retrieval slice** (FTS #1 + embeddings #3 + `query` param) be un-gated from
  the rest of Phase 2 (#4/#5/#6)?
- Embedding model: **local bundled** (vendor-neutral, package-size cost) vs **API**
  (simpler, adds network dependency + per-write cost)? (plan open Q)
- Supersession **similarity threshold** default? (plan open Q)
- **Digest format**: lossy summary vs detailed-with-pointer-back? (plan open Q)
- How to handle **existing multi-fact / prose-buried entries** in any index — re-chunk,
  re-write, or accept blur?
- Where does a hosted index physically live (KV / D1 / Vectorize)?
- Is write-time **atomicity/tagging** enforced by tooling or by prompt discipline?
- **How is recall quality even measured?** Only read/write counts are instrumented today;
  there is no precision/recall metric for "was the relevant decision surfaced."

## 12. Session-relevant note (context, not retrieval)

The hosted gateway gained a URL-embedded token fallback this session (`/mcp/<token>` and
`?key=`) so header-less clients (ChatGPT) can connect. Committed on branch
`gateway/url-token-auth`. Unrelated to retrieval, but explains why "hosted plane" is
top-of-mind and why #7 (hosted index) now matters.
