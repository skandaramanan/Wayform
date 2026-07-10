# MemoryLayer Codex + Cursor Hook Parity — Design

Date: 2026-07-02
Status: Shipped — merged in PR #2 (codex-cursor-hook-parity). This doc is now a historical design record; behavior of record lives in the code + tests. Live-verification TODOs (§ "Live-verification TODOs") remain open.
Phase: 0 (extends the read hook + write-trigger Path C to two more clients)

## Problem

The read hook (`SessionStart`) and the write-trigger self-review (`Stop`, Path C) are proven
on Claude Code. Coverage on the other two target clients from the SoT (Cursor, Codex) is
incomplete:

- **Codex** — no integration at all (no read, no write hooks).
- **Cursor** — read works (`sessionStart` → `additional_context`), but the write self-review
  `Stop` path is a deliberate no-op: when Path C shipped, Cursor's Stop-hook re-engagement
  contract was unverified, so it fell back to write paths A + B only.

Both gaps weaken the same load-bearing bet (SoT §7): reliable, unprompted read + write across
vendors. A collaborator on Codex or Cursor should get the same guaranteed-read /
nudged-write loop a Claude Code user gets.

## Goal

Full read + write-trigger hook parity across **Claude Code + Codex + Cursor**, with neutrality
still spent only in `src/hook-clients.ts` and the per-vendor config files — the architecture's
existing promise (SoT §7; read-hook decision 2026-07-02T02:28).

Non-goals (scope creep is the documented #1 failure mode): no change to the neutral core
(store, MCP contract, projected context, review-prompt text); no new write path (A/B/C
unchanged); no Cursor-bug fixes that are Cursor's to make; no session-state machinery unless
live testing proves it necessary.

## Research findings (verified against official docs, 2026-07-02)

Recorded in the shared store; summarized here as the design's factual basis.

**Codex CLI** ([developers.openai.com/codex/hooks](https://developers.openai.com/codex/hooks))
has a full Claude-Code-style hooks system.
- `SessionStart` context injection is **byte-identical to Claude Code**:
  `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}`.
- `Stop` re-engages via a **different** shape: `{"decision":"block","reason":"…"}`, where
  `reason` becomes a new user prompt.
- Configured via repo-local `.codex/hooks.json` (mirrors `.cursor/hooks.json`). Caveat:
  [openai/codex#17532](https://github.com/openai/codex/issues/17532) reported repo-local
  `config.toml` hooks not firing interactively; `hooks.json` sidesteps it — verify live.
- Whether Codex sets a stop-continuation flag (`stop_hook_active`) is **undocumented**.

**Cursor 1.7+** ([cursor.com/docs/hooks](https://cursor.com/docs/hooks.md)) — the SoT's open
question ("does Cursor expose a Stop-style hook that can re-engage the model?") is **resolved:
yes**.
- `stop` hook re-engages via `{"followup_message":"…"}` (auto-submitted as the next user
  message), with **built-in loop protection** (`loop_count` on stdin, `loop_limit` in config,
  default 5).
- `sessionStart` injection field is `additional_context` (matches the current Cursor read
  envelope). A community bug report claimed sessionStart injection was not landing — verify
  live; it is Cursor's bug to fix, not ours.

## Approach

Reuse the neutral-core + per-vendor-adapter pattern verbatim. Three concrete changes.

### 1. Envelope adapter — `src/hook-clients.ts`

Add `"codex"` to the `HookClient` union and a `case` to `resolveClient` that maps `"codex"`
(case-insensitive) to the `codex` client; the default fallback stays `cursor`. Envelope matrix
after this change:

| Client | Read (`renderContext`, SessionStart) | Stop review (`renderStopReview`) | Stop no-op (`renderStopNoop`) |
|---|---|---|---|
| `claude-code` | `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":text}}` *(unchanged)* | `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":text}}` *(unchanged)* | `"{}"` |
| `cursor` | `{"additional_context":text}` *(unchanged)* | **NEW** `{"followup_message":text}` | `"{}"` |
| `codex` | **NEW** `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":text}}` | **NEW** `{"decision":"block","reason":text}` | `"{}"` |

**Decision (a): Codex read envelope is a distinct `case`, not shared with `claude-code`.**
Although identical today, a separate `case` keeps a future divergence in either tool a
one-line change and matches the file's existing "one case per tool" doctrine. The small
duplication is deliberate.

`renderEmpty` for `codex` returns `"{}"` (same as claude-code/cursor).

### 2. Loop guard — `src/stop-hook.ts`

Today the guard is Claude-Code-specific: `payload.stop_hook_active === true → no-op`.
Generalize to a client-agnostic continuation check:

```
isContinuation(payload) =
  payload.stop_hook_active === true
  || (typeof payload.loop_count === "number" && payload.loop_count > 0)
```

- **Claude Code** → `stop_hook_active` (existing behavior preserved exactly).
- **Cursor** → `loop_count` (Cursor increments it); `loop_limit` in config is a hard backstop.
- **Codex** → assumed `stop_hook_active` (Codex mirrors Claude Code's hook design).

**Decision (b): ship on the assumed Codex `stop_hook_active` flag, flagged for live
verification, rather than blocking.** The assumption is very likely correct; worst case is
bounded (a few redundant "nothing to save" turns, not a runaway loop, because the review
prompt dedups and no-ops on content). Blocking would strand the Codex write path the way
Cursor's was stranded. **Tests must lock in the guard behavior** (see §4). Named fallback if
live testing shows Codex loops: a `session_id`-keyed marker file that no-ops the second fire
within a session — **specified but NOT built** now (stays off the scope-creep path).

Fail-open and the existing unparseable-payload → no-op behavior are unchanged.

### 3. Config files (committed, project-scoped)

- **New `.codex/hooks.json`** — `SessionStart` (matcher `startup|resume`, so it skips
  `compact`/`clear` re-injection) + `Stop`, each invoking the existing launchers with a
  `codex` arg:
  - `bash ./hooks/session-start.sh codex`
  - `bash ./hooks/stop-review.sh codex`
- **`.cursor/hooks.json`** — add a `stop` entry → `bash ./hooks/stop-review.sh cursor`, with
  `loop_limit` set (e.g. 3) as the backstop.
- **Launchers unchanged.** `hooks/session-start.sh` and `hooks/stop-review.sh` already take the
  client as `$1`; no edits needed.

## Testing

Unit-level, matching the existing `test/hook.test.mjs` / `test/stop-hook.test.mjs` pattern
(spawn the built hook with a representative stdin payload; assert the exact stdout envelope).
End-to-end firing inside real Codex/Cursor is **not verifiable in this environment** (neither
CLI is installed) and is left as explicit live-verification TODOs.

New / extended tests:
1. **`hook-clients` envelopes** — codex read = claude-code-identical string; codex Stop =
   `{"decision":"block","reason":…}`; cursor Stop = `{"followup_message":…}`; codex/cursor
   Stop no-op = `"{}"`.
2. **`resolveClient`** — `"codex"` → `codex`; unknown still → `cursor`.
3. **Stop loop guard (locks in decision b)** — spawn `dist/stop-hook.js` with
   `MEMORYLAYER_HOOK_CLIENT=codex`:
   - fresh turn (`{}`) → emits `{"decision":"block", …}` naming `write_context`;
   - `{"stop_hook_active":true}` → `"{}"` no-op;
   - `{"loop_count":1}` → `"{}"` no-op (client-agnostic guard, also covers cursor).
4. **`hook.js` read** with `MEMORYLAYER_HOOK_CLIENT=codex` → SessionStart envelope; fail-open
   (missing config) → `"{}"`.

Green bar required: build, lint, prettier, full test suite.

## Live-verification TODOs (documented, not blockers)

1. Codex Stop actually provides `stop_hook_active` (else the marker-file fallback).
2. Codex `.codex/hooks.json` fires interactively (openai/codex#17532 was `config.toml`-only).
3. Cursor `sessionStart` `additional_context` injection lands (community bug report).

## Neutrality check

Store, MCP contract, projected context, and the neutral review-prompt text are all untouched.
Everything vendor-specific stays in `src/hook-clients.ts` + `.codex/hooks.json` +
`.cursor/hooks.json`. Adding Codex costs one enum value, ~3 envelope cases, and one config
file — exactly the "one case per tool" cost the architecture promises. Consistent with the
read-hook and write-trigger neutrality decisions.

## Docs

README §4: add Codex to the client matrix; update the split to Claude Code = read+write,
**Codex = read+write**, **Cursor = read+write** (was read + A/B only), Desktop = MCP pull only.
Note the three live-verification TODOs so a collaborator on those clients knows the status.
