# Write Trigger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give MemoryLayer a reliable, vendor-neutral write path so deliberate decisions reach the shared store without depending on the model spontaneously deciding to call `write_context`.

**Architecture:** Three write paths funnel into the existing `write_context` MCP tool (its core is unchanged): (A) an explicit instruction phrase, (B) a `/remember` slash command, and (C) a per-turn gated self-review injected by a `Stop` hook. Reuses the proven read-hook pattern: a vendor-neutral core (`src/`) plus a thin per-vendor envelope in `src/hook-clients.ts`; neutrality is spent only in that adapter file and in per-client wiring files.

**Tech Stack:** TypeScript (ESM, `tsc` build to `dist/`), Node's built-in `node:test`, bash launcher scripts, Claude Code / Cursor project hooks.

## Global Constraints

- Node `>=18` (package.json `engines`).
- **Zero new runtime dependencies.** Dev-only deps are already present (eslint, prettier, typescript). Do not add RAG/graph/DB/vector anything — scope creep is the documented #1 failure mode.
- **Neutrality rule:** the store, MCP contract, and any injected text stay vendor-neutral. The ONLY per-vendor code lives in `src/hook-clients.ts` (envelopes) and per-client wiring files. Onboarding a new tool = one `case` + one wiring file.
- **Fail-open is load-bearing:** any hook, on any error, emits the client's no-op and exits 0. A hook that blocks/traps a turn would itself cause the "can't rely on this" failure the feature exists to prevent.
- **Path C scope:** Claude Code + `raw` only. Cursor's `Stop`-hook re-engagement semantics are unverified; Cursor gets paths A + B now and a no-op for C until confirmed.
- Default project name is `memorylayer` (matches `src/hook.ts`).
- `.claude/` is gitignored: `.claude/settings.json` and `.claude/commands/*` are per-clone local files, documented in the README (same as the existing read hook). The launcher (`hooks/`) and neutral core (`src/`) are committed. `.cursor/hooks.json` is committed.
- Test command `npm test` runs `tsc` build first, then `node --test test/*.test.mjs`. Lint: `npm run lint` (eslint src). Prettier excludes markdown.

---

### Task 1: Path A — strengthen the explicit-phrase write trigger

Path A needs almost no machinery: `write_context` already works. This task makes an explicit human phrase ("record/remember this") a strong, obvious trigger by (1) sharpening the tool description and (2) documenting the convention.

**Files:**
- Modify: `src/index.ts:44-46` (the `write_context` tool `description`)
- Modify: `README.md` (the "write model" section, ~line 170)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing consumed by later tasks (documentation/description only).

- [ ] **Step 1: Sharpen the `write_context` description**

In `src/index.ts`, replace the `description` string on the `write_context` tool (currently at lines 45–46):

```ts
      description:
        "Append a DELIBERATE decision or established context to the shared project space and commit it, so collaborators' sessions see it. Write decisions ('we decided X because Y') and durable context — NOT a firehose of every reasoning step. When the user says 'record this', 'remember this', 'save this decision' (or runs the /remember command), treat it as an EXPLICIT instruction to call this tool right away.",
```

- [ ] **Step 2: Document the phrase convention in the README**

In `README.md`, under `## The write model (anti-junk-drawer)`, append after the existing paragraph:

```markdown

**Three ways a write happens (softest first):**

1. **Explicit phrase (any client, incl. Desktop).** Tell the agent directly: "record this
   decision: X because Y." Because it's a direct command, the model complies near-reliably —
   unlike it *spontaneously* noticing. This is the universal fallback and the only write path
   on Claude Desktop.
2. **`/remember` slash command (Claude Code / Cursor).** A one-word gesture — see setup below.
3. **End-of-turn self-review (Claude Code).** A `Stop` hook asks the model, at the end of each
   turn, to record any decision just settled — see setup below.
```

- [ ] **Step 3: Build and verify it compiles + server boots**

Run: `npm run build && node -e "require('node:child_process')" && MEMORYLAYER_AUTHOR=x CONTEXT_REPO_URL=x MEMORYLAYER_AUTO_PUSH=false node dist/index.js & sleep 1; kill %1 2>/dev/null`
Expected: build succeeds; server prints a `memorylayer MCP server ready` line to stderr (it may error trying to clone `x` — that is fine; we only need the build to compile). If you prefer a pure compile check: `npm run build && npm run lint`.
Simpler acceptance: `npm run build` exits 0 and `npm run lint` exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts README.md
git commit -m "feat: make explicit phrase a strong write_context trigger (Path A)"
```

---

### Task 2: Path C core — neutral self-review instruction builder

The vendor-neutral text the `Stop` hook will inject. Isolated in its own file so the wording lives in exactly one place and can never drift between clients.

**Files:**
- Create: `src/review-prompt.ts`
- Test: `test/review-prompt.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `reviewInstruction(project: string): string` — the neutral self-review text, consumed by `src/stop-hook.ts` (Task 4).

- [ ] **Step 1: Write the failing test**

Create `test/review-prompt.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewInstruction } from "../dist/review-prompt.js";

test("interpolates the project name", () => {
  const out = reviewInstruction("business-one");
  assert.match(out, /business-one/);
});

test("names the write_context tool to call", () => {
  assert.match(reviewInstruction("memorylayer"), /write_context/);
});

test("states the 'because' requirement for a settled decision", () => {
  assert.match(reviewInstruction("memorylayer"), /because/i);
});

test("tells the model to do nothing when nothing qualifies (anti-junk-drawer)", () => {
  const out = reviewInstruction("memorylayer");
  assert.match(out, /nothing/i);
  assert.match(out, /curated|firehose/i);
});

test("instructs deduplication against already-recorded context", () => {
  assert.match(reviewInstruction("memorylayer"), /duplicat|already/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep review-prompt`
Expected: FAIL — `Cannot find module '../dist/review-prompt.js'` (the source file does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/review-prompt.ts`:

```ts
/**
 * Neutral builder for the end-of-turn self-review instruction (write-trigger Path C).
 *
 * This text is vendor-NEUTRAL and lives in exactly one place: only the Stop-hook
 * envelope that carries it is per-vendor (see ./hook-clients.ts). The instruction is
 * the reliable, hook-forced counterpart to the model spontaneously choosing to call
 * write_context (the ~60-85% path that decays over long chats).
 */
export function reviewInstruction(project: string): string {
  return (
    `MemoryLayer end-of-turn review for project "${project}". ` +
    `Before finishing: did THIS turn settle a deliberate decision, or establish ` +
    `durable context, that is not already recorded in the shared store? A settled ` +
    `decision is "we decided X because Y" — not an open question, an option still ` +
    `under discussion, or an intermediate reasoning step. ` +
    `If yes, call the write_context tool now (project: "${project}", ` +
    `type: "decision" for a settled call or "context" for durable background) with ` +
    `a compact statement that includes the "because". ` +
    `Deduplicate against what is already recorded in this session — do NOT rewrite ` +
    `anything already stored. ` +
    `If nothing qualifies, do nothing and finish normally. ` +
    `Keep the store curated, not a firehose.`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -E "review-prompt|pass|fail"`
Expected: the 5 review-prompt tests PASS; overall suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/review-prompt.ts test/review-prompt.test.mjs
git commit -m "feat: neutral self-review instruction builder (Path C core)"
```

---

### Task 3: Path C core — Stop-hook envelopes in the per-vendor adapter

Add the `Stop` event envelopes alongside the existing `SessionStart` ones, keeping ALL vendor-specific output in `hook-clients.ts`.

**Files:**
- Modify: `src/hook-clients.ts` (add two functions after `renderEmpty`)
- Test: `test/hook-clients.test.mjs` (append cases)

**Interfaces:**
- Consumes: `HookClient` type and `renderEmpty` shape convention from the existing file.
- Produces:
  - `renderStopReview(client: HookClient, text: string): string` — envelope that asks the model to self-review.
  - `renderStopNoop(client: HookClient): string` — envelope that lets the turn end untouched.
  Both consumed by `src/stop-hook.ts` (Task 4).

- [ ] **Step 1: Write the failing test**

Append to `test/hook-clients.test.mjs`:

```js
import {
  renderStopReview,
  renderStopNoop,
} from "../dist/hook-clients.js";

test("claude-code Stop review nests additionalContext under the Stop event", () => {
  const out = JSON.parse(renderStopReview("claude-code", "review please"));
  assert.equal(out.hookSpecificOutput.hookEventName, "Stop");
  assert.equal(out.hookSpecificOutput.additionalContext, "review please");
});

test("raw Stop review is the text verbatim", () => {
  assert.equal(renderStopReview("raw", "review please"), "review please");
});

test("cursor Stop review is a no-op (self-review deferred until Cursor Stop verified)", () => {
  assert.equal(renderStopReview("cursor", "review please"), "{}");
});

test("Stop no-op is valid per client: {} for JSON clients, empty for raw", () => {
  assert.equal(renderStopNoop("claude-code"), "{}");
  assert.equal(renderStopNoop("cursor"), "{}");
  assert.equal(renderStopNoop("raw"), "");
  assert.deepEqual(JSON.parse(renderStopNoop("claude-code")), {});
});
```

(Add the new import to the existing import block at the top rather than a second statement if you prefer; a separate `import` line is also valid ESM.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -E "Stop|hook-clients"`
Expected: FAIL — `renderStopReview is not a function` / export missing.

- [ ] **Step 3: Write the implementation**

In `src/hook-clients.ts`, append after `renderEmpty`:

```ts
/**
 * Stop-hook envelope that ASKS the model to self-review (write-trigger Path C).
 *
 * Unlike SessionStart, the Stop event can re-engage the model: Claude Code accepts
 * `hookSpecificOutput.additionalContext` on Stop as non-error feedback that continues
 * the conversation. `raw` emits the text verbatim.
 *
 * Cursor: its Stop-hook re-engagement contract is not yet verified, so Cursor gets the
 * no-op here — self-review is Claude-Code-only for now; Cursor still has the explicit
 * phrase and /remember write paths. Onboarding Cursor later = fill in this one case.
 */
export function renderStopReview(client: HookClient, text: string): string {
  switch (client) {
    case "raw":
      return text;
    case "claude-code":
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: text,
        },
      });
    case "cursor":
      return renderStopNoop(client);
  }
}

/**
 * Stop-hook no-op: let the turn end with no injected review. Used on the loop-guard
 * path (stop_hook_active) and the fail-open path.
 */
export function renderStopNoop(client: HookClient): string {
  return client === "raw" ? "" : "{}";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -E "Stop|pass|fail"`
Expected: new Stop tests PASS; suite green; `npm run lint` clean.

- [ ] **Step 5: Commit**

```bash
git add src/hook-clients.ts test/hook-clients.test.mjs
git commit -m "feat: Stop-hook envelopes in per-vendor adapter (Path C core)"
```

---

### Task 4: Path C core — the Stop-hook entrypoint (loop guard + fail-open)

The executable the launcher runs each turn. Reads the `Stop` event payload, honors the loop guard, and either injects the review or emits a no-op. Mirrors `src/hook.ts`.

**Files:**
- Create: `src/stop-hook.ts`
- Test: `test/stop-hook.test.mjs`

**Interfaces:**
- Consumes: `reviewInstruction` (Task 2); `resolveClient`, `renderStopReview`, `renderStopNoop`, `HookClient` (Task 3).
- Produces: a built `dist/stop-hook.js` invoked by `hooks/stop-review.sh` (Task 5). No exported symbols.

- [ ] **Step 1: Write the failing test**

Create `test/stop-hook.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("../dist/stop-hook.js", import.meta.url));

/** Run the built Stop hook with a controlled client + stdin payload; capture stdout. */
function runStopHook(client, stdin) {
  return execFileSync(process.execPath, [hookPath], {
    input: stdin,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", MEMORYLAYER_HOOK_CLIENT: client },
  });
}

test("claude-code: fresh turn injects a Stop self-review naming write_context", () => {
  const out = JSON.parse(runStopHook("claude-code", "{}"));
  assert.equal(out.hookSpecificOutput.hookEventName, "Stop");
  assert.match(out.hookSpecificOutput.additionalContext, /write_context/);
});

test("loop guard: stop_hook_active=true emits the no-op (no infinite loop)", () => {
  const out = runStopHook("claude-code", JSON.stringify({ stop_hook_active: true }));
  assert.equal(out.trim(), "{}");
});

test("fail-open: unparseable stdin emits the no-op and exits 0", () => {
  // execFileSync throws on non-zero exit; a returned value already proves exit 0.
  assert.equal(runStopHook("claude-code", "not json").trim(), "{}");
});

test("raw client on a fresh turn emits the review text verbatim (no JSON)", () => {
  const out = runStopHook("raw", "{}");
  assert.match(out, /MemoryLayer end-of-turn review/);
  assert.doesNotMatch(out, /hookSpecificOutput/);
});

test("raw client with loop guard emits nothing", () => {
  assert.equal(runStopHook("raw", JSON.stringify({ stop_hook_active: true })), "");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep stop-hook`
Expected: FAIL — `Cannot find module '../dist/stop-hook.js'`.

- [ ] **Step 3: Write the implementation**

Create `src/stop-hook.ts`:

```ts
#!/usr/bin/env node
/**
 * Stop-hook entrypoint — the write-side counterpart to hook.ts (write-trigger Path C).
 *
 * A client runs this at the END OF EVERY TURN (Claude Code `Stop`). It injects a
 * self-review instruction so the model records a decision it just settled, without the
 * human having to remember to. Per-turn (not session-end) because SessionEnd is
 * cleanup-only and cannot re-engage the model; only Stop can.
 *
 * LOOP GUARD is load-bearing: when the model is already continuing because of THIS hook,
 * the client sets stop_hook_active=true on the payload. We MUST emit a no-op then, or we
 * create an infinite Stop loop.
 *
 * FAIL-OPEN: on any error (unparseable payload, unknown state) emit the client no-op and
 * exit 0. A hook that traps a turn would itself cause the "can't rely on this" failure
 * this feature exists to prevent.
 */
import { reviewInstruction } from "./review-prompt.js";
import {
  resolveClient,
  renderStopReview,
  renderStopNoop,
  type HookClient,
} from "./hook-clients.js";

const client: HookClient = resolveClient(process.env.MEMORYLAYER_HOOK_CLIENT);

function emitNoop(): never {
  process.stdout.write(renderStopNoop(client));
  process.exit(0);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let data = "";
  try {
    for await (const chunk of process.stdin) data += chunk;
  } catch {
    // stdin not readable — treat as empty payload.
  }
  return data;
}

async function main(): Promise<void> {
  const raw = await readStdin();

  // Loop guard: if we cannot confirm we are NOT already in a hook-driven
  // continuation, the safe choice is to let the turn end (never risk a loop).
  let payload: { stop_hook_active?: boolean };
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    emitNoop();
  }
  if (payload.stop_hook_active === true) emitNoop();

  const project = process.env.MEMORYLAYER_PROJECT?.trim() || "memorylayer";
  process.stdout.write(renderStopReview(client, reviewInstruction(project)));
  process.exit(0);
}

main().catch(() => emitNoop());
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test 2>&1 | grep -E "stop-hook|pass|fail"`
Expected: the 5 stop-hook tests PASS; full suite green; `npm run lint` clean.

- [ ] **Step 5: Commit**

```bash
git add src/stop-hook.ts test/stop-hook.test.mjs
git commit -m "feat: Stop-hook entrypoint with loop guard + fail-open (Path C)"
```

---

### Task 5: Path C wiring — launcher script, Claude Code hook, README

Wire the built `dist/stop-hook.js` to fire on each turn in this project, and document it. Mirrors the read hook's `hooks/session-start.sh` + `.claude/settings.json` pattern.

**Files:**
- Create: `hooks/stop-review.sh` (committed)
- Modify: `.claude/settings.json` (local per-clone; add a `Stop` hook)
- Modify: `README.md` (add a Stop self-review subsection after the read-hook section, ~line 158)

**Interfaces:**
- Consumes: `dist/stop-hook.js` (Task 4).
- Produces: a live `Stop` hook in this project; nothing consumed by later tasks.

- [ ] **Step 1: Create the launcher script**

Create `hooks/stop-review.sh`:

```bash
#!/bin/bash
# MemoryLayer Stop-hook launcher — neutral.
#
# Usage: stop-review.sh <client>     # client: cursor | claude-code | raw
#
# Invoked ONLY by this repo's project-scoped Stop hook, so end-of-turn self-review
# fires only when working in THIS project. Wires the client's Stop event (end of every
# assistant turn), NOT SessionEnd (which is cleanup-only and cannot re-engage the model).
#
# Fail-open + loop-guard are guaranteed downstream in dist/stop-hook.js.
export PATH="/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$REPO_ROOT/.memorylayer-hook.env" ]; then
  set -a
  . "$REPO_ROOT/.memorylayer-hook.env"
  set +a
fi

export MEMORYLAYER_HOOK_CLIENT="${1:-claude-code}"
exec node "$REPO_ROOT/dist/stop-hook.js"
```

- [ ] **Step 2: Make it executable and add the local Claude Code Stop hook**

Run: `chmod +x hooks/stop-review.sh`

Edit `.claude/settings.json` to add a `Stop` hook alongside the existing `SessionStart` one (this file is gitignored — local only):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/hooks/session-start.sh\" claude-code" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/hooks/stop-review.sh\" claude-code" }
        ]
      }
    ]
  }
}
```

- [ ] **Step 3: Manually verify the launcher fires and self-guards**

Run (fresh turn → review injected):
`echo '{}' | bash hooks/stop-review.sh claude-code`
Expected: JSON containing `"hookEventName":"Stop"` and an `additionalContext` mentioning `write_context`.

Run (loop guard → no-op):
`echo '{"stop_hook_active":true}' | bash hooks/stop-review.sh claude-code`
Expected: `{}`

(Requires `npm run build` to have produced `dist/stop-hook.js` — Task 4 ensures this.)

- [ ] **Step 4: Document it in the README**

In `README.md`, after the read-hook Claude Code block (before `### Claude Desktop is different`), add:

```markdown
### End-of-turn self-review (write side, Claude Code)

The read hook guarantees reads; the **Stop hook** does the symmetric job for writes. At the
end of every turn it asks the model: "did we just settle a decision that isn't recorded? If
so, call `write_context`; if not, do nothing." This removes the reliance on the model
*spontaneously* noticing — the weak half of the loop.

Why per-turn and not on session close: Claude Code's `SessionEnd` is cleanup-only (it cannot
re-engage the model), so review must hang off `Stop`, which fires each turn. A `stop_hook_active`
loop guard means it fires at most once per turn, and it is **fail-open** (any error → allow the
turn to end).

It shares the neutral pattern: `dist/stop-hook.js` is the core, the per-vendor envelope is one
`case` in `hook-clients.ts`. Currently wired for **Claude Code**; Cursor keeps the explicit-phrase
and `/remember` write paths until its `Stop`-hook contract is verified.

Wire it locally (this repo's `.gitignore` excludes `.claude/`, so add it per clone) by adding a
`Stop` entry to `.claude/settings.json`:

```json
"Stop": [
  {
    "hooks": [
      { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/hooks/stop-review.sh\" claude-code" }
    ]
  }
]
```
```

- [ ] **Step 5: Commit** (the committed launcher + README; `.claude/settings.json` stays local/uncommitted)

```bash
git add hooks/stop-review.sh README.md
git commit -m "feat: Stop-hook launcher + docs for end-of-turn self-review (Path C wiring)"
```

---

### Task 6: Path B — the `/remember` slash command

A one-word gesture that maps to `write_context`. A local per-clone command file (like `.claude/settings.json`), documented in the README with its full contents so any collaborator can recreate it.

**Files:**
- Create: `.claude/commands/remember.md` (local per-clone; gitignored)
- Modify: `README.md` (add a `/remember` subsection in Setup)

**Interfaces:**
- Consumes: the `write_context` MCP tool (unchanged).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Create the command file**

Create `.claude/commands/remember.md`:

```markdown
---
description: Record a settled decision to the shared MemoryLayer store
---

Record a decision to the shared MemoryLayer planning store for this project.

If text was provided after the command, use it as the decision. Otherwise, use the
most recently settled decision from our conversation.

Call the `write_context` tool now with:
- project: "memorylayer"
- type: "decision" (or "context" for durable background)
- payload: a compact statement of the decision that includes the "because" — the
  reasoning that settles it.

Record only settled decisions — never open questions or options still under discussion.
Keep it compact; the store is curated, not a firehose.

$ARGUMENTS
```

- [ ] **Step 2: Manually verify the command is recognized**

In a Claude Code session opened in this project, type `/remember` and confirm it appears in the
command list and, when run with text (e.g. `/remember we chose git as the substrate because it
gives log+attribution+merge for free`), the agent calls `write_context`.
Expected: a `Recorded decision in 'memorylayer' ...` tool result.

(This is a manual check — slash-command recognition is a client behavior, not unit-testable here.)

- [ ] **Step 3: Document `/remember` in the README**

In `README.md`, after the `### End-of-turn self-review` subsection, add:

```markdown
### The `/remember` command (Claude Code / Cursor)

A low-friction muscle-memory write. `.claude/` is gitignored, so create the command per clone
at `.claude/commands/remember.md` with:

    ---
    description: Record a settled decision to the shared MemoryLayer store
    ---

    Record a decision to the shared MemoryLayer planning store for this project.
    If text was provided after the command, use it as the decision. Otherwise, use the
    most recently settled decision from our conversation. Call `write_context` with
    project "memorylayer", type "decision" (or "context"), and a compact payload that
    includes the "because". Only settled decisions — keep the store curated.

    $ARGUMENTS

Then `/remember we decided X because Y` records it; bare `/remember` records the last settled
decision. Cursor has an equivalent command mechanism pointing at the same `write_context` tool.
```

- [ ] **Step 4: Commit** (README only; the command file is local/uncommitted)

```bash
git add README.md
git commit -m "docs: /remember slash command for MemoryLayer writes (Path B)"
```

---

### Task 7: Full-suite verification

**Files:** none (verification only).

**Interfaces:** consumes everything above.

- [ ] **Step 1: Run the whole suite + lint + format check**

Run: `npm test && npm run lint && npm run format:check`
Expected: all tests pass (existing 30 + 5 review-prompt + 4 hook-clients Stop + 5 stop-hook = 44), lint clean, prettier clean (markdown excluded).

- [ ] **Step 2: Sanity-check the neutral core still boots**

Run: `MEMORYLAYER_HOOK_CLIENT=claude-code echo '{}' | node dist/stop-hook.js`
Expected: a `Stop` review envelope naming `write_context`.

- [ ] **Step 3: Final commit if anything was touched** (e.g. lint autofix)

```bash
git add -A
git commit -m "chore: write-trigger suite green (44 tests, lint + prettier clean)" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- Path A (explicit phrase) → Task 1. ✓
- Path B (`/remember`) → Task 6. ✓
- Path C (per-turn gated Stop self-review): neutral prompt → Task 2; per-vendor envelope → Task 3; entrypoint w/ loop guard + fail-open → Task 4; launcher + wiring + docs → Task 5. ✓
- Neutral core + per-vendor adapter split → Tasks 2/3/4 (core) vs. 3 (envelope). ✓
- Fail-open + loop guard → Task 4 (tested). ✓
- Claude Desktop = Path A only → documented in Task 1 README + existing Desktop section. ✓
- Cursor Path C deferred → Global Constraints + Task 3 `cursor` no-op + Task 5/6 notes. ✓
- Testing (mirror hook.test.mjs) → Tasks 2/3/4 add unit + spawn tests. ✓
- `write_context` core unchanged → only its description string changes (Task 1). ✓

**Type consistency:** `reviewInstruction(project)`, `renderStopReview(client, text)`, `renderStopNoop(client)`, `resolveClient`, `HookClient` used identically across Tasks 2–4. `stop_hook_active` payload field consistent Task 4 impl ↔ test. `MEMORYLAYER_HOOK_CLIENT` / `MEMORYLAYER_PROJECT` env names match `src/hook.ts`.

**Placeholder scan:** No TBD/TODO; every code step shows full code; every command has expected output.
