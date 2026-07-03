# MemoryLayer Write Trigger — Design

Date: 2026-07-02
Status: Shipped — merged in PR #1 (write-trigger). This doc is now a historical design record; behavior of record lives in the code + tests.
Phase: 0 (last open Phase-0 engineering decision — see SoT §9 open items)

## Problem

Reads are already guaranteed via a project-scoped `SessionStart` hook (neutral core +
per-vendor adapter). Writes are still model-invoked through the `write_context` MCP tool —
the weak half of the loop. A model spontaneously *noticing* that a decision is worth
recording is only ~60–85% reliable and decays over long chats; a silent miss teaches
"I can't rely on this," which kills the dependency signal the 4-week test measures.

The asymmetry with reads: reads could be taken away from the model entirely (inject at
session start). Writes cannot, because **writing needs judgment about what is worth
recording** — that judgment is exactly what the model provides. So the fix is not "remove
the model" but "make the invocation human-initiated or hook-forced rather than dependent on
the model spontaneously noticing."

## Goal

A reliable, vendor-neutral write path that captures deliberate decisions without turning the
store into a firehose, reusing the proven read-hook pattern (neutral core + thin per-vendor
adapter) so neutrality is spent only in small adapter files.

Non-goals (scope creep is the documented #1 failure mode): no auto-summarization/RAG, no
separate extraction infrastructure, no structured-state moat, no changes to `write_context`'s
core behavior.

## Approach: three paths, one neutral sink

All three paths funnel into the existing `write_context` MCP tool. Its core is unchanged.
Reliability comes from *how* the call is initiated, not from new storage machinery.

| Path | New machinery | Clients | Reliability |
|---|---|---|---|
| A. Explicit phrase ("record this: …") | ~none (works today) | All, incl. Claude Desktop | High — direct imperative |
| B. Slash command `/remember [text]` | thin per-vendor command file | Claude Code + Cursor | Highest — muscle memory |
| C. Per-turn gated self-review on `Stop` | Stop hook + neutral prompt | Claude Code + Cursor | Safety net for unflagged decisions |

This mirrors the read-hook neutrality split exactly: **Claude Desktop gets only path A**
(model's-choice, pull-based), because it has no slash commands and no hook system; **Claude
Code + Cursor get all three**. The store, MCP contract, and prompt text stay identical across
tools; neutrality is spent only in per-vendor adapter files.

### Path A — Explicit instruction phrase

The human types a direct imperative ("record this decision: X because Y" / "remember that …").
Because it is a direct command, model compliance is near-100% — unlike spontaneous noticing.
No new machinery: `write_context` already handles it. Two small supporting changes:

- Tweak the `write_context` tool description in `src/index.ts` so the model treats
  "record/remember this" as a strong, explicit write trigger.
- Document the phrase convention in the README as a supported gesture.

Path A is the only write path available on Claude Desktop and is the universal fallback
everywhere.

### Path B — Slash command `/remember [text]`

A project-scoped slash command, one thin file per vendor, pointing at the neutral
`write_context` tool:

- Claude Code: `.claude/commands/remember.md` (project command).
- Cursor: its equivalent command mechanism.
- Behavior: `/remember <text>` writes exactly that text as a `decision`; bare `/remember`
  instructs the model to write the most-recent settled decision from the conversation.

Command name chosen: `/remember` (over `/record`, `/save`). Onboarding a new tool later =
one command file, core unchanged.

### Path C — Per-turn gated self-review (Stop hook)

**Why Stop, not SessionEnd.** Verified against the current Claude Code hooks docs:

- `SessionEnd` (fires on closing the chat, `/clear`, logout, `prompt_input_exit`) is
  cleanup-only — it cannot block and cannot inject anything back to the model. So "model
  reviews the conversation when you close the window" is mechanically impossible: at
  `SessionEnd` the model is already gone.
- `Stop` fires at the end of **every assistant turn** and *can* inject `additionalContext`
  that re-engages the model.

Therefore self-review must hang off `Stop`, which reframes it from per-session to **per-turn,
gated**. On each `Stop` the hook injects a tight review instruction asking: "was a decision
settled in *this* turn that is not yet saved? If so, write it via `write_context`; otherwise
do nothing." This is better than an end-of-session batch: decisions are captured right when
made, survive a crash or a forgotten-to-close window, and there is no large batch to
junk-filter.

- **Loop guard:** respect `stop_hook_active` so the review injection fires at most once per
  turn and never creates an infinite Stop loop.
- **Gating / junk prevention:** the prompt writes **only settled decisions** ("we decided X
  *because* Y"), never open questions or reasoning steps; **dedups** against context already
  present (injected at `SessionStart` + anything written this session); writes **nothing** if
  nothing qualifies (clean, silent no-op).

## Components

- `src/index.ts` — small `write_context` tool-description tweak (path A trigger wording). Core
  behavior unchanged.
- `.claude/commands/remember.md` + Cursor command file — path B, thin adapters.
- `hooks/stop-review.sh <client>` — `Stop`-hook launcher mirroring `hooks/session-start.sh`
  (sources `.memorylayer-hook.env`, selects client, execs the built hook). Named for the
  `Stop` event it wires, not "session end".
- `src/review-prompt.ts` — **neutral** builder for the self-review instruction text (the
  gating rules live here, once, shared across vendors).
- `src/hook-clients.ts` (extended) — add the per-vendor `Stop` output envelope
  (`hookSpecificOutput` for Claude Code; Cursor's equivalent), alongside the existing
  SessionStart envelopes. Vendor-envelope logic stays in this one file.
- Project hook wiring: `.claude/settings.json` (local, gitignored) Stop hook + `.cursor/hooks.json`
  Stop hook, both invoking the one launcher — same pattern as the read hook.

## Data flow

- **Gesture (A/B):** human → phrase or `/remember` → model calls `write_context` → store
  commits + pushes.
- **Self-review (C):** turn ends → `Stop` hook fires → (unless `stop_hook_active`) injects the
  neutral review instruction → model compares this turn's decisions against already-present
  context → calls `write_context` for each unsaved settled decision → returns; loop guard
  prevents re-fire.

## Error handling — fail-open, loop-guarded

- The Stop hook **fails open** like the read hook: any error (offline, bad config, empty
  store) → allow the turn to end, exit 0, never trap the user. A turn-trapping hook would
  itself cause the "can't rely on this" failure it exists to prevent.
- `stop_hook_active` loop guard: review injection fires at most once per turn.
- `write_context` already returns the honest "recorded locally, NOT shared yet" message on
  push failure (`isError`), unchanged.

## Testing (mirror `test/hook.test.mjs`)

- Unit: `review-prompt.ts` builder output (gating rules present); per-client `Stop` envelope
  selection in `hook-clients.ts`; loop-guard honors `stop_hook_active`; fail-open on missing
  config (empty/no-op output, exit 0).
- Integration: `write_context` round-trip via an explicit-text write produces a committed
  entry (largely covered by existing store tests; add a `/remember`-shaped write assertion).

## Neutrality summary (consistent with the read hook)

- **Neutral:** store, MCP contract, `write_context`, the review-prompt text.
- **Per-vendor:** slash command file + `Stop` envelope case. A decision written from Cursor is
  readable/injected in Claude Code and vice versa. Claude Desktop = path A only, mirroring the
  read-hook Desktop split (pull-based, model's choice).
