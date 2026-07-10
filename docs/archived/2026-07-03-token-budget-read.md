# Token-Budget Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for every task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `ContextStore.read()`'s count-based cap (most recent 30
entries) with a token-budget-based cap, so context overhead scales with size
rather than entry count. Phase 1 of `docs/specs/2026-07-03-token-budget-read-design.md`.

**Tech Stack:** TypeScript (ES modules), `node:test`. Zero new runtime dependencies.

## Global Constraints

- **Zero new runtime dependencies.** Token estimate is `Math.ceil(text.length / 4)` — no tokenizer library.
- **`total` is unchanged** — always the true entry count, independent of the budget.
- **Never return zero entries when entries exist** — the single most recent entry is always included even if it alone exceeds the budget.
- **`budgetTokens <= 0` means unlimited** (preserves the old `limit <= 0` escape hatch).
- **Chronological order preserved** in the returned set (oldest of the selected first), matching current behavior.
- **All existing tests must stay green** except the one test that directly encodes the old count-cap semantics (`test/integration.test.mjs`, "read caps to the most recent N" (A3)), which is deliberately rewritten as part of Task 2.

## File Structure

- **Create `src/token-budget.ts`** — `estimateTokens`, `DEFAULT_BUDGET_TOKENS`, `ENTRY_OVERHEAD_TOKENS`. No dependencies.
- **Modify `src/store.ts`** — `read()`/`readImpl()` take `budgetTokens` instead of `limit`; new private `packToBudget` helper.
- **Modify `src/config.ts`** — add `readBudgetTokens` to `Config`, load from `MEMORYLAYER_READ_BUDGET_TOKENS`, add to `HOOK_ENV_ALLOWLIST`.
- **Modify `src/hook.ts`** — pass `cfg.readBudgetTokens` to `store.read`.
- **Modify `src/index.ts`** — add optional `budget_tokens` input to the `read_context` tool schema; pass through to `store.read`.
- **Create `test/token-budget.test.mjs`**.
- **Modify `test/integration.test.mjs`** — replace the count-cap test with a token-budget test.
- **Modify `test/config.test.mjs`** — add `readBudgetTokens` coverage; add the new var to the `MEMORYLAYER_VARS` cleanup list.

---

## Task 1: `src/token-budget.ts`

**Files:** Create `src/token-budget.ts`. Test: `test/token-budget.test.mjs`.

**Interfaces:**
- `estimateTokens(text: string): number`
- `DEFAULT_BUDGET_TOKENS = 4000`
- `ENTRY_OVERHEAD_TOKENS = 12`

- [ ] **Step 1: Write the failing tests**

Create `test/token-budget.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  DEFAULT_BUDGET_TOKENS,
  ENTRY_OVERHEAD_TOKENS,
} from "../dist/token-budget.js";

test("estimateTokens approximates chars/4, rounded up", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("ab"), 1); // 2/4 -> ceil -> 1
  assert.equal(estimateTokens("abcd"), 1); // 4/4 -> 1
  assert.equal(estimateTokens("abcde"), 2); // 5/4 -> ceil -> 2
  assert.equal(estimateTokens("a".repeat(400)), 100);
});

test("DEFAULT_BUDGET_TOKENS and ENTRY_OVERHEAD_TOKENS are positive constants", () => {
  assert.equal(DEFAULT_BUDGET_TOKENS, 4000);
  assert.equal(ENTRY_OVERHEAD_TOKENS, 12);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test test/token-budget.test.mjs`
Expected: FAIL — `Cannot find module '../dist/token-budget.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/token-budget.ts`:

```ts
/**
 * Cheap token estimate (chars/4) so the read path can budget context size
 * without a tokenizer dependency. Approximate by design: this is a soft
 * budget, not an exact accounting — over-estimating trims one entry short,
 * under-estimating is the failure mode that actually matters, so the ratio
 * errs conservative (4 chars/token is the standard rough English average).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Default token budget for a read when the caller doesn't specify one. */
export const DEFAULT_BUDGET_TOKENS = 4000;

/** Approx fixed overhead per rendered entry block (header line + separator). */
export const ENTRY_OVERHEAD_TOKENS = 12;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test test/token-budget.test.mjs`
Expected: PASS.

- [ ] **Step 5: Lint and format**

Run: `npm run lint && npx prettier --check src/token-budget.ts test/token-budget.test.mjs`

- [ ] **Step 6: Commit**

```bash
git add src/token-budget.ts test/token-budget.test.mjs
git commit -m "feat(read-budget): estimateTokens + budget constants"
```

---

## Task 2: `ContextStore.read()` — budget-based packing

**Files:** Modify `src/store.ts`. Test: `test/integration.test.mjs`.

**Interfaces:**
- `read(project: string, budgetTokens?: number): Promise<{ entries: ParsedEntry[]; total: number }>` — `budgetTokens` defaults to `DEFAULT_BUDGET_TOKENS`; `<= 0` means unlimited.
- Private `packToBudget(entries: ParsedEntry[], budgetTokens: number): ParsedEntry[]`.

- [ ] **Step 1: Write the failing test**

In `test/integration.test.mjs`, replace the existing test named
`"read caps to the most recent N and reports the true total (A3)"` with:

```js
test("read packs entries into a token budget, keeping the most recent (A3)", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const s = makeStore(bare, path.join(tmp, "d"), "Alice", false);
    await s.ensure();
    // Each payload is ~400 chars -> ~100 tokens + 12 overhead = ~112 tokens/entry.
    const big = "x".repeat(400);
    for (let i = 0; i < 10; i++) {
      await s.write("proj", { author: "Alice", type: "context", payload: `${big}-${i}` });
    }
    // Budget for ~3 entries (112 * 3 = 336, leave headroom short of 4 entries).
    const { entries, total } = await s.read("proj", 340);
    assert.equal(total, 10, "total counts every entry regardless of budget");
    assert.ok(entries.length < 10, "budget excludes older entries");
    assert.ok(entries.length >= 1, "at least one entry always returned");
    assert.match(entries[entries.length - 1].payload, /-9$/, "most recent entry kept");
    assert.match(entries[0].payload, /-9$|-8$|-7$/, "kept entries are the most recent, in order");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("read keeps the single most recent entry even if it alone exceeds the budget", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const s = makeStore(bare, path.join(tmp, "d2"), "Alice", false);
    await s.ensure();
    await s.write("proj", { author: "Alice", type: "context", payload: "x".repeat(4000) });
    const { entries, total } = await s.read("proj", 10); // budget far too small
    assert.equal(total, 1);
    assert.equal(entries.length, 1, "never returns zero entries when data exists");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("budgetTokens <= 0 means unlimited (back-compat escape hatch)", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const s = makeStore(bare, path.join(tmp, "d3"), "Alice", false);
    await s.ensure();
    for (let i = 0; i < 5; i++) {
      await s.write("proj", { author: "Alice", type: "context", payload: `entry ${i}` });
    }
    const { entries } = await s.read("proj", 0);
    assert.equal(entries.length, 5);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

Also update the pre-existing `"entries come back in write (timestamp) order"`
test — no change needed, it calls `s.read("proj")` with the default budget,
which comfortably fits 3 short entries.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test test/integration.test.mjs`
Expected: FAIL — the new tests fail against the old count-based `read`
(e.g. a 340-token budget is silently ignored, capping still happens at
count 30, so all 10 entries come back instead of ~3).

- [ ] **Step 3: Write the minimal implementation**

In `src/store.ts`, add the import:

```ts
import {
  estimateTokens,
  DEFAULT_BUDGET_TOKENS,
  ENTRY_OVERHEAD_TOKENS,
} from "./token-budget.js";
```

Remove `const DEFAULT_READ_LIMIT = 30;` (line 19).

Change the public method:

```ts
  read(
    project: string,
    budgetTokens = DEFAULT_BUDGET_TOKENS,
  ): Promise<{ entries: ParsedEntry[]; total: number }> {
    return this.serialize(() => this.readImpl(project, budgetTokens));
  }
```

Change `readImpl`'s signature (`limit: number` -> `budgetTokens: number`) and
its tail (replace the old count-slice with a call to the new helper):

```ts
  private async readImpl(
    project: string,
    budgetTokens: number,
  ): Promise<{ entries: ParsedEntry[]; total: number }> {
    await this.repo.pull();
    await this.repo.selfHealPush();

    const absDir = path.join(this.cfg.repoPath, this.projectDir(project));
    if (!existsSync(absDir)) return { entries: [], total: 0 };

    const files = await collectMarkdown(absDir);
    const entries: ParsedEntry[] = [];
    for (const abs of files) {
      const raw = await fs.readFile(abs, "utf8");
      const parsed = parseEntry(raw, path.relative(this.cfg.repoPath, abs));
      if (parsed) entries.push(parsed);
    }

    entries.sort((a, b) =>
      a.timestamp === b.timestamp
        ? a.file.localeCompare(b.file)
        : a.timestamp.localeCompare(b.timestamp),
    );

    return { entries: packToBudget(entries, budgetTokens), total: entries.length };
  }
```

Add the helper (module-level function, alongside `firstLine`/`collectMarkdown`):

```ts
/**
 * Select the most recent entries that fit `budgetTokens`, walking newest to
 * oldest. Always keeps at least the single most recent entry — an oversized
 * entry beats an empty read. `budgetTokens <= 0` means unlimited (returns
 * every entry), preserving the old count-cap's `limit <= 0` escape hatch.
 */
function packToBudget(
  entries: ParsedEntry[],
  budgetTokens: number,
): ParsedEntry[] {
  if (budgetTokens <= 0 || entries.length === 0) return entries;

  const selected: ParsedEntry[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = estimateTokens(entries[i].payload) + ENTRY_OVERHEAD_TOKENS;
    if (selected.length > 0 && used + cost > budgetTokens) break;
    selected.push(entries[i]);
    used += cost;
  }
  return selected.reverse();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test test/integration.test.mjs`
Expected: PASS — all integration tests green, including the 3 new/rewritten ones.

- [ ] **Step 5: Lint and format**

Run: `npm run lint && npx prettier --check src/store.ts test/integration.test.mjs`

- [ ] **Step 6: Commit**

```bash
git add src/store.ts test/integration.test.mjs
git commit -m "feat(read-budget): replace count cap with token-budget packing in ContextStore.read"
```

---

## Task 3: Config + call sites (`config.ts`, `hook.ts`, `index.ts`)

**Files:** Modify `src/config.ts`, `src/hook.ts`, `src/index.ts`. Test: `test/config.test.mjs`.

**Interfaces:**
- `Config.readBudgetTokens: number`
- Env var `MEMORYLAYER_READ_BUDGET_TOKENS` (optional; default `DEFAULT_BUDGET_TOKENS`; non-numeric or `<= 0` falls back to the default, since a broken/typo'd env value should degrade to "use the default," not throw or silently disable budgeting in a way `packToBudget` would misinterpret as intentional-unlimited).
- `read_context` MCP tool: new optional `budget_tokens` positive-integer input.

- [ ] **Step 1: Write the failing tests**

In `test/config.test.mjs`, add `"MEMORYLAYER_READ_BUDGET_TOKENS"` to the
`MEMORYLAYER_VARS` array (so `withEnv` cleans it up like every other key).

Append:

```js
test("readBudgetTokens defaults to DEFAULT_BUDGET_TOKENS", () => {
  withEnv({ MEMORYLAYER_AUTHOR: "S", CONTEXT_REPO_URL: "u" }, () => {
    assert.equal(loadConfig().readBudgetTokens, 4000);
  });
});

test("readBudgetTokens honors MEMORYLAYER_READ_BUDGET_TOKENS", () => {
  withEnv(
    {
      MEMORYLAYER_AUTHOR: "S",
      CONTEXT_REPO_URL: "u",
      MEMORYLAYER_READ_BUDGET_TOKENS: "800",
    },
    () => {
      assert.equal(loadConfig().readBudgetTokens, 800);
    },
  );
});

test("readBudgetTokens falls back to the default on a non-numeric or non-positive value", () => {
  withEnv(
    {
      MEMORYLAYER_AUTHOR: "S",
      CONTEXT_REPO_URL: "u",
      MEMORYLAYER_READ_BUDGET_TOKENS: "not-a-number",
    },
    () => {
      assert.equal(loadConfig().readBudgetTokens, 4000);
    },
  );
  withEnv(
    {
      MEMORYLAYER_AUTHOR: "S",
      CONTEXT_REPO_URL: "u",
      MEMORYLAYER_READ_BUDGET_TOKENS: "-5",
    },
    () => {
      assert.equal(loadConfig().readBudgetTokens, 4000);
    },
  );
});
```

Also add a case to the existing
`"loadHookEnv ignores keys outside the allowlist"` test's companion —
no change needed there (it only asserts dangerous keys are excluded); instead
add one line to the allowlist-positive test
`"loadHookEnv loads KEY=VALUE lines..."` is not required either. Just add a
new dedicated test:

```js
test("loadHookEnv allowlists MEMORYLAYER_READ_BUDGET_TOKENS", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-env-"));
  fs.writeFileSync(
    path.join(dir, ".memorylayer-hook.env"),
    "MEMORYLAYER_READ_BUDGET_TOKENS=1200\n",
  );
  const saved = { ...process.env };
  delete process.env.MEMORYLAYER_READ_BUDGET_TOKENS;
  try {
    loadHookEnv(dir);
    assert.equal(process.env.MEMORYLAYER_READ_BUDGET_TOKENS, "1200");
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test test/config.test.mjs`
Expected: FAIL — `readBudgetTokens` is `undefined`; the allowlist test fails
because the key isn't recognized.

- [ ] **Step 3: Write the minimal implementation**

In `src/config.ts`, add the import:

```ts
import { DEFAULT_BUDGET_TOKENS } from "./token-budget.js";
```

Add to the `Config` interface (after `autoPush`):

```ts
  /** Token budget for read_context / the session hook (see token-budget.ts). */
  readBudgetTokens: number;
```

Add `"MEMORYLAYER_READ_BUDGET_TOKENS"` to `HOOK_ENV_ALLOWLIST`.

In `loadConfig()`, add before the `return`:

```ts
  const rawBudget = Number(process.env.MEMORYLAYER_READ_BUDGET_TOKENS);
  const readBudgetTokens =
    Number.isFinite(rawBudget) && rawBudget > 0 ? rawBudget : DEFAULT_BUDGET_TOKENS;
```

and add `readBudgetTokens,` to the returned object.

In `src/hook.ts`, change:

```ts
    const { entries, total } = await store.read(project);
```

to:

```ts
    const { entries, total } = await store.read(project, cfg.readBudgetTokens);
```

In `src/index.ts`, add `budget_tokens` to the `read_context` tool's
`inputSchema`:

```ts
        budget_tokens: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Override the default read token budget for this call (larger = more history, smaller = tighter context).",
          ),
```

and change the handler:

```ts
    async ({ project, budget_tokens }) => {
      const { entries, total } = await store.read(
        project,
        budget_tokens ?? cfg.readBudgetTokens,
      );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test test/config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Run the FULL suite + lint + format**

Run: `npm test`
Expected: PASS — every test green (existing suite + all new tests from Tasks 1-3).

Run: `npm run lint && npm run format:check`
Expected: clean (run `npm run format` if prettier reports diffs, then re-check).

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/hook.ts src/index.ts test/config.test.mjs
git commit -m "feat(read-budget): wire budget_tokens through config, hook, and read_context"
```

---

## Self-Review

**1. Spec coverage:**
- Token-budget cap replaces count cap, most-recent-first packing, single-entry floor → Task 2. ✓
- `budgetTokens <= 0` unlimited escape hatch → Task 2. ✓
- Zero new dependencies (chars/4 estimate) → Task 1. ✓
- Config default + env override + hook-env allowlist → Task 3. ✓
- `read_context` per-call override → Task 3. ✓
- `total` always the true count → Task 2 (`packToBudget` never touches `total`). ✓
- Out-of-scope Phase 2 items (embeddings, graph, classification, compaction) → none added. ✓

**2. Placeholder scan:** No TBD/TODO — every step shows complete code. ✓

**3. Type consistency:** `read(project, budgetTokens?)` used identically across `store.ts`, `hook.ts`, `index.ts`, and all test files. `Config.readBudgetTokens: number` matches its one producer (`loadConfig`) and two consumers (`hook.ts`, `index.ts`). ✓
