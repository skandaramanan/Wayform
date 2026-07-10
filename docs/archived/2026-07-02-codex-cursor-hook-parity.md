# Codex + Cursor Hook Parity Implementation Plan

> **STATUS: SHIPPED** — merged in PR #2 (codex-cursor-hook-parity). All tasks below are complete; the checkboxes are kept as a historical record of the build. Three live-verification TODOs against real Codex/Cursor installs remain open (see the design spec + README).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring read (SessionStart) and write-trigger self-review (Stop, Path C) hook support to Codex and complete it for Cursor, so all three clients (Claude Code, Codex, Cursor) have the same guaranteed-read / nudged-write loop.

**Architecture:** Reuse the existing neutral-core + per-vendor-adapter pattern. All vendor-specific behavior stays in `src/hook-clients.ts` (envelopes) plus per-vendor config files (`.codex/hooks.json`, `.cursor/hooks.json`). The neutral store, MCP contract, projected context, and review-prompt text are untouched. The one piece of new logic is a client-agnostic loop guard in `src/stop-hook.ts`.

**Tech Stack:** TypeScript (compiled with `tsc` to `dist/`), Node built-in test runner (`node --test`), ESLint + Prettier. No new runtime dependencies.

## Global Constraints

- Zero new runtime dependencies (dev-only tooling already present).
- Neutrality spent ONLY in `src/hook-clients.ts` + `.codex/hooks.json` + `.cursor/hooks.json`. Do not touch `store.ts`, `git-repo.ts`, `frontmatter.ts`, `context-format.ts`, `config.ts`, `review-prompt.ts`, `index.ts`, or the launcher scripts (`hooks/session-start.sh`, `hooks/stop-review.sh`).
- Codex read envelope is a DISTINCT `case`, not shared with `claude-code` (approved decision a).
- Codex loop guard ships on the ASSUMED `stop_hook_active` flag (approved decision b); the `session_id` marker-file fallback is specified in the spec but NOT built.
- Full green bar required after each task: `npm test` (builds first), `npm run lint`, `npm run format:check`.
- Commit after every task.
- Tests assert EXACT envelope strings/shapes (match the existing style in `test/hook-clients.test.mjs` and `test/stop-hook.test.mjs`).

Spec: `docs/specs/2026-07-02-codex-cursor-hook-parity-design.md`

---

### Task 1: Codex + Cursor envelopes in the adapter

**Files:**
- Modify: `src/hook-clients.ts`
- Test: `test/hook-clients.test.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `HookClient` union now includes `"codex"`. `resolveClient("codex") → "codex"`. `renderContext("codex", text)` → Claude-Code-shaped SessionStart envelope. `renderStopReview("codex", text)` → `{"decision":"block","reason":text}`. `renderStopReview("cursor", text)` → `{"followup_message":text}`. `renderEmpty("codex")`/`renderStopNoop("codex")` → `"{}"`.

- [x] **Step 1: Write the failing tests**

In `test/hook-clients.test.mjs`, update the `resolveClient` recognition test and REPLACE the existing cursor-Stop-no-op test, then add the new codex tests. Apply these edits:

Replace the test at lines 18–23 (`resolveClient recognizes claude-code aliases and raw`) with:

```javascript
test("resolveClient recognizes claude-code aliases, raw, and codex, case-insensitively", () => {
  assert.equal(resolveClient("claude-code"), "claude-code");
  assert.equal(resolveClient("claude_code"), "claude-code");
  assert.equal(resolveClient("ClaudeCode"), "claude-code");
  assert.equal(resolveClient(" RAW "), "raw");
  assert.equal(resolveClient("codex"), "codex");
  assert.equal(resolveClient(" CODEX "), "codex");
});
```

Replace the test at lines 59–61 (`cursor Stop review is a no-op …`) with:

```javascript
test("cursor Stop review re-engages via followup_message", () => {
  const out = JSON.parse(renderStopReview("cursor", "review please"));
  assert.deepEqual(Object.keys(out), ["followup_message"]);
  assert.equal(out.followup_message, "review please");
});
```

Add these new tests at the end of the file:

```javascript
test("codex read envelope matches the claude-code SessionStart shape", () => {
  const out = JSON.parse(renderContext("codex", "hello"));
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(out.hookSpecificOutput.additionalContext, "hello");
});

test("codex Stop review re-engages via decision:block with reason", () => {
  const out = JSON.parse(renderStopReview("codex", "review please"));
  assert.equal(out.decision, "block");
  assert.equal(out.reason, "review please");
});

test("codex empty and Stop no-ops are valid {} JSON", () => {
  assert.equal(renderEmpty("codex"), "{}");
  assert.equal(renderStopNoop("codex"), "{}");
  assert.deepEqual(JSON.parse(renderStopNoop("codex")), {});
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/hook-clients.test.mjs`
Expected: FAIL — build error (`"codex"` not assignable to `HookClient`) or assertion failures on the codex/cursor cases.

- [x] **Step 3: Implement the adapter changes**

In `src/hook-clients.ts`:

Change the union type:

```typescript
export type HookClient = "cursor" | "claude-code" | "raw" | "codex";
```

Add a `codex` case to `resolveClient`, before the `default`:

```typescript
    case "codex":
      return "codex";
```

Add a `codex` case to `renderContext` (distinct from claude-code by decision a):

```typescript
    case "codex":
      // Codex SessionStart injection is byte-identical to Claude Code today, but
      // kept a separate case so a future divergence in either tool is a one-line
      // change (see spec decision a).
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: text,
        },
      });
```

In `renderStopReview`, replace the `cursor` case body and add a `codex` case:

```typescript
    case "codex":
      // Codex Stop re-engages differently from Claude Code: decision:block makes
      // `reason` the next user prompt.
      return JSON.stringify({ decision: "block", reason: text });
    case "cursor":
      // Cursor Stop re-engages via followup_message (auto-submitted as next user
      // message); loop protection is loop_count/loop_limit (see stop-hook + config).
      return JSON.stringify({ followup_message: text });
```

`renderEmpty` and `renderStopNoop` need NO change — their `client === "raw" ? "" : "{}"` ternary already returns `"{}"` for `codex`. Update the block comment on `renderStopReview` (lines 59–62 area) to note Cursor is now supported and Codex uses decision:block.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/hook-clients.test.mjs`
Expected: PASS (all hook-clients tests green).

- [x] **Step 5: Lint + format check**

Run: `npm run lint && npm run format:check`
Expected: clean.

- [x] **Step 6: Commit**

```bash
git add src/hook-clients.ts test/hook-clients.test.mjs
git commit -m "feat: codex + cursor Stop envelopes in per-vendor adapter

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Client-agnostic loop guard in the Stop hook

**Files:**
- Modify: `src/stop-hook.ts:49-55`
- Test: `test/stop-hook.test.mjs`

**Interfaces:**
- Consumes: `renderStopReview`/`renderStopNoop` from Task 1 (now codex-aware).
- Produces: the Stop hook treats `stop_hook_active === true` OR `loop_count > 0` as a continuation and emits the client no-op; otherwise it injects the review. Behavior for `claude-code` is unchanged.

- [x] **Step 1: Write the failing tests**

Add these tests to the end of `test/stop-hook.test.mjs`:

```javascript
test("codex: fresh turn injects a decision:block Stop review naming write_context", () => {
  const out = JSON.parse(runStopHook("codex", "{}"));
  assert.equal(out.decision, "block");
  assert.match(out.reason, /write_context/);
});

test("loop guard: loop_count > 0 emits the no-op (Cursor-style continuation)", () => {
  assert.equal(runStopHook("cursor", JSON.stringify({ loop_count: 1 })).trim(), "{}");
});

test("codex loop guard: stop_hook_active=true emits the no-op", () => {
  assert.equal(
    runStopHook("codex", JSON.stringify({ stop_hook_active: true })).trim(),
    "{}",
  );
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/stop-hook.test.mjs`
Expected: FAIL — the `loop_count` guard test fails (current code only checks `stop_hook_active`, so it injects a review instead of a no-op). The codex fresh-turn test passes only after Task 1 build; the `loop_count` test is the true failing case.

- [x] **Step 3: Implement the generalized guard**

In `src/stop-hook.ts`, change the payload type and guard (currently lines 49–55):

```typescript
  // Loop guard: if we cannot confirm we are NOT already in a hook-driven
  // continuation, the safe choice is to let the turn end (never risk a loop).
  // Client-agnostic: Claude Code / Codex set stop_hook_active; Cursor increments
  // loop_count (and enforces loop_limit in config as a hard backstop).
  let payload: { stop_hook_active?: boolean; loop_count?: number };
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    emitNoop();
  }
  const isContinuation =
    payload.stop_hook_active === true ||
    (typeof payload.loop_count === "number" && payload.loop_count > 0);
  if (isContinuation) emitNoop();
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/stop-hook.test.mjs`
Expected: PASS (all stop-hook tests green, including the existing claude-code and raw cases).

- [x] **Step 5: Lint + format check**

Run: `npm run lint && npm run format:check`
Expected: clean.

- [x] **Step 6: Commit**

```bash
git add src/stop-hook.ts test/stop-hook.test.mjs
git commit -m "feat: client-agnostic Stop loop guard (stop_hook_active || loop_count)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Wire Codex + Cursor config, read fail-open test, and docs

**Files:**
- Create: `.codex/hooks.json`
- Modify: `.cursor/hooks.json`
- Modify: `README.md` (section 4 client matrix)
- Test: `test/hook.test.mjs`

**Interfaces:**
- Consumes: the built `dist/hook.js` / `dist/stop-hook.js` and the existing launchers `hooks/session-start.sh <client>` / `hooks/stop-review.sh <client>`.
- Produces: Codex fires both hooks via `.codex/hooks.json`; Cursor now fires the Stop hook via `.cursor/hooks.json`.

- [x] **Step 1: Write the test**

`test/hook.test.mjs` already defines a `runHook(client)` helper (spawns `dist/hook.js` with `MEMORYLAYER_HOOK_CLIENT=client` and no config, so `loadConfig` throws and the hook must fail-open). Reuse it — add this test at the end of the file, alongside the existing `fail-open:` tests:

```javascript
test("fail-open: codex client emits the {} no-op and exits 0", () => {
  assert.equal(runHook("codex").trim(), "{}");
});
```

No new imports or helpers are needed.

- [x] **Step 2: Run test to verify it passes after build**

Run: `npm run build && node --test test/hook.test.mjs`
Expected: PASS — codex resolves and fail-opens to `{}`. (Guard/confirmation test; passes once Task 1's `codex` case is built. If Task 1 is not yet built into `dist/`, run `npm run build` first — the `codex` case must exist for `runHook("codex")` to resolve rather than default to cursor, though both emit `{}` here.)

- [x] **Step 3: Create `.codex/hooks.json`**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "bash ./hooks/session-start.sh codex"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash ./hooks/stop-review.sh codex"
          }
        ]
      }
    ]
  }
}
```

- [x] **Step 4: Add the Cursor Stop hook to `.cursor/hooks.json`**

Replace the file contents with (adds the `stop` entry with a `loop_limit` backstop; keeps the existing `sessionStart`):

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      {
        "command": "bash ./hooks/session-start.sh cursor"
      }
    ],
    "stop": [
      {
        "command": "bash ./hooks/stop-review.sh cursor",
        "loop_limit": 3
      }
    ]
  }
}
```

- [x] **Step 5: Verify both config files are valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('.codex/hooks.json','utf8')); JSON.parse(require('fs').readFileSync('.cursor/hooks.json','utf8')); console.log('valid')"`
Expected: prints `valid`.

- [x] **Step 6: Update README section 4 (client matrix)**

Two concrete edits in `README.md` section 4.

(a) **Read-envelope table** — after the `claude-code` row (currently line 108), add a `codex` row:

```markdown
| `codex` | `{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "…" } }` | Codex `SessionStart` |
```

(b) **Write self-review section** ("End-of-turn self-review (write side …)", currently ~line 160). Its last paragraph reads: *"Currently wired for **Claude Code**; Cursor keeps the explicit-phrase and `/remember` write paths until its `Stop`-hook contract is verified."* Replace that sentence with:

```markdown
Wired for **Claude Code** (`.claude/settings.json`), **Codex** (`.codex/hooks.json`, Stop
re-engages via `{"decision":"block","reason":…}`), and **Cursor** (`.cursor/hooks.json`, Stop
re-engages via `{"followup_message":…}` with a `loop_limit` backstop). The client-agnostic loop
guard treats `stop_hook_active` (Claude Code / Codex) or `loop_count > 0` (Cursor) as a
continuation and no-ops. **Claude Desktop** stays MCP-pull-only — no hooks.

**Live-verification TODOs** (not yet exercised against real Codex/Cursor installs): (1) Codex
`Stop` actually provides `stop_hook_active`; (2) `.codex/hooks.json` fires in interactive
sessions (cf. openai/codex#17532, which was `config.toml`-only); (3) Cursor `sessionStart`
`additional_context` injection lands.
```

Also update the header sentence of that section if it says the self-review is Claude-Code-only.

- [x] **Step 7: Full green bar**

Run: `npm test && npm run lint && npm run format:check`
Expected: all tests pass, lint clean, prettier clean. (If prettier flags the new JSON, run `npm run format` and re-check.)

- [x] **Step 8: Commit**

```bash
git add .codex/hooks.json .cursor/hooks.json README.md test/hook.test.mjs
git commit -m "feat: wire Codex + Cursor hook config, README matrix, codex read test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Notes for the implementer

- **Read `test/hook.test.mjs` before Task 3 Step 1** — reuse its existing spawn helper/imports rather than duplicating them; the plan's import block is a fallback for anything missing.
- **`.claude/settings.json` is intentionally not changed** — it already wires SessionStart + Stop for `claude-code` and is gitignored/local.
- **Do not commit `.memorylayer-hook.env`** — identity/config stays out of git (existing gitignore).
- These changes cannot be verified end-to-end here (neither Codex nor Cursor CLI is installed); the three live-verification TODOs are the honest boundary of "done" and are documented in the README and spec.
