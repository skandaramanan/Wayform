# Metrics Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument every context read and write into an append-only per-author `metrics/<author>.jsonl` in the shared context repo, so the 4-week reliance test is measurable.

**Architecture:** A new neutral module `src/metrics.ts` appends one JSON line per read/write to the context repo working tree (no git, fail-open). Three thin call sites (`hook.ts` read, `index.ts` `read_context`, `index.ts` `write_context`) tag each record with `source: 'hook' | 'mcp'`. Reads never touch git; a new `ContextStore.flushMetrics()` — called only after a write, inside the store's existing per-clone git mutex — commits and best-effort-pushes the metrics file, carrying every read since the last write.

**Tech Stack:** TypeScript (ES modules, `node:` builtins), `simple-git` (already a dep), `node:test` for tests.

## Global Constraints

- **Node >= 18** (`engines.node`), ES modules (`"type": "module"`); tests import from the **built** `../dist/*.js` (the `test` script runs `npm run build` first).
- **Zero new runtime dependencies.** Only `node:fs/promises`, `node:path`, and existing modules.
- **Fail-open, unconditionally:** `recordMetric` and `flushMetrics` catch and swallow every error and never rethrow. A metric must never break or slow a read/write.
- **Reads never do git.** Only writes flush. The fail-open, latency-critical read hook stays git-free on the hot path.
- **Neutrality untouched:** nothing is added to `src/hook-clients.ts`. The `source` tag values are `hook`/`mcp`, never a vendor name.
- **Per-author file:** `metrics/<slug(author)>.jsonl` — two writers never touch the same file (no merge conflicts), same pattern as context entries.
- **`total` is reads-only** in the record (entry count); omitted on writes.
- **Out of scope:** no `memorylayer metrics` report command, no `sessionId` capture, no `init` changes, no re-explained automation.
- **All 71 existing tests must stay green** — `store.read`/`store.write` public signatures are unchanged.

---

## File Structure

- **Create `src/metrics.ts`** — the neutral append module. Owns: the record schema, `metricsRelPath(author)`, and `recordMetric(cfg, rec)`. Depends on: `slug` (from `store.ts`), `Config` type. No git, no network.
- **Modify `src/store.ts`** — add `flushMetrics()` public method + `flushMetricsImpl()` private, reusing the existing `serialize` mutex and `GitRepo`. Does NOT import `metrics.ts` (computes the rel path inline from its own `slug`) to avoid a `store ↔ metrics` import cycle.
- **Modify `src/hook.ts`** — one `recordMetric` call after `store.read` (source `hook`).
- **Modify `src/index.ts`** — one `recordMetric` after `read_context`'s read (source `mcp`); one `recordMetric` + `store.flushMetrics()` after `write_context`'s write (source `mcp`).
- **Create `test/metrics.test.mjs`** — unit tests for `recordMetric` (schema, dir auto-create, fail-open, accumulation).
- **Modify `test/integration.test.mjs`** — add `flushMetrics` git round-trip tests (reuse the existing `freshRemote`/`git` helpers) + a `cfgFor` helper.
- **Modify `test/hook.test.mjs`** — add one end-to-end test: a spawned hook against a real seeded store appends a `source:"hook"` metric line.

---

## Task 1: Metrics module (`src/metrics.ts`)

**Files:**
- Create: `src/metrics.ts`
- Test: `test/metrics.test.mjs`

**Interfaces:**
- Consumes: `slug(s: string): string` (exported from `src/store.ts`); `Config` (from `src/config.ts`, fields used: `repoPath`, `author`).
- Produces:
  - `type MetricSource = "hook" | "mcp"`
  - `type MetricEvent = "read" | "write"`
  - `interface MetricRecord { source: MetricSource; event: MetricEvent; project: string; total?: number }`
  - `metricsRelPath(author: string): string` → `"metrics/<slug(author)>.jsonl"`
  - `recordMetric(cfg: Config, rec: MetricRecord): Promise<void>` — appends one JSON line; `total` included only when `event === "read"` and defined; fail-open.

- [ ] **Step 1: Write the failing tests**

Create `test/metrics.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordMetric, metricsRelPath } from "../dist/metrics.js";

function tmpRepo() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ml-metrics-"));
}

function cfgFor(repoPath, author = "Alice Example") {
  return {
    repoUrl: "unused",
    repoPath,
    author,
    authorEmail: "a@x",
    autoPush: true,
  };
}

test("metricsRelPath slugs the author into metrics/<slug>.jsonl", () => {
  assert.equal(metricsRelPath("Alice Example"), path.join("metrics", "alice-example.jsonl"));
});

test("recordMetric appends a well-formed read line and auto-creates metrics/", async () => {
  const repoPath = tmpRepo();
  const cfg = cfgFor(repoPath);
  await recordMetric(cfg, { source: "hook", event: "read", project: "proj", total: 3 });

  const file = path.join(repoPath, metricsRelPath(cfg.author));
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const rec = JSON.parse(lines[0]);
  assert.equal(rec.author, "Alice Example");
  assert.equal(rec.source, "hook");
  assert.equal(rec.event, "read");
  assert.equal(rec.project, "proj");
  assert.equal(rec.total, 3);
  assert.match(rec.ts, /^\d{4}-\d{2}-\d{2}T/);
});

test("write metric omits total even when one is passed", async () => {
  const repoPath = tmpRepo();
  const cfg = cfgFor(repoPath);
  await recordMetric(cfg, { source: "mcp", event: "write", project: "proj", total: 5 });

  const rec = JSON.parse(
    fs.readFileSync(path.join(repoPath, metricsRelPath(cfg.author)), "utf8").trim(),
  );
  assert.equal(rec.event, "write");
  assert.equal("total" in rec, false);
});

test("recordMetric never throws when the repo path is unwritable (fail-open)", async () => {
  const notADir = path.join(tmpRepo(), "not-a-dir");
  fs.writeFileSync(notADir, "x"); // a FILE, so mkdir(metrics/) under it fails
  const cfg = cfgFor(notADir);
  await recordMetric(cfg, { source: "hook", event: "read", project: "p", total: 1 });
  assert.ok(true); // reaching here without a throw is the assertion
});

test("multiple metrics accumulate as separate lines", async () => {
  const repoPath = tmpRepo();
  const cfg = cfgFor(repoPath);
  await recordMetric(cfg, { source: "hook", event: "read", project: "p", total: 1 });
  await recordMetric(cfg, { source: "mcp", event: "write", project: "p" });
  const lines = fs
    .readFileSync(path.join(repoPath, metricsRelPath(cfg.author)), "utf8")
    .trim()
    .split("\n");
  assert.equal(lines.length, 2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test test/metrics.test.mjs`
Expected: FAIL — build errors / `Cannot find module '../dist/metrics.js'` (the module does not exist yet).

- [ ] **Step 3: Write the minimal implementation**

Create `src/metrics.ts`:

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { slug } from "./store.js";
import type { Config } from "./config.js";

/**
 * Metrics instrumentation. Appends one JSON line per context read/write to a
 * per-author append log in the shared context repo, so the 4-week reliance test
 * is measurable. This module is vendor-NEUTRAL: the `source` tag is `hook`/`mcp`,
 * never a client name.
 *
 * FAIL-OPEN is load-bearing: a metric that breaks or slows a read/write would
 * poison the exact signal it exists to measure, so every error is swallowed.
 * This is a pure local append — no git, no network. Reads never flush; the next
 * write commits accumulated lines via ContextStore.flushMetrics().
 */
export type MetricSource = "hook" | "mcp";
export type MetricEvent = "read" | "write";

export interface MetricRecord {
  source: MetricSource;
  event: MetricEvent;
  project: string;
  /** Reads only: entry count returned by store.read. Ignored on writes. */
  total?: number;
}

/** Repo-relative path of an author's append log: `metrics/<slug(author)>.jsonl`. */
export function metricsRelPath(author: string): string {
  return path.join("metrics", `${slug(author)}.jsonl`);
}

export async function recordMetric(cfg: Config, rec: MetricRecord): Promise<void> {
  try {
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        author: cfg.author,
        source: rec.source,
        event: rec.event,
        project: rec.project,
        // total is reads-only to avoid overloading one field with two types.
        ...(rec.event === "read" && rec.total !== undefined
          ? { total: rec.total }
          : {}),
      }) + "\n";
    const abs = path.join(cfg.repoPath, metricsRelPath(cfg.author));
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.appendFile(abs, line, "utf8");
  } catch {
    // Fail-open: never break or slow a read/write. A lost metric is invisible;
    // a throwing metric would poison the signal it measures.
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test test/metrics.test.mjs`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Lint and format**

Run: `npm run lint && npx prettier --check src/metrics.ts test/metrics.test.mjs`
Expected: clean (run `npm run format` if prettier reports diffs, then re-check).

- [ ] **Step 6: Commit**

```bash
git add src/metrics.ts test/metrics.test.mjs
git commit -m "feat(metrics): neutral fail-open recordMetric + per-author append log"
```

---

## Task 2: `ContextStore.flushMetrics()` (git sync on write)

**Files:**
- Modify: `src/store.ts` (add `flushMetrics` public + `flushMetricsImpl` private, after the `read`/`readImpl` block, before the closing `}` of the class at `src/store.ts:173`)
- Test: `test/integration.test.mjs` (add a `cfgFor` helper + two tests)

**Interfaces:**
- Consumes: `recordMetric` + `metricsRelPath` (Task 1); the existing `this.serialize`, `this.repo` (`GitRepo`), `this.cfg`, `slug`, and `existsSync` (already imported at `src/store.ts:2`).
- Produces: `ContextStore.flushMetrics(): Promise<void>` — commits `metrics/<slug(author)>.jsonl` under the author's identity and best-effort pushes; silent no-op if the file does not exist; never throws.

- [ ] **Step 1: Write the failing tests**

In `test/integration.test.mjs`, add the `recordMetric` import at the top (next to the existing `ContextStore` import):

```js
import { recordMetric } from "../dist/metrics.js";
```

Add a `cfgFor` helper next to the existing `makeStore` (so tests can pass one cfg to both `new ContextStore(cfg)` and `recordMetric(cfg, ...)`):

```js
function cfgFor(bare, clonePath, author, autoPush = true) {
  return {
    repoUrl: bare,
    repoPath: clonePath,
    author,
    authorEmail: `${author.toLowerCase()}@memorylayer.local`,
    autoPush,
  };
}
```

Append these two tests:

```js
test("flushMetrics commits and pushes the author's metrics log", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const cfg = cfgFor(bare, path.join(tmp, "a"), "Alice");
    const a = new ContextStore(cfg);
    await a.ensure();

    // Simulate a read and a write having appended metric lines locally.
    await recordMetric(cfg, { source: "hook", event: "read", project: "proj", total: 0 });
    await recordMetric(cfg, { source: "mcp", event: "write", project: "proj" });

    await a.flushMetrics();

    // A fresh clone from the bare remote must now contain the pushed log.
    const verify = path.join(tmp, "verify");
    git(tmp, "clone", bare, verify);
    const metricsFile = path.join(verify, "metrics", "alice.jsonl");
    assert.ok(fs.existsSync(metricsFile), "metrics log reached the remote");
    const lines = fs.readFileSync(metricsFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("flushMetrics is a silent no-op when nothing was recorded", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const cfg = cfgFor(bare, path.join(tmp, "a"), "Alice");
    const a = new ContextStore(cfg);
    await a.ensure();
    await a.flushMetrics(); // no metrics file exists yet
    assert.ok(true); // no throw = pass
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run build && node --test test/integration.test.mjs`
Expected: FAIL — `a.flushMetrics is not a function` (method not implemented yet).

- [ ] **Step 3: Write the minimal implementation**

In `src/store.ts`, insert this block inside the `ContextStore` class, immediately after the `readImpl` method (after `src/store.ts:172`, before the class-closing `}` on line 173):

```ts
  /**
   * Commit and best-effort push the caller's metrics append log (written by
   * recordMetric). Runs inside the same per-clone git mutex as read/write so
   * metrics git never races entry git on .git/index.lock. Called ONLY after a
   * write — it carries every read metric appended since the last write in one
   * commit ("append local, flush on next write"). Best-effort: swallows errors
   * so a failed push never surfaces on the write path; unpushed lines ride the
   * next flush (or a read's selfHealPush). No-op if nothing was recorded.
   */
  flushMetrics(): Promise<void> {
    return this.serialize(() => this.flushMetricsImpl());
  }

  private async flushMetricsImpl(): Promise<void> {
    const relFile = path.join("metrics", `${slug(this.cfg.author)}.jsonl`);
    const absFile = path.join(this.cfg.repoPath, relFile);
    if (!existsSync(absFile)) return; // nothing recorded yet
    try {
      await this.repo.commitFile(
        relFile,
        `metrics: sync ${slug(this.cfg.author)}`,
        this.cfg.author,
        this.cfg.authorEmail,
      );
      await this.repo.push();
    } catch {
      // Best-effort: unpushed metrics ride the next flush / read selfHealPush.
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run build && node --test test/integration.test.mjs`
Expected: PASS — the two new tests pass and the existing integration tests stay green.

- [ ] **Step 5: Lint and format**

Run: `npm run lint && npx prettier --check src/store.ts test/integration.test.mjs`
Expected: clean (run `npm run format` if needed).

- [ ] **Step 6: Commit**

```bash
git add src/store.ts test/integration.test.mjs
git commit -m "feat(metrics): flushMetrics — commit+push the metrics log inside the git mutex"
```

---

## Task 3: Wire the three call sites + hook end-to-end test

**Files:**
- Modify: `src/hook.ts` (add import + one `recordMetric` call around `src/hook.ts:62`)
- Modify: `src/index.ts` (add import + one `recordMetric` in `read_context` around `src/index.ts:33`; one `recordMetric` + `flushMetrics` in `write_context` around `src/index.ts:73`)
- Test: `test/hook.test.mjs` (add one end-to-end metric test)

**Interfaces:**
- Consumes: `recordMetric` (Task 1), `ContextStore.flushMetrics` (Task 2); `cfg` (already in scope in both `runHook` at `src/hook.ts:59` and `runServer` at `src/index.ts:11`).
- Produces: no new exported surface — this task wires existing functions into the read/write entrypoints.

> **Note on coverage boundary:** the `index.ts` MCP handler wiring is thin (two added lines each) and, like the rest of `index.ts`, is verified by inspection — the repo has no MCP-stdio-driving test, and the underlying `recordMetric`/`flushMetrics` behavior is already covered by Tasks 1–2. The `hook.ts` wiring gets a real end-to-end spawn test below because a spawn harness already exists (`test/hook.test.mjs`).

- [ ] **Step 1: Write the failing test**

In `test/hook.test.mjs`, add imports at the top (alongside the existing ones):

```js
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { ContextStore } from "../dist/store.js";
```

(`execFileSync`, `path`, and `fileURLToPath` are already imported; keep a single import per module.)

Append this end-to-end test:

```js
/** Bare "remote" seeded with a main branch and one commit (mirrors integration). */
function freshRemote() {
  const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-hookmetrics-"));
  const bare = path.join(tmp, "remote.git");
  g(tmp, "init", "--bare", "--initial-branch=main", bare);
  const seed = path.join(tmp, "seed");
  g(tmp, "clone", bare, seed);
  fs.writeFileSync(path.join(seed, "README.md"), "shared\n");
  g(seed, "add", ".");
  g(seed, "-c", "user.email=s@x", "-c", "user.name=seed", "commit", "-m", "init");
  g(seed, "push", "origin", "main");
  return { tmp, bare };
}

test("end-to-end: the read hook appends a source:\"hook\" metric line", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const clone = path.join(tmp, "clone");
    const cfg = {
      repoUrl: bare,
      repoPath: clone,
      author: "Alice",
      authorEmail: "alice@memorylayer.local",
      autoPush: true,
    };
    // Seed one entry so the hook injects context (and a read happens).
    const store = new ContextStore(cfg);
    await store.ensure();
    await store.write("memorylayer", {
      author: "Alice",
      type: "decision",
      payload: "Seed decision.",
    });

    // Spawn the built hook with a full valid env pointing at the same clone.
    execFileSync(process.execPath, [hookPath], {
      input: "",
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        MEMORYLAYER_HOOK_CLIENT: "claude-code",
        MEMORYLAYER_AUTHOR: "Alice",
        MEMORYLAYER_PROJECT: "memorylayer",
        CONTEXT_REPO_URL: bare,
        CONTEXT_REPO_PATH: clone,
      },
    });

    const metricsFile = path.join(clone, "metrics", "alice.jsonl");
    assert.ok(fs.existsSync(metricsFile), "hook wrote a metrics line");
    const rec = JSON.parse(fs.readFileSync(metricsFile, "utf8").trim().split("\n").pop());
    assert.equal(rec.source, "hook");
    assert.equal(rec.event, "read");
    assert.equal(rec.project, "memorylayer");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test test/hook.test.mjs`
Expected: FAIL — `metrics/alice.jsonl` does not exist (the hook does not record yet). The existing fail-open tests still pass.

- [ ] **Step 3: Wire `src/hook.ts`**

Add the import after the `context-format` import (`src/hook.ts:22`):

```ts
import { recordMetric } from "./metrics.js";
```

Then, in `runHook`, replace the read line and the empty-store guard (`src/hook.ts:62-66`):

```ts
    const { entries, total } = await store.read(project);

    // An empty store has nothing worth injecting — start clean rather than pushing
    // a "(no entries yet)" placeholder into every session.
    if (total === 0) emitEmpty();
```

with:

```ts
    const { entries, total } = await store.read(project);

    // Record the read before branching so an empty-store read still counts toward
    // read-rate. recordMetric is internally fail-open (never throws), so it cannot
    // divert the non-empty path into the catch/emitEmpty branch.
    await recordMetric(cfg, { source: "hook", event: "read", project, total });

    // An empty store has nothing worth injecting — start clean rather than pushing
    // a "(no entries yet)" placeholder into every session.
    if (total === 0) emitEmpty();
```

- [ ] **Step 4: Wire `src/index.ts`**

Add the import after the `context-format` import (`src/index.ts:7`):

```ts
import { recordMetric } from "./metrics.js";
```

In the `read_context` handler (`src/index.ts:32-39`), add the record after the read:

```ts
    async ({ project }) => {
      const { entries, total } = await store.read(project);
      await recordMetric(cfg, { source: "mcp", event: "read", project, total });
      return {
        content: [
          { type: "text", text: projectContext(project, entries, total) },
        ],
      };
    },
```

In the `write_context` handler (`src/index.ts:72-77`), add the record + flush after the write succeeds:

```ts
      try {
        const entry = await store.write(project, {
          author: author?.trim() || cfg.author,
          type,
          payload,
        });
        await recordMetric(cfg, { source: "mcp", event: "write", project });
        await store.flushMetrics();
```

(Leave the rest of the `try`/`catch` — the `return { ... Recorded ... }` and the `catch` block — unchanged.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run build && node --test test/hook.test.mjs`
Expected: PASS — the end-to-end test passes and all five fail-open tests stay green.

- [ ] **Step 6: Run the FULL suite + lint + format**

Run: `npm test`
Expected: PASS — all tests green (71 existing + the new metrics/flush/hook tests).

Run: `npm run lint && npm run format:check`
Expected: clean (run `npm run format` if prettier reports diffs, then re-check).

- [ ] **Step 7: Commit**

```bash
git add src/hook.ts src/index.ts test/hook.test.mjs
git commit -m "feat(metrics): instrument read/write call sites (hook + MCP) with source tag"
```

---

## Self-Review

**1. Spec coverage:**
- Store choke-point instrumentation with `source` tag → Task 3 (hook + both MCP handlers). ✓
- `recordMetric` fail-open local append, `metrics/<author>.jsonl`, schema (`ts/author/source/event/project/total?`), `total` reads-only → Task 1. ✓
- Append-local / flush-on-write, `flushMetrics` inside the git mutex, best-effort push → Task 2. ✓
- Reads never touch git → verified: `recordMetric` does no git; `hook.ts`/`read_context` never call `flushMetrics`. ✓
- Neutrality (nothing in `hook-clients.ts`), zero new deps, `init` untouched → holds across all tasks. ✓
- Out-of-scope items (report command, sessionId, re-explained automation) → none added. ✓
- Testing: fail-open contract (Task 1 unwritable-path test), flush integration (Task 2), end-to-end hook wiring (Task 3), full suite green (Task 3 Step 6). ✓

**2. Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to" — every code and test step shows complete content. ✓

**3. Type consistency:** `recordMetric(cfg, rec)` / `metricsRelPath(author)` / `MetricRecord{source,event,project,total?}` used identically in Tasks 1–3. `flushMetrics()` defined in Task 2, called in Task 3. `slug`/`existsSync` already exist in `store.ts`. `cfgFor` shape matches the `Config` interface (`repoUrl/repoPath/author/authorEmail/autoPush`). ✓

**Note — context repo hygiene (not a code task):** `metrics/` must not be gitignored in the shared **context** repo (it isn't by default; `flushMetrics` `git add`s the explicit path). No change to this code repo's `.gitignore` is needed — the metrics log lives in `~/.memorylayer/context-store`, not here.
