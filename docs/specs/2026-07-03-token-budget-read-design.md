# Token-Budget Read — Design Spec (Phase 1)

**Source:** `~/.gstack/projects/skandaramanan-MemoryLayer/ceo-plans/2026-07-03-graph-memory-store.md`, Phase 1.

## Problem

`ContextStore.read()` caps the returned entries to the most recent 30 by
**count** (`DEFAULT_READ_LIMIT`, `src/store.ts:19`). Overhead therefore scales
with entry count, not size: 30 one-line entries under-use the context window;
30 long entries can blow it. There's no way to ask for "as much history as
fits in N tokens."

## Approach

Replace the count cap with a token-budget cap. No new dependencies — token
count is approximated as `Math.ceil(text.length / 4)` (the standard rule-of-
thumb ratio), which is enough precision for a soft budget and keeps the read
path dependency-free per this repo's existing constraint (see the metrics
instrumentation plan's "zero new runtime dependencies" precedent).

`ContextStore.read(project, budgetTokens?)` walks entries **most-recent
first**, summing `estimateTokens(payload) + ENTRY_OVERHEAD_TOKENS` (a fixed
per-entry allowance for the rendered header/separator that
`context-format.ts` adds), and stops once adding the next (older) entry would
exceed the budget. The single most recent entry is always included even if
it alone exceeds the budget — an oversized-but-present entry beats an empty
read, matching this codebase's existing "never silently go empty" posture
(e.g. `selfHealPush`, hook fail-open).

`budgetTokens <= 0` means unlimited, preserving the old `limit <= 0` escape
hatch semantics.

`total` is unchanged — the true entry count regardless of what fits.

## Configuration

New `Config.readBudgetTokens: number`, sourced from
`MEMORYLAYER_READ_BUDGET_TOKENS` (default `DEFAULT_BUDGET_TOKENS = 4000`,
same magnitude as the old 30-entry cap for typical short entries). Added to
`HOOK_ENV_ALLOWLIST` so it's settable via `.memorylayer-hook.env` like every
other MemoryLayer config key.

## Call sites

- `hook.ts`: `store.read(project, cfg.readBudgetTokens)` — the session-start
  hook has no per-call parameter surface, so it always uses the configured
  default.
- `index.ts` `read_context` MCP tool: new optional `budget_tokens` input
  (positive integer). When given, overrides `cfg.readBudgetTokens` for that
  one call — lets an agent ask for a smaller or larger window on demand.

## Out of scope (Phase 2)

Query-based retrieval, graph expansion, embeddings, auto-classification,
supersession detection, compaction — all deferred to Phase 2 per the CEO
plan's decided sequencing (gated on reliance-test data). This phase changes
nothing about the git ledger, `frontmatter.ts`, or `context-format.ts`'s
rendering — only which entries `read()` selects.
