# MemoryLayer `init` Installer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `memorylayer init` — a one-command installer that wires MemoryLayer's read + write hooks and MCP server into a collaborator's own project repo, so they join the shared planning store with no clone and no hand-wiring.

**Architecture:** Collapse the three separate entrypoints (`index.ts`, `hook.ts`, `stop-hook.ts`) behind one `memorylayer` command (`src/cli.ts`) that routes subcommands. Move `.memorylayer-hook.env` loading into `config.ts` so the command is self-contained (retiring the bash launchers). `init` writes per-vendor hook configs + MCP registration using pure, testable merge functions that never clobber existing entries.

**Tech Stack:** TypeScript (ESM, `tsc` → `dist/`), Node built-in `node:test`, Node `readline` for prompts. No new runtime dependencies.

## Global Constraints

- Node `>=18` (package.json `engines`).
- **Zero new runtime dependencies.** Dev-only deps already present (eslint, prettier, typescript). No TOML parser, no dotenv, no CLI framework — hand-roll the minimal parsing needed.
- **Neutrality rule:** the store, MCP contract, and injected text stay vendor-neutral. Per-vendor code stays in `src/hook-clients.ts` and the config artifacts `init` writes. `init` writes those artifacts mechanically; it does not add a new place neutrality is spent.
- **Client scope:** the three hook-capable clients only — `claude-code`, `cursor`, `codex`. No Claude Desktop.
- **Distribution:** private GitHub install (`npm install -g github:skandaramanan/MemoryLayer`). No `npm publish`. Hooks call the fast local `memorylayer` command, never `npx` per invocation.
- **Codex MCP:** hooks are auto-written (project-committed); MCP registration is a **printed manual step** for `~/.codex/config.toml` (avoids a TOML dependency / global-file mutation). Claude Code (`.mcp.json`) and Cursor (`.cursor/mcp.json`) MCP registration is auto-written.
- **Error posture:** `init` is LOUD, not fail-open (the inverse of the hooks). Unparseable existing config → back up `.bak` + warn, never destroy. Re-run is idempotent. The runtime hooks keep their existing fail-open + loop-guard contracts unchanged.
- **Secret-free committed configs:** every committed artifact invokes `memorylayer`, which self-loads `.memorylayer-hook.env` from CWD. The only per-user secret file is `.memorylayer-hook.env` (gitignored).
- Green bar after every task: `npm test` (builds first), `npm run lint`, `npm run format:check`.
- Commit after every task.

## File Structure

- `src/cli.ts` (new) — the `memorylayer` bin. Parses `argv[2]` and dispatches: `init` / `hook <client>` / `stop-review <client>` / (default) MCP server. Thin routing only.
- `src/is-main.ts` (new) — `isMain(importMetaUrl)` helper so `index.ts`/`hook.ts`/`stop-hook.ts` self-run when spawned directly (keeps existing direct-spawn tests green) but stay importable by `cli.ts` without double-running.
- `src/index.ts` (modified) — wrap server startup in exported `runServer()`; self-run guarded by `isMain`.
- `src/hook.ts` (modified) — wrap read-hook logic in exported `runHook()`; resolve client inside the function (not at module top); self-run guarded.
- `src/stop-hook.ts` (modified) — wrap in exported `runStopHook()`; resolve client inside; self-run guarded.
- `src/config.ts` (modified) — self-load `.memorylayer-hook.env` from CWD before reading env.
- `src/init.ts` (new) — installer orchestration: detect repo, write configs, prompt + write env, update gitignore, print next steps.
- `src/init-configs.ts` (new) — pure builders/mergers for the three hook configs + Claude/Cursor MCP JSON. No I/O.
- `src/init-env.ts` (new) — `.memorylayer-hook.env` content builder, `git config` default lookup, gitignore updater.
- `package.json` (modified) — `bin` → `dist/cli.js`; add `prepare: tsc`.
- Delete `hooks/session-start.sh`, `hooks/stop-review.sh`.
- `.claude/settings.json`, `.cursor/hooks.json`, `.codex/hooks.json` (modified) — this repo's own hooks call `node ./dist/cli.js …` for local dev.
- `README.md` (modified) — replace the setup section with the install + `init` flow.

---

### Task 1: Subcommand-routing CLI + entrypoint refactor

Collapse the three entrypoints behind one dispatching `memorylayer` command. Refactor each entrypoint so its logic is an exported function, self-running only when spawned directly (so existing direct-spawn tests stay green) and importable by `cli.ts` without double-running.

**Files:**
- Create: `src/is-main.ts`
- Create: `src/cli.ts`
- Modify: `src/index.ts`, `src/hook.ts`, `src/stop-hook.ts`
- Modify: `package.json` (bin)
- Test: `test/cli.test.mjs` (new)

**Interfaces:**
- Consumes: `loadConfig` (config.ts), `ContextStore` (store.ts), `projectContext` (context-format.ts), `resolveClient`/`renderContext`/`renderEmpty`/`renderStopReview`/`renderStopNoop` (hook-clients.ts), `reviewInstruction` (review-prompt.ts) — all existing, unchanged signatures.
- Produces: `isMain(importMetaUrl: string): boolean` (is-main.ts); `runServer(): Promise<void>` (index.ts); `runHook(): Promise<void>` (hook.ts); `runStopHook(): Promise<void>` (stop-hook.ts). `cli.ts` is the bin entry; consumes all three `run*` functions.

- [ ] **Step 1: Write the failing test**

Create `test/cli.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/** Run the built CLI with args + no config, so the routed hook fail-opens. */
function run(args, client) {
  return execFileSync(process.execPath, [cli, ...args], {
    input: "",
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", MEMORYLAYER_HOOK_CLIENT: client ?? "" },
  });
}

test("`hook <client>` routes to the read hook (fail-open {})", () => {
  assert.equal(run(["hook", "cursor"]).trim(), "{}");
});

test("`stop-review <client>` routes to the Stop hook (fail-open {})", () => {
  assert.equal(run(["stop-review", "cursor"]).trim(), "{}");
});

test("hook subcommand arg sets the client (raw emits nothing)", () => {
  assert.equal(run(["hook", "raw"]), "");
});

test("`init --help` routes to init and exits 0", () => {
  // init with --help prints usage and exits 0 without touching the cwd.
  const out = execFileSync(process.execPath, [cli, "init", "--help"], {
    input: "",
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.match(out, /memorylayer init/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test test/cli.test.mjs`
Expected: FAIL — `Cannot find module '../dist/cli.js'`.

- [ ] **Step 3: Create the `isMain` helper**

Create `src/is-main.ts`:

```ts
import { pathToFileURL } from "node:url";

/**
 * True when the module identified by `importMetaUrl` is the process entry point
 * (i.e. it was spawned directly: `node dist/hook.js`), false when it was merely
 * imported (e.g. by cli.ts). Lets an entrypoint keep a direct-spawn self-run for
 * existing tests while being safely importable by the dispatcher.
 */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return importMetaUrl === pathToFileURL(entry).href;
}
```

- [ ] **Step 4: Refactor `index.ts` to export `runServer` + guarded self-run**

In `src/index.ts`, rename `main` to `runServer`, export it, and replace the bottom `main().catch(...)` with a guarded self-run. Add the import:

```ts
import { isMain } from "./is-main.js";
```

Change the function signature line from `async function main() {` to:

```ts
export async function runServer(): Promise<void> {
```

Replace the final block:

```ts
main().catch((err) => {
  console.error("memorylayer failed to start:", err);
  process.exit(1);
});
```

with:

```ts
if (isMain(import.meta.url)) {
  runServer().catch((err) => {
    console.error("memorylayer failed to start:", err);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Refactor `hook.ts` to export `runHook` + resolve client inside**

In `src/hook.ts`: remove the module-top `const client = resolveClient(...)` line and add `import { isMain } from "./is-main.js";`. Move client resolution inside the run function so `cli.ts` can set `MEMORYLAYER_HOOK_CLIENT` before calling. Replace the body from the `const client` line down to the final `main().catch(...)` with:

```ts
export async function runHook(): Promise<void> {
  const client: HookClient = resolveClient(process.env.MEMORYLAYER_HOOK_CLIENT);

  const emitEmpty = (): never => {
    process.stdout.write(renderEmpty(client));
    process.exit(0);
  };

  const drainStdin = async (): Promise<void> => {
    if (process.stdin.isTTY) return;
    try {
      for await (const _ of process.stdin) {
        // discard
      }
    } catch {
      // stdin not readable — irrelevant to producing context.
    }
  };

  try {
    await drainStdin();
    const project = process.env.MEMORYLAYER_PROJECT?.trim() || "memorylayer";
    const cfg = loadConfig();
    const store = new ContextStore(cfg);
    await store.ensure();
    const { entries, total } = await store.read(project);
    if (total === 0) emitEmpty();

    const body = projectContext(project, entries, total);
    const text =
      `The following is shared planning memory (MemoryLayer) for project ` +
      `"${project}", loaded automatically at session start. Treat these recorded ` +
      `decisions and context as already-known; do not ask the user to re-explain ` +
      `them.\n\n${body}`;
    process.stdout.write(renderContext(client, text));
    process.exit(0);
  } catch {
    emitEmpty();
  }
}

if (isMain(import.meta.url)) {
  void runHook();
}
```

- [ ] **Step 6: Refactor `stop-hook.ts` to export `runStopHook` + resolve client inside**

In `src/stop-hook.ts`: remove the module-top `const client = ...` line, add `import { isMain } from "./is-main.js";`, and replace from that line down to the final `main().catch(...)` with:

```ts
export async function runStopHook(): Promise<void> {
  const client: HookClient = resolveClient(process.env.MEMORYLAYER_HOOK_CLIENT);

  const emitNoop = (): never => {
    process.stdout.write(renderStopNoop(client));
    process.exit(0);
  };

  const readStdin = async (): Promise<string> => {
    if (process.stdin.isTTY) return "";
    let data = "";
    try {
      for await (const chunk of process.stdin) data += chunk;
    } catch {
      // stdin not readable — treat as empty payload.
    }
    return data;
  };

  const raw = await readStdin();
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

  const project = process.env.MEMORYLAYER_PROJECT?.trim() || "memorylayer";
  process.stdout.write(renderStopReview(client, reviewInstruction(project)));
  process.exit(0);
}

if (isMain(import.meta.url)) {
  void runStopHook();
}
```

- [ ] **Step 7: Create the dispatching CLI**

Create `src/cli.ts`:

```ts
#!/usr/bin/env node
/**
 * The single `memorylayer` command. Routes subcommands so the tool is one
 * installable binary (no bash launchers, no separate entrypoints to wire):
 *
 *   memorylayer                       -> MCP server (default)
 *   memorylayer hook <client>         -> read hook
 *   memorylayer stop-review <client>  -> Stop/write-review hook
 *   memorylayer init [flags]          -> installer
 *
 * `hook`/`stop-review` set MEMORYLAYER_HOOK_CLIENT from the positional arg, then
 * delegate to the neutral run functions (which self-load .memorylayer-hook.env).
 */
import { runServer } from "./index.js";
import { runHook } from "./hook.js";
import { runStopHook } from "./stop-hook.js";
import { runInit } from "./init.js";

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);

  switch (sub) {
    case "hook":
      if (rest[0]) process.env.MEMORYLAYER_HOOK_CLIENT = rest[0];
      await runHook();
      return;
    case "stop-review":
      if (rest[0]) process.env.MEMORYLAYER_HOOK_CLIENT = rest[0];
      await runStopHook();
      return;
    case "init":
      await runInit(rest);
      return;
    case undefined:
      await runServer();
      return;
    default:
      console.error(
        `Unknown command "${sub}". Use: memorylayer [hook|stop-review|init] …`,
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
```

- [ ] **Step 8: Add a minimal `runInit` stub so `cli.ts` compiles**

Create `src/init.ts` (filled out in Task 5; stub keeps the build green now):

```ts
/** Installer entry — full implementation in Task 5. */
export async function runInit(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    process.stdout.write("memorylayer init — wire MemoryLayer into this project\n");
    return;
  }
  throw new Error("memorylayer init is not implemented yet");
}
```

- [ ] **Step 9: Point the bin at the dispatcher**

In `package.json`, change:

```json
  "bin": {
    "memorylayer": "dist/index.js"
  },
```

to:

```json
  "bin": {
    "memorylayer": "dist/cli.js"
  },
```

- [ ] **Step 10: Run tests to verify they pass**

Run: `npm run build && node --test test/cli.test.mjs test/hook.test.mjs test/stop-hook.test.mjs`
Expected: PASS. The existing `hook.test.mjs`/`stop-hook.test.mjs` still pass because `dist/hook.js`/`dist/stop-hook.js` self-run when spawned directly (guarded by `isMain`).

- [ ] **Step 11: Lint + format + full suite**

Run: `npm test && npm run lint && npm run format:check`
Expected: all green.

- [ ] **Step 12: Commit**

```bash
git add src/cli.ts src/is-main.ts src/init.ts src/index.ts src/hook.ts src/stop-hook.ts package.json test/cli.test.mjs
git commit -m "feat: single memorylayer bin with subcommand routing

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Self-loading `.memorylayer-hook.env` in `config.ts`

Move env-file loading out of the bash launchers and into the command, so `memorylayer` is self-contained. The launcher used `set -a; . file` (file values exported into env). We mirror that but do NOT override variables already set explicitly in the process env (so tests and explicit env still win).

**Files:**
- Modify: `src/config.ts`
- Test: `test/config.test.mjs` (extend)

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadHookEnv(cwd?: string): void` (exported from config.ts) — loads `.memorylayer-hook.env` from `cwd` (default `process.cwd()`) into `process.env` for keys not already set. `loadConfig()` calls it first.

- [ ] **Step 1: Write the failing test**

Add to `test/config.test.mjs`:

```js
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { loadHookEnv, loadConfig } from "../dist/config.js";

test("loadHookEnv loads KEY=VALUE lines from .memorylayer-hook.env, skips comments/blanks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-env-"));
  fs.writeFileSync(
    path.join(dir, ".memorylayer-hook.env"),
    "# a comment\n\nMEMORYLAYER_AUTHOR=Ada\nCONTEXT_REPO_URL=https://example/x.git\n",
  );
  const saved = { ...process.env };
  delete process.env.MEMORYLAYER_AUTHOR;
  delete process.env.CONTEXT_REPO_URL;
  try {
    loadHookEnv(dir);
    assert.equal(process.env.MEMORYLAYER_AUTHOR, "Ada");
    assert.equal(process.env.CONTEXT_REPO_URL, "https://example/x.git");
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadHookEnv does NOT override an already-set env var", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-env-"));
  fs.writeFileSync(path.join(dir, ".memorylayer-hook.env"), "MEMORYLAYER_AUTHOR=FromFile\n");
  const saved = { ...process.env };
  process.env.MEMORYLAYER_AUTHOR = "FromEnv";
  try {
    loadHookEnv(dir);
    assert.equal(process.env.MEMORYLAYER_AUTHOR, "FromEnv");
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadHookEnv is a silent no-op when the file is absent (fail-open)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-env-"));
  assert.doesNotThrow(() => loadHookEnv(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});
```

Ensure the top of `test/config.test.mjs` imports `loadConfig` (it likely already does); add `loadHookEnv` to that import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test test/config.test.mjs`
Expected: FAIL — `loadHookEnv` is not exported.

- [ ] **Step 3: Implement `loadHookEnv` and call it from `loadConfig`**

In `src/config.ts`, add imports at the top:

```ts
import fs from "node:fs";
```

Add the function above `loadConfig`:

```ts
/**
 * Load `.memorylayer-hook.env` (KEY=VALUE lines) from `cwd` into process.env,
 * for keys NOT already set. This replaces the old bash launcher's `set -a; . file`
 * so the `memorylayer` command is self-contained. Silent no-op if the file is
 * absent or unreadable — never throws, preserving the hooks' fail-open contract.
 */
export function loadHookEnv(cwd: string = process.cwd()): void {
  const file = path.join(cwd, ".memorylayer-hook.env");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return; // absent/unreadable — nothing to load.
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
```

Add as the first line inside `loadConfig`:

```ts
export function loadConfig(): Config {
  loadHookEnv();
  const author = required("MEMORYLAYER_AUTHOR");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && node --test test/config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Lint + format + full suite**

Run: `npm test && npm run lint && npm run format:check`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/config.ts test/config.test.mjs
git commit -m "feat: self-load .memorylayer-hook.env from cwd in config

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Pure config builders/mergers (`init-configs.ts`)

The heart of `init`: given a client's existing parsed config (or `undefined`), return the config with our hook/MCP entries merged in — never clobbering unrelated entries, idempotent on re-run. Pure functions, no I/O, exhaustively unit-tested.

**Files:**
- Create: `src/init-configs.ts`
- Test: `test/init-configs.test.mjs` (new)

**Interfaces:**
- Consumes: nothing.
- Produces (all take `existing: unknown | undefined`, return a plain JSON-serializable object):
  - `mergeClaudeSettings(existing)` → Claude Code `settings.json` with SessionStart + Stop entries invoking `memorylayer hook claude-code` / `memorylayer stop-review claude-code`.
  - `mergeCursorHooks(existing)` → Cursor `hooks.json` (version 1) with `sessionStart` + `stop` (loop_limit 3) invoking `memorylayer hook cursor` / `memorylayer stop-review cursor`.
  - `mergeCodexHooks(existing)` → Codex `hooks.json` with SessionStart (matcher `startup|resume`) + Stop invoking `memorylayer hook codex` / `memorylayer stop-review codex`.
  - `mergeMcpJson(existing)` → `{ mcpServers: { …existing, memorylayer: { command: "memorylayer", args: [], env: {} } } }` (used for both `.mcp.json` and `.cursor/mcp.json`).
  - `CODEX_MCP_TOML` → the exact `[mcp_servers.memorylayer]` block string printed for manual paste.

- [ ] **Step 1: Write the failing test**

Create `test/init-configs.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeClaudeSettings,
  mergeCursorHooks,
  mergeCodexHooks,
  mergeMcpJson,
  CODEX_MCP_TOML,
} from "../dist/init-configs.js";

test("mergeClaudeSettings creates SessionStart + Stop from empty", () => {
  const out = mergeClaudeSettings(undefined);
  const cmds = JSON.stringify(out);
  assert.match(cmds, /memorylayer hook claude-code/);
  assert.match(cmds, /memorylayer stop-review claude-code/);
});

test("mergeClaudeSettings preserves unrelated existing hooks and is idempotent", () => {
  const existing = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "echo other" }] }],
    },
  };
  const once = mergeClaudeSettings(existing);
  // unrelated entry preserved
  assert.match(JSON.stringify(once), /echo other/);
  // our entry present exactly once
  const twice = mergeClaudeSettings(once);
  const count = JSON.stringify(twice).split("memorylayer hook claude-code").length - 1;
  assert.equal(count, 1);
});

test("mergeCursorHooks sets version 1, loop_limit 3, both events", () => {
  const out = mergeCursorHooks(undefined);
  assert.equal(out.version, 1);
  assert.match(JSON.stringify(out.hooks.sessionStart), /memorylayer hook cursor/);
  const stop = out.hooks.stop[0];
  assert.equal(stop.loop_limit, 3);
  assert.match(stop.command, /memorylayer stop-review cursor/);
});

test("mergeCodexHooks uses the startup|resume matcher on SessionStart", () => {
  const out = mergeCodexHooks(undefined);
  assert.equal(out.hooks.SessionStart[0].matcher, "startup|resume");
  assert.match(JSON.stringify(out.hooks.Stop), /memorylayer stop-review codex/);
});

test("mergeMcpJson adds a secret-free memorylayer server, preserving others", () => {
  const out = mergeMcpJson({ mcpServers: { other: { command: "x" } } });
  assert.equal(out.mcpServers.other.command, "x");
  assert.deepEqual(out.mcpServers.memorylayer, {
    command: "memorylayer",
    args: [],
    env: {},
  });
});

test("CODEX_MCP_TOML is the manual mcp_servers block", () => {
  assert.match(CODEX_MCP_TOML, /\[mcp_servers\.memorylayer\]/);
  assert.match(CODEX_MCP_TOML, /command = "memorylayer"/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test test/init-configs.test.mjs`
Expected: FAIL — `Cannot find module '../dist/init-configs.js'`.

- [ ] **Step 3: Implement the builders**

Create `src/init-configs.ts`:

```ts
/**
 * Pure builders/mergers for the per-vendor config artifacts `init` writes.
 *
 * Each `merge*` takes the client's existing parsed config (or undefined) and
 * returns it with MemoryLayer's entries added. Merges are:
 *  - non-clobbering: unrelated existing entries are preserved;
 *  - idempotent: our command appears at most once on re-run (matched by command
 *    substring / server key).
 *
 * Commands invoke the globally-installed `memorylayer` binary (fast, offline),
 * NOT a bash launcher or npx. All are secret-free: `memorylayer` self-loads
 * `.memorylayer-hook.env` from the project cwd at runtime.
 */

type Json = Record<string, unknown>;

const asObject = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Json) } : {};
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? [...v] : []);

/** Append `entry` to `list` unless some existing item's JSON contains `marker`. */
function addOnce(list: unknown[], marker: string, entry: unknown): unknown[] {
  const present = list.some((item) => JSON.stringify(item).includes(marker));
  return present ? list : [...list, entry];
}

export function mergeClaudeSettings(existing: unknown): Json {
  const root = asObject(existing);
  const hooks = asObject(root.hooks);
  hooks.SessionStart = addOnce(asArray(hooks.SessionStart), "memorylayer hook claude-code", {
    hooks: [{ type: "command", command: "memorylayer hook claude-code" }],
  });
  hooks.Stop = addOnce(asArray(hooks.Stop), "memorylayer stop-review claude-code", {
    hooks: [{ type: "command", command: "memorylayer stop-review claude-code" }],
  });
  root.hooks = hooks;
  return root;
}

export function mergeCursorHooks(existing: unknown): Json {
  const root = asObject(existing);
  root.version = 1;
  const hooks = asObject(root.hooks);
  hooks.sessionStart = addOnce(asArray(hooks.sessionStart), "memorylayer hook cursor", {
    command: "memorylayer hook cursor",
  });
  hooks.stop = addOnce(asArray(hooks.stop), "memorylayer stop-review cursor", {
    command: "memorylayer stop-review cursor",
    loop_limit: 3,
  });
  root.hooks = hooks;
  return root;
}

export function mergeCodexHooks(existing: unknown): Json {
  const root = asObject(existing);
  const hooks = asObject(root.hooks);
  hooks.SessionStart = addOnce(asArray(hooks.SessionStart), "memorylayer hook codex", {
    matcher: "startup|resume",
    hooks: [{ type: "command", command: "memorylayer hook codex" }],
  });
  hooks.Stop = addOnce(asArray(hooks.Stop), "memorylayer stop-review codex", {
    hooks: [{ type: "command", command: "memorylayer stop-review codex" }],
  });
  root.hooks = hooks;
  return root;
}

export function mergeMcpJson(existing: unknown): Json {
  const root = asObject(existing);
  const servers = asObject(root.mcpServers);
  servers.memorylayer = { command: "memorylayer", args: [], env: {} };
  root.mcpServers = servers;
  return root;
}

/** Manual paste block for Codex MCP (global ~/.codex/config.toml). */
export const CODEX_MCP_TOML = `[mcp_servers.memorylayer]
command = "memorylayer"
args = []
`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && node --test test/init-configs.test.mjs`
Expected: PASS.

- [ ] **Step 5: Lint + format + full suite**

Run: `npm test && npm run lint && npm run format:check`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/init-configs.ts test/init-configs.test.mjs
git commit -m "feat: pure per-vendor config mergers for init (non-clobbering, idempotent)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Env file + gitignore + git-config defaults (`init-env.ts`)

Pure/isolated helpers for the user tier: build `.memorylayer-hook.env` content, read `git config` defaults, and update `.gitignore` idempotently.

**Files:**
- Create: `src/init-env.ts`
- Test: `test/init-env.test.mjs` (new)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `buildHookEnv(v: { author: string; email: string; repoUrl: string; project: string }): string` — the file contents.
  - `gitConfigDefault(key: "user.name" | "user.email"): string` — trimmed value or `""`.
  - `ensureGitignore(existing: string, entries: string[]): string` — returns `.gitignore` content with each missing entry appended exactly once.

- [ ] **Step 1: Write the failing test**

Create `test/init-env.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHookEnv, ensureGitignore } from "../dist/init-env.js";

test("buildHookEnv emits all four keys", () => {
  const out = buildHookEnv({
    author: "Ada",
    email: "ada@x.io",
    repoUrl: "https://t@github.com/team/mem.git",
    project: "team-app",
  });
  assert.match(out, /^MEMORYLAYER_AUTHOR=Ada$/m);
  assert.match(out, /^MEMORYLAYER_AUTHOR_EMAIL=ada@x.io$/m);
  assert.match(out, /^CONTEXT_REPO_URL=https:\/\/t@github.com\/team\/mem.git$/m);
  assert.match(out, /^MEMORYLAYER_PROJECT=team-app$/m);
});

test("ensureGitignore appends missing entries once, preserves content", () => {
  const start = "node_modules/\n";
  const once = ensureGitignore(start, [".memorylayer-hook.env", ".claude/settings.local.json"]);
  assert.match(once, /node_modules\//);
  assert.match(once, /\.memorylayer-hook\.env/);
  assert.match(once, /\.claude\/settings\.local\.json/);
  // idempotent
  const twice = ensureGitignore(once, [".memorylayer-hook.env"]);
  assert.equal(twice.split(".memorylayer-hook.env").length - 1, 1);
});

test("ensureGitignore matches entries even without trailing newline", () => {
  const out = ensureGitignore("node_modules/", [".memorylayer-hook.env"]);
  assert.match(out, /node_modules\/\n/);
  assert.match(out, /\.memorylayer-hook\.env/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test test/init-env.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helpers**

Create `src/init-env.ts`:

```ts
import { execFileSync } from "node:child_process";

/** Contents of the per-user, gitignored .memorylayer-hook.env file. */
export function buildHookEnv(v: {
  author: string;
  email: string;
  repoUrl: string;
  project: string;
}): string {
  return [
    "# MemoryLayer per-user hook config — gitignored. Do NOT commit.",
    "# Written by `memorylayer init`. Your identity + context-repo access.",
    `CONTEXT_REPO_URL=${v.repoUrl}`,
    `MEMORYLAYER_AUTHOR=${v.author}`,
    `MEMORYLAYER_AUTHOR_EMAIL=${v.email}`,
    `MEMORYLAYER_PROJECT=${v.project}`,
    "",
  ].join("\n");
}

/** Read a git config value for a prompt default; "" if git/key is absent. */
export function gitConfigDefault(key: "user.name" | "user.email"): string {
  try {
    return execFileSync("git", ["config", "--get", key], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** Append each missing entry to .gitignore content exactly once. */
export function ensureGitignore(existing: string, entries: string[]): string {
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  let out = existing.endsWith("\n") || existing === "" ? existing : existing + "\n";
  for (const entry of entries) {
    if (!lines.includes(entry)) out += `${entry}\n`;
  }
  return out;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && node --test test/init-env.test.mjs`
Expected: PASS.

- [ ] **Step 5: Lint + format + full suite**

Run: `npm test && npm run lint && npm run format:check`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/init-env.ts test/init-env.test.mjs
git commit -m "feat: env-file, git-config defaults, and gitignore helpers for init

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: `init` orchestration + wiring into the CLI

Assemble Tasks 3 + 4 into the real installer: detect the repo, write each config (merge-not-clobber, back up unparseable files), prompt for identity (or take flags for non-interactive/testable runs), write the env, update gitignore, and print next steps + the Codex MCP manual block.

**Files:**
- Modify: `src/init.ts` (replace the Task 1 stub)
- Test: `test/init.test.mjs` (new)

**Interfaces:**
- Consumes: `mergeClaudeSettings`/`mergeCursorHooks`/`mergeCodexHooks`/`mergeMcpJson`/`CODEX_MCP_TOML` (init-configs.ts); `buildHookEnv`/`gitConfigDefault`/`ensureGitignore` (init-env.ts).
- Produces: `runInit(args: string[]): Promise<void>` — full implementation. Non-interactive when all of `--author`, `--email`, `--context-repo`, `--project` are supplied (or `--yes` with git-config defaults); otherwise prompts. `--force` rewrites an existing env file. `--help` prints usage.

- [ ] **Step 1: Write the failing test**

Create `test/init.test.mjs`. Runs `init` non-interactively via `dist/cli.js` in a throwaway git repo and asserts every artifact lands, then re-runs for idempotency:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-init-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function runInit(dir) {
  return execFileSync(
    process.execPath,
    [
      cli,
      "init",
      "--author",
      "Ada",
      "--email",
      "ada@x.io",
      "--context-repo",
      "https://t@github.com/team/mem.git",
      "--project",
      "team-app",
    ],
    { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
  );
}

test("init writes all three hook configs, both MCP files, env, and gitignore", () => {
  const dir = initRepo();
  try {
    const out = runInit(dir);
    const read = (p) => fs.readFileSync(path.join(dir, p), "utf8");

    assert.match(read(".claude/settings.json"), /memorylayer hook claude-code/);
    assert.match(read(".cursor/hooks.json"), /memorylayer stop-review cursor/);
    assert.match(read(".codex/hooks.json"), /startup\|resume/);
    assert.match(read(".mcp.json"), /"memorylayer"/);
    assert.match(read(".cursor/mcp.json"), /"memorylayer"/);
    assert.match(read(".memorylayer-hook.env"), /MEMORYLAYER_AUTHOR=Ada/);
    assert.match(read(".gitignore"), /\.memorylayer-hook\.env/);
    // Codex MCP is a printed manual step, not an auto-written file.
    assert.match(out, /\[mcp_servers\.memorylayer\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init is idempotent — re-run adds no duplicate hook entries", () => {
  const dir = initRepo();
  try {
    runInit(dir);
    runInit(dir);
    const claude = fs.readFileSync(path.join(dir, ".claude/settings.json"), "utf8");
    assert.equal(claude.split("memorylayer hook claude-code").length - 1, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init backs up an unparseable existing config instead of destroying it", () => {
  const dir = initRepo();
  try {
    fs.mkdirSync(path.join(dir, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".cursor/hooks.json"), "{ not json");
    runInit(dir);
    assert.ok(fs.existsSync(path.join(dir, ".cursor/hooks.json.bak")));
    assert.match(
      fs.readFileSync(path.join(dir, ".cursor/hooks.json"), "utf8"),
      /memorylayer hook cursor/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test test/init.test.mjs`
Expected: FAIL — `runInit` throws "not implemented yet" (Task 1 stub).

- [ ] **Step 3: Implement `runInit`**

Replace the contents of `src/init.ts` with:

```ts
/**
 * `memorylayer init` — wire MemoryLayer into the current project repo.
 *
 * LOUD, not fail-open (the inverse of the runtime hooks): a half-written setup
 * must surface. Unparseable existing configs are backed up (.bak), never
 * destroyed. Idempotent: re-running adds our entries at most once.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  mergeClaudeSettings,
  mergeCursorHooks,
  mergeCodexHooks,
  mergeMcpJson,
  CODEX_MCP_TOML,
} from "./init-configs.js";
import { buildHookEnv, gitConfigDefault, ensureGitignore } from "./init-env.js";

const USAGE = `memorylayer init — wire MemoryLayer into this project

Options (all optional; missing identity values are prompted for):
  --author <name>         commit author / attribution
  --email <email>         commit email
  --context-repo <url>    shared context repo URL (may embed a token)
  --project <name>        shared project/space name (default: repo dir name)
  --force                 rewrite an existing .memorylayer-hook.env
  --yes                   accept git-config / directory defaults, no prompts
  --help                  show this help
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const has = (args: string[], name: string): boolean => args.includes(`--${name}`);

/** Read+parse a JSON config; on parse error, back it up and treat as absent. */
function readJson(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  const raw = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    fs.copyFileSync(file, `${file}.bak`);
    console.warn(`! ${file} was not valid JSON — backed up to ${file}.bak and rewriting.`);
    return undefined;
  }
}

function writeJson(cwd: string, rel: string, data: unknown): void {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  console.log(`  wrote ${rel}`);
}

export async function runInit(args: string[]): Promise<void> {
  if (has(args, "help")) {
    output.write(USAGE);
    return;
  }

  const cwd = process.cwd();
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    console.warn(
      "! Not a git repository. Hooks are project-scoped; run this in your project root.",
    );
  }

  // --- Project tier: hook configs (all three clients) ---
  writeJson(cwd, ".claude/settings.json", mergeClaudeSettings(readJson(path.join(cwd, ".claude/settings.json"))));
  writeJson(cwd, ".cursor/hooks.json", mergeCursorHooks(readJson(path.join(cwd, ".cursor/hooks.json"))));
  writeJson(cwd, ".codex/hooks.json", mergeCodexHooks(readJson(path.join(cwd, ".codex/hooks.json"))));

  // --- Project tier: MCP registration (Claude Code + Cursor; Codex is manual) ---
  writeJson(cwd, ".mcp.json", mergeMcpJson(readJson(path.join(cwd, ".mcp.json"))));
  writeJson(cwd, ".cursor/mcp.json", mergeMcpJson(readJson(path.join(cwd, ".cursor/mcp.json"))));

  // --- User tier: identity env file ---
  const envFile = path.join(cwd, ".memorylayer-hook.env");
  if (fs.existsSync(envFile) && !has(args, "force")) {
    console.log("  .memorylayer-hook.env exists — leaving it (use --force to rewrite).");
  } else {
    const useDefaults = has(args, "yes");
    const rl =
      useDefaults ||
      (flag(args, "author") && flag(args, "email") && flag(args, "context-repo"))
        ? undefined
        : readline.createInterface({ input, output });
    const ask = async (q: string, def: string): Promise<string> => {
      if (!rl) return def;
      const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
      return a || def;
    };

    const author = flag(args, "author") ?? (await ask("Author name", gitConfigDefault("user.name")));
    const email = flag(args, "email") ?? (await ask("Author email", gitConfigDefault("user.email")));
    const repoUrl = flag(args, "context-repo") ?? (await ask("Context repo URL (with token)", ""));
    const project = flag(args, "project") ?? (await ask("Project name", path.basename(cwd)));
    rl?.close();

    if (!author || !repoUrl) {
      throw new Error("author and context-repo are required to write .memorylayer-hook.env");
    }
    fs.writeFileSync(envFile, buildHookEnv({ author, email, repoUrl, project }));
    console.log("  wrote .memorylayer-hook.env (gitignored)");
  }

  // --- Gitignore the per-user + per-user-local files ---
  const giPath = path.join(cwd, ".gitignore");
  const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";
  fs.writeFileSync(
    giPath,
    ensureGitignore(gi, [".memorylayer-hook.env", ".claude/settings.local.json"]),
  );
  console.log("  updated .gitignore");

  // --- Codex MCP: manual step (global config.toml, no TOML dependency) ---
  console.log("\nNext steps:");
  console.log("  1. Commit the project configs so teammates inherit them:");
  console.log("       git add .claude .cursor .codex .mcp.json .gitignore && git commit -m 'chore: wire MemoryLayer'");
  console.log("  2. Each teammate runs `memorylayer init` to set their own identity.");
  console.log("  3. Codex users: add this to ~/.codex/config.toml (MCP tools):\n");
  console.log(CODEX_MCP_TOML);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && node --test test/init.test.mjs`
Expected: PASS (all three cases: full write, idempotent re-run, `.bak` backup).

- [ ] **Step 5: Lint + format + full suite**

Run: `npm test && npm run lint && npm run format:check`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add src/init.ts test/init.test.mjs
git commit -m "feat: memorylayer init orchestration (writes hooks + MCP + env, idempotent)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Cutover — migrate this repo's hooks, retire launchers, prepare script, README

Make MemoryLayer dogfood the new command, drop the bash launchers, add the git-install build hook, and rewrite the setup docs.

**Files:**
- Modify: `.claude/settings.json`, `.cursor/hooks.json`, `.codex/hooks.json`
- Delete: `hooks/session-start.sh`, `hooks/stop-review.sh`
- Modify: `package.json` (add `prepare`)
- Modify: `.memorylayer-hook.env.example`
- Modify: `README.md`

**Interfaces:**
- Consumes: `dist/cli.js` (Task 1).
- Produces: no code interfaces — a green build with the repo running on the new command.

- [ ] **Step 1: Migrate this repo's own hook configs to the dispatcher**

For local dev this repo has no globally-installed `memorylayer`, so its own hooks call the built dispatcher directly.

`.claude/settings.json` — replace both commands:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/dist/cli.js\" hook claude-code" }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/dist/cli.js\" stop-review claude-code" }
        ]
      }
    ]
  }
}
```

`.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "node ./dist/cli.js hook cursor" }],
    "stop": [{ "command": "node ./dist/cli.js stop-review cursor", "loop_limit": 3 }]
  }
}
```

`.codex/hooks.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [{ "type": "command", "command": "node ./dist/cli.js hook codex" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "node ./dist/cli.js stop-review codex" }]
      }
    ]
  }
}
```

- [ ] **Step 2: Delete the retired launchers**

```bash
git rm hooks/session-start.sh hooks/stop-review.sh
```

- [ ] **Step 3: Add the git-install build hook**

In `package.json`, add a `prepare` script so `npm install -g github:…` compiles `dist/` on fetch (dist/ is gitignored):

```json
  "scripts": {
    "build": "tsc",
    "prepare": "tsc",
    "dev": "tsc --watch",
```

(Keep the remaining scripts unchanged.)

- [ ] **Step 4: Update the env example comment**

In `.memorylayer-hook.env.example`, replace the second comment line so it no longer references the deleted launcher:

```
# Copy to .memorylayer-hook.env (gitignored) and fill in your values.
# Loaded automatically by the `memorylayer` command (config self-load) so your identity/URL never enter git.
CONTEXT_REPO_URL=https://<token>@github.com/yourteam/planning-memory.git
MEMORYLAYER_AUTHOR=Your Name
MEMORYLAYER_PROJECT=your-project
```

- [ ] **Step 5: Rewrite the README setup section**

In `README.md`, replace the `## Setup` section (through the hook-wiring subsections) with the install + `init` flow. Insert this after the `## How it works` section, replacing the old build/config/hook-wiring prose:

```markdown
## Setup

MemoryLayer installs into **your project repo** — no clone, no hand-wiring.

### 1. Create the shared context repo (once, by one person)

Create a **private** git repo all collaborators can push to. This is the shared
memory; it starts empty. Grant each collaborator access.

### 2. Install the command (once per machine)

```bash
npm install -g github:skandaramanan/MemoryLayer
```

This is a private GitHub install — nothing is published to npm. Collaborators
need read access to this code repo (the same kind of invite as the memory repo).

### 3. Wire it into your project

From your shared project repo:

```bash
memorylayer init
```

`init` writes the read + write hooks and MCP registration for Claude Code,
Cursor, and Codex, and prompts for your identity + the context repo URL (stored
in the gitignored `.memorylayer-hook.env`). One person commits the project
configs; teammates each run `memorylayer init` to set their own identity.

Codex users: `init` prints an `[mcp_servers.memorylayer]` block to paste into
`~/.codex/config.toml` (Codex registers MCP globally).

**Claude Desktop** is MCP-pull-only (no hooks): register the `memorylayer`
command as a stdio MCP server manually; it will read context when the model
chooses to, not automatically.
```

- [ ] **Step 6: Build + full green bar**

Run: `npm test && npm run lint && npm run format:check`
Expected: all green. (`npm test` runs `tsc` first, so `dist/cli.js` exists for the migrated hooks.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: cutover to memorylayer command — retire bash launchers, prepare script, README

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Distribution (private GitHub install) → Task 6 (`prepare`, README). ✓
- Invocation (global command, subcommands) → Task 1. ✓
- Self-loading env → Task 2. ✓
- Three-client hook wiring, merge-not-clobber → Task 3 + Task 5. ✓
- MCP registration (Claude/Cursor auto, Codex manual) → Task 3 (`mergeMcpJson`, `CODEX_MCP_TOML`) + Task 5. ✓
- Two tiers (committed project / gitignored user) → Task 5 (writes + gitignore). ✓
- Loud error posture + `.bak` + idempotency → Task 5 (`readJson`, tests). ✓
- Retire launchers, migrate repo hooks → Task 6. ✓
- Testing (unit merges, env, integration init, idempotency) → Tasks 3/4/5. ✓
- Neutral core untouched → no task modifies store/hook-clients envelopes. ✓

**Placeholder scan:** No TBD/TODO; every code + test step carries full content. ✓

**Type consistency:** `runServer`/`runHook`/`runStopHook`/`runInit` names match across Task 1 (definitions), `cli.ts` (call sites), and Task 5. `merge*`/`mergeMcpJson`/`CODEX_MCP_TOML` names match Task 3 defs, Task 3 tests, and Task 5 imports. `buildHookEnv`/`gitConfigDefault`/`ensureGitignore` match Task 4 defs/tests and Task 5 imports. `loadHookEnv` matches Task 2 def/test and `loadConfig` call site. ✓

**Known residual risk (flagged, not a blocker):** MCP servers must spawn with cwd = project root for the self-load to find `.memorylayer-hook.env`. Claude Code and Cursor spawn project MCP servers at the project root, so this holds; if a client ever spawns elsewhere, the fallback is to add an explicit env pointer in the MCP registration. Out of scope for this plan; noted for execution.
