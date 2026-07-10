# Hosted-Member Onboarding (`wayform init --remote`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a hosted member onboard with only a gateway URL + token — auto-injecting the team's shared memory at session start and reading/writing via native HTTP MCP — with no git clone, no code-repo access, and no token committed to git.

**Architecture:** The hook runtime already reads from the gateway (`remoteHookRead` → `/hook/read`); the only blocker is `loadConfig()` hard-requiring `CONTEXT_REPO_URL`, which makes a gateway-only member fail-open to silence. We (1) relax `loadConfig` to a gateway-only mode using an empty-string sentinel for the absent clone (avoids a type ripple across `store.ts`/`git-repo.ts`/`metrics.ts`/`doctor.ts`), guarded so the clone is never touched; and (2) add a `wayform init --remote` installer that writes the gitignored gateway env, the project session/Stop hooks (calling `wayform`), and project-scoped token-safe native HTTP MCP registration per client.

**Tech Stack:** TypeScript (ESM, `tsc` → `dist/`), Node.js built-in test runner (`node --test test/*.test.mjs`), no runtime deps in the core tool. Tests import from `../dist/*.js` and run the built CLI via `process.execPath`.

## Global Constraints

- **Binary/package name:** `wayform` (public npm). Keep `memorylayer` as a transitional `bin` alias so existing committed local configs still resolve. Exact install command: `npm install -g wayform`.
- **Store project space name stays `memorylayer`.** The MCP server name registered stays `memorylayer`. Env var names (`MEMORYLAYER_*`, `CONTEXT_REPO_URL`) are unchanged this pass.
- **Hook posture is fail-open:** a broken/gateway-only read must NEVER break a session — emit the client's empty no-op and exit 0. `init` posture is the inverse — LOUD: back up unparseable configs to `.bak`, never destroy; idempotent re-runs.
- **Token safety:** the member token must never land in a git-committed file. Project-scoped where technically possible: Claude Code via `claude mcp add --scope local`; Cursor via a **gitignored** `.cursor/mcp.json`; Codex is global-only (`~/.codex/config.toml`) — documented platform exception, printed as a manual snippet.
- **Idempotency marker** for hook mergers is the `<subcommand> <client>` token (e.g. `hook claude-code`), independent of the binary name — do not include the binary name in the marker.
- Every task ends green: `npm test` (build + all `test/*.test.mjs`), `npm run typecheck`, `npm run lint`, `npm run format:check`.
- Spec: `docs/superpowers/specs/2026-07-09-hosted-member-onboarding-design.md`.

---

## File Structure

- **Modify** `src/config.ts` — gateway-only mode in `loadConfig` (empty-string sentinel for `repoUrl`/`repoPath`).
- **Modify** `src/hook.ts` — guard: gateway-only + gateway-unreachable → emit empty (never construct `ContextStore`).
- **Modify** `src/metrics.ts` — `recordMetric` no-ops when there is no local clone (`!cfg.repoPath`).
- **Modify** `src/init-configs.ts` — parameterize hook mergers with a `bin` name; add `mergeCursorRemoteMcp` and `codexRemoteMcpToml`.
- **Modify** `src/init-env.ts` — add `buildRemoteHookEnv`.
- **Create** `src/init-remote.ts` — `runInitRemote(args)` orchestration + `registerClaudeCodeMcp` helper.
- **Modify** `src/init.ts` — delegate to `runInitRemote` when `--remote` is present.
- **Modify** `src/cli.ts` — update user-facing usage strings to `wayform` (routing unchanged; `init` already routes to `runInit`).
- **Modify** `package.json` — `name: "wayform"`, `bin` with `wayform` + `memorylayer` alias.
- **Modify** `docs/onboarding/self-onboarding.md` — note the `wayform init --remote` path.
- **Test** `test/init-configs.test.mjs`, `test/init-env.test.mjs`, `test/config.test.mjs`, `test/init-remote.test.mjs` (new), `test/integration.test.mjs`.

---

## Task 1: Parameterize hook config mergers with a binary name

Enables emitting `wayform hook …` for remote members while defaulting to `memorylayer` so existing local behavior and tests are unchanged.

**Files:**
- Modify: `src/init-configs.ts`
- Test: `test/init-configs.test.mjs`

**Interfaces:**
- Produces: `mergeClaudeSettings(existing: unknown, bin?: string): Json`, `mergeCursorHooks(existing: unknown, bin?: string): Json`, `mergeCodexHooks(existing: unknown, bin?: string): Json` — all default `bin = "memorylayer"`.

- [ ] **Step 1: Write the failing test**

Add to `test/init-configs.test.mjs`:

```javascript
test("mergeClaudeSettings emits the given binary name in hook commands", () => {
  const out = mergeClaudeSettings(undefined, "wayform");
  const cmds = out.hooks.SessionStart[0].hooks.map((h) => h.command);
  assert.ok(cmds.includes("wayform hook claude-code"));
  const stop = out.hooks.Stop[0].hooks.map((h) => h.command);
  assert.ok(stop.includes("wayform stop-review claude-code"));
});

test("mergeClaudeSettings defaults to the memorylayer binary", () => {
  const out = mergeClaudeSettings(undefined);
  assert.equal(
    out.hooks.SessionStart[0].hooks[0].command,
    "memorylayer hook claude-code",
  );
});

test("mergeCursorHooks / mergeCodexHooks honor the binary name", () => {
  const cur = mergeCursorHooks(undefined, "wayform");
  assert.equal(cur.hooks.sessionStart[0].command, "wayform hook cursor");
  const cdx = mergeCodexHooks(undefined, "wayform");
  assert.equal(cdx.hooks.SessionStart[0].hooks[0].command, "wayform hook codex");
});

test("re-merging with a different binary name does not duplicate hooks (marker is bin-independent)", () => {
  const once = mergeClaudeSettings(undefined, "memorylayer");
  const twice = mergeClaudeSettings(once, "wayform");
  assert.equal(twice.hooks.SessionStart.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A2 "binary name"`
Expected: FAIL (mergers currently take one arg / hardcode `memorylayer`).

- [ ] **Step 3: Implement — thread a `bin` parameter through the three hook mergers**

In `src/init-configs.ts`, change the three hook mergers (leave `addOnce` and `mergeMcpJson` untouched):

```typescript
export function mergeClaudeSettings(
  existing: unknown,
  bin: string = "memorylayer",
): Json {
  const root = asObject(existing);
  const hooks = asObject(root.hooks);
  hooks.SessionStart = addOnce(asArray(hooks.SessionStart), "hook claude-code", {
    hooks: [{ type: "command", command: `${bin} hook claude-code` }],
  });
  hooks.Stop = addOnce(asArray(hooks.Stop), "stop-review claude-code", {
    hooks: [{ type: "command", command: `${bin} stop-review claude-code` }],
  });
  root.hooks = hooks;
  return root;
}

export function mergeCursorHooks(
  existing: unknown,
  bin: string = "memorylayer",
): Json {
  const root = asObject(existing);
  root.version = 1;
  const hooks = asObject(root.hooks);
  hooks.sessionStart = addOnce(asArray(hooks.sessionStart), "hook cursor", {
    command: `${bin} hook cursor`,
  });
  hooks.stop = addOnce(asArray(hooks.stop), "stop-review cursor", {
    command: `${bin} stop-review cursor`,
    loop_limit: 3,
  });
  root.hooks = hooks;
  return root;
}

export function mergeCodexHooks(
  existing: unknown,
  bin: string = "memorylayer",
): Json {
  const root = asObject(existing);
  const hooks = asObject(root.hooks);
  hooks.SessionStart = addOnce(asArray(hooks.SessionStart), "hook codex", {
    matcher: "startup|resume",
    hooks: [{ type: "command", command: `${bin} hook codex` }],
  });
  hooks.Stop = addOnce(asArray(hooks.Stop), "stop-review codex", {
    hooks: [{ type: "command", command: `${bin} stop-review codex` }],
  });
  root.hooks = hooks;
  return root;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS (new tests green; all prior `init-configs` tests still green because the default is `memorylayer`).

- [ ] **Step 5: Commit**

```bash
git add src/init-configs.ts test/init-configs.test.mjs
git commit -m "feat(init): parameterize hook mergers with binary name (default memorylayer)"
```

---

## Task 2: Cursor remote MCP merger + Codex remote MCP snippet

Native HTTP MCP registration artifacts for the hosted flow. Cursor is a merged, gitignored file; Codex is a printed snippet.

**Files:**
- Modify: `src/init-configs.ts`
- Test: `test/init-configs.test.mjs`

**Interfaces:**
- Produces: `mergeCursorRemoteMcp(existing: unknown, gatewayUrl: string, token: string): Json` (writes `mcpServers.memorylayer = { url, headers: { Authorization } }`), `codexRemoteMcpToml(gatewayUrl: string, token: string): string`.

- [ ] **Step 1: Write the failing test**

Add to `test/init-configs.test.mjs` (import the two new names at the top of the file):

```javascript
test("mergeCursorRemoteMcp writes an HTTP server with a bearer header", () => {
  const out = mergeCursorRemoteMcp(undefined, "https://gw.example.com", "mlk_x");
  assert.deepEqual(out.mcpServers.memorylayer, {
    url: "https://gw.example.com/mcp",
    headers: { Authorization: "Bearer mlk_x" },
  });
});

test("mergeCursorRemoteMcp preserves unrelated servers and is idempotent", () => {
  const existing = { mcpServers: { other: { url: "x" } } };
  const once = mergeCursorRemoteMcp(existing, "https://gw", "mlk_x");
  const twice = mergeCursorRemoteMcp(once, "https://gw", "mlk_x");
  assert.equal(twice.mcpServers.other.url, "x");
  assert.deepEqual(twice.mcpServers.memorylayer, {
    url: "https://gw/mcp",
    headers: { Authorization: "Bearer mlk_x" },
  });
});

test("codexRemoteMcpToml renders an mcp-remote bridge with the token", () => {
  const toml = codexRemoteMcpToml("https://gw", "mlk_x");
  assert.match(toml, /\[mcp_servers\.memorylayer\]/);
  assert.match(toml, /mcp-remote/);
  assert.match(toml, /https:\/\/gw\/mcp/);
  assert.match(toml, /Authorization: Bearer mlk_x/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A2 "Remote\|remote-mcp\|mcp-remote"`
Expected: FAIL (functions not exported).

- [ ] **Step 3: Implement — append to `src/init-configs.ts`**

```typescript
/**
 * Native HTTP MCP for a hosted member, written into a project's `.cursor/mcp.json`.
 * This file carries the member token, so `init --remote` MUST gitignore it — it is
 * per-member and never committed. Non-clobbering + idempotent on `memorylayer`.
 */
export function mergeCursorRemoteMcp(
  existing: unknown,
  gatewayUrl: string,
  token: string,
): Json {
  const root = asObject(existing);
  const servers = asObject(root.mcpServers);
  servers.memorylayer = {
    url: `${gatewayUrl}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  };
  root.mcpServers = servers;
  return root;
}

/**
 * Manual paste block for Codex MCP (global `~/.codex/config.toml`). Codex has no
 * project-scoped MCP (platform limitation), so the hosted member pastes this;
 * the `mcp-remote` bridge adapts the stdio-only client to the HTTP gateway.
 */
export function codexRemoteMcpToml(gatewayUrl: string, token: string): string {
  return `[mcp_servers.memorylayer]
command = "npx"
args = ["-y", "mcp-remote", "${gatewayUrl}/mcp", "--header", "Authorization: Bearer ${token}"]
`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/init-configs.ts test/init-configs.test.mjs
git commit -m "feat(init): native HTTP MCP config for hosted members (cursor + codex)"
```

---

## Task 3: `buildRemoteHookEnv` — gitignored gateway env file

**Files:**
- Modify: `src/init-env.ts`
- Test: `test/init-env.test.mjs`

**Interfaces:**
- Produces: `buildRemoteHookEnv(v: { gatewayUrl: string; token: string; project: string; author: string; email: string }): string`.

- [ ] **Step 1: Write the failing test**

Add to `test/init-env.test.mjs` (import `buildRemoteHookEnv`):

```javascript
test("buildRemoteHookEnv writes gateway vars and omits CONTEXT_REPO_URL", () => {
  const out = buildRemoteHookEnv({
    gatewayUrl: "https://gw.example.com",
    token: "mlk_x",
    project: "acme-eng",
    author: "Dana Lee",
    email: "dana@acme.com",
  });
  assert.match(out, /MEMORYLAYER_GATEWAY_URL=https:\/\/gw\.example\.com/);
  assert.match(out, /MEMORYLAYER_GATEWAY_TOKEN=mlk_x/);
  assert.match(out, /MEMORYLAYER_PROJECT=acme-eng/);
  assert.match(out, /MEMORYLAYER_AUTHOR=Dana Lee/);
  assert.match(out, /MEMORYLAYER_AUTHOR_EMAIL=dana@acme.com/);
  assert.ok(!/CONTEXT_REPO_URL/.test(out), "hosted-only: no local clone URL");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A2 "buildRemoteHookEnv"`
Expected: FAIL (not exported).

- [ ] **Step 3: Implement — append to `src/init-env.ts`**

```typescript
/** Contents of `.memorylayer-hook.env` for a HOSTED (gateway) member — gitignored. */
export function buildRemoteHookEnv(v: {
  gatewayUrl: string;
  token: string;
  project: string;
  author: string;
  email: string;
}): string {
  return [
    "# MemoryLayer per-user hook config — gitignored. Do NOT commit.",
    "# Written by `wayform init --remote`. Hosted (gateway) member — no local clone.",
    `MEMORYLAYER_GATEWAY_URL=${v.gatewayUrl}`,
    `MEMORYLAYER_GATEWAY_TOKEN=${v.token}`,
    `MEMORYLAYER_PROJECT=${v.project}`,
    `MEMORYLAYER_AUTHOR=${v.author}`,
    `MEMORYLAYER_AUTHOR_EMAIL=${v.email}`,
    "",
  ].join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/init-env.ts test/init-env.test.mjs
git commit -m "feat(init): buildRemoteHookEnv for hosted (gateway-only) members"
```

---

## Task 4: Gateway-only runtime — `loadConfig`, hook guard, metrics guard

The load-bearing change: a member with gateway creds and no `CONTEXT_REPO_URL` must load config, read from the gateway, and never touch a clone.

**Files:**
- Modify: `src/config.ts:167-194` (`loadConfig`), `src/config.ts:14-31` (interface JSDoc)
- Modify: `src/hook.ts:73-76` (guard before `ContextStore`)
- Modify: `src/metrics.ts` (`recordMetric` early return)
- Test: `test/config.test.mjs`, `test/hook.test.mjs`

**Interfaces:**
- Consumes: `Config` (fields `gatewayUrl?`, `gatewayToken?`, `repoUrl`, `repoPath`).
- Produces: gateway-only `loadConfig()` returns `repoUrl === ""` and `repoPath === ""` when a gateway is configured and `CONTEXT_REPO_URL` is absent (empty-string sentinel = "no local clone"). Local-only and both-set behavior unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `test/config.test.mjs`:

```javascript
test("loadConfig: gateway-only mode succeeds without CONTEXT_REPO_URL", () => {
  withEnv(
    {
      MEMORYLAYER_AUTHOR: "Dana",
      MEMORYLAYER_GATEWAY_URL: "https://gw.example.com",
      MEMORYLAYER_GATEWAY_TOKEN: "mlk_x",
    },
    () => {
      const cfg = loadConfig();
      assert.equal(cfg.repoUrl, ""); // sentinel: no local clone
      assert.equal(cfg.repoPath, "");
      assert.equal(cfg.gatewayUrl, "https://gw.example.com");
      assert.equal(cfg.gatewayToken, "mlk_x");
    },
  );
});

test("loadConfig: still throws when neither gateway nor CONTEXT_REPO_URL is set", () => {
  withEnv({ MEMORYLAYER_AUTHOR: "Dana" }, () => {
    assert.throws(() => loadConfig(), /CONTEXT_REPO_URL/);
  });
});

test("loadConfig: gateway + CONTEXT_REPO_URL keeps the local clone path (coexist)", () => {
  withEnv(
    {
      MEMORYLAYER_AUTHOR: "Dana",
      CONTEXT_REPO_URL: "https://github.com/o/r.git",
      MEMORYLAYER_GATEWAY_URL: "https://gw",
      MEMORYLAYER_GATEWAY_TOKEN: "mlk_x",
    },
    () => {
      const cfg = loadConfig();
      assert.equal(cfg.repoUrl, "https://github.com/o/r.git");
      assert.ok(cfg.repoPath.includes("clones"));
    },
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test 2>&1 | grep -A2 "gateway-only"`
Expected: FAIL (currently `required("CONTEXT_REPO_URL")` throws in the gateway-only case).

- [ ] **Step 3: Implement `loadConfig` gateway-only mode**

In `src/config.ts`, update the interface JSDoc for `repoUrl`/`repoPath` and rewrite `loadConfig`:

```typescript
  /** URL of the shared context git repo. Empty string "" = gateway-only (no clone). */
  repoUrl: string;
  /** Local clone path. Empty string "" = gateway-only (no clone). */
  repoPath: string;
```

```typescript
export function loadConfig(): Config {
  const author = required("MEMORYLAYER_AUTHOR");

  const gatewayUrl =
    process.env.MEMORYLAYER_GATEWAY_URL?.trim().replace(/\/+$/, "") || undefined;
  const gatewayToken =
    process.env.MEMORYLAYER_GATEWAY_TOKEN?.trim() || undefined;
  const hasGateway = Boolean(gatewayUrl && gatewayToken);

  // Gateway-only members have no local clone. CONTEXT_REPO_URL is optional when a
  // gateway is configured; without a gateway it stays required (local-only mode).
  // We use "" as a clear "no clone" sentinel rather than making repoUrl/repoPath
  // optional, which would ripple `string | undefined` through store/git-repo/
  // metrics/doctor. The clone is never touched in gateway-only mode — the hook
  // guard (hook.ts) and the metrics guard (metrics.ts) enforce that.
  const repoUrl = hasGateway
    ? process.env.CONTEXT_REPO_URL?.trim() || ""
    : required("CONTEXT_REPO_URL");
  const repoPath = repoUrl
    ? process.env.CONTEXT_REPO_PATH?.trim() ||
      path.join(dataHome(), "clones", cloneKey(repoUrl))
    : "";

  const rawBudget = Number(process.env.MEMORYLAYER_READ_BUDGET_TOKENS);
  const readBudgetTokens =
    Number.isFinite(rawBudget) && rawBudget > 0
      ? rawBudget
      : DEFAULT_BUDGET_TOKENS;

  return {
    repoUrl,
    repoPath,
    author,
    authorEmail:
      process.env.MEMORYLAYER_AUTHOR_EMAIL?.trim() ||
      `${author.replace(/\s+/g, ".").toLowerCase()}@memorylayer.local`,
    autoPush: (process.env.MEMORYLAYER_AUTO_PUSH?.trim() || "true") !== "false",
    readBudgetTokens,
    gatewayUrl,
    gatewayToken,
  };
}
```

- [ ] **Step 4: Add the hook guard**

In `src/hook.ts`, in the local-fallback branch (after `remoteHookRead` returns `null`, before `const store = new ContextStore(cfg);` at line ~74), insert:

```typescript
    // Gateway-only member (no local clone): there is nothing to fall back to.
    // Fail-open to the client's empty no-op rather than constructing a store
    // against an empty repo path.
    if (!cfg.repoUrl) emitEmpty();

    const store = new ContextStore(cfg);
```

- [ ] **Step 5: Add the metrics guard**

In `src/metrics.ts`, at the very top of `recordMetric` (before it references `cfg.repoPath`), add:

```typescript
  // Gateway-only members have no local clone to append metrics to; their reads
  // are logged server-side (retrieval_log). No-op instead of writing a stray
  // metrics/ file into the member's project cwd. (recordMetric is fail-open.)
  if (!cfg.repoPath) return;
```

- [ ] **Step 6: Run the full suite**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS. Existing `hook.test.mjs` fail-open tests still pass (they run with no env → `loadConfig` throws → caught → empty). No new type errors (sentinel keeps `repoUrl`/`repoPath` as `string`).

- [ ] **Step 7: Commit**

```bash
git add src/config.ts src/hook.ts src/metrics.ts test/config.test.mjs
git commit -m "feat(config): gateway-only mode (optional CONTEXT_REPO_URL) with clone guards"
```

---

## Task 5: `registerClaudeCodeMcp` helper (testable shell-out)

Registers the native HTTP MCP for Claude Code via `claude mcp add --scope local`, with an injectable runner so it is unit-testable and non-fatal when the `claude` CLI is absent.

**Files:**
- Create: `src/init-remote.ts`
- Test: `test/init-remote.test.mjs` (new)

**Interfaces:**
- Produces: `type Runner = (cmd: string, args: string[]) => void;` and
  `registerClaudeCodeMcp(gatewayUrl: string, token: string, run?: Runner): { ok: boolean; command: string }` — builds the argv, attempts `run("claude", argv)`, returns `{ ok: true }` on success or `{ ok: false, command }` (a copy-pasteable command string) when the runner throws (e.g. `claude` not installed). Never throws.

- [ ] **Step 1: Write the failing test**

Create `test/init-remote.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerClaudeCodeMcp } from "../dist/init-remote.js";

test("registerClaudeCodeMcp invokes claude mcp add with scope local + bearer header", () => {
  let seen;
  const run = (cmd, args) => {
    seen = { cmd, args };
  };
  const res = registerClaudeCodeMcp("https://gw.example.com", "mlk_x", run);
  assert.equal(res.ok, true);
  assert.equal(seen.cmd, "claude");
  assert.deepEqual(seen.args, [
    "mcp",
    "add",
    "--transport",
    "http",
    "--scope",
    "local",
    "memorylayer",
    "https://gw.example.com/mcp",
    "--header",
    "Authorization: Bearer mlk_x",
  ]);
});

test("registerClaudeCodeMcp fails open to a printable command when claude is absent", () => {
  const run = () => {
    const e = new Error("spawn claude ENOENT");
    e.code = "ENOENT";
    throw e;
  };
  const res = registerClaudeCodeMcp("https://gw", "mlk_x", run);
  assert.equal(res.ok, false);
  assert.match(res.command, /^claude mcp add --transport http --scope local /);
  assert.match(res.command, /Authorization: Bearer mlk_x/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test 2>&1 | grep -A2 "registerClaudeCodeMcp"`
Expected: FAIL (`dist/init-remote.js` does not exist).

- [ ] **Step 3: Implement — create `src/init-remote.ts` (helper only for now)**

```typescript
/**
 * `wayform init --remote` — wire a HOSTED (gateway) member into the current
 * project. Same LOUD, idempotent posture as local `init`, but writes gateway
 * creds + native HTTP MCP instead of a local clone. Token never touches a
 * committed file (gitignored env + gitignored .cursor/mcp.json + Claude's
 * user-scoped ~/.claude.json).
 */
import { execFileSync } from "node:child_process";

export type Runner = (cmd: string, args: string[]) => void;

const defaultRunner: Runner = (cmd, args) =>
  void execFileSync(cmd, args, { stdio: "ignore" });

/**
 * Register the gateway as a project-scoped (`--scope local`) HTTP MCP server for
 * Claude Code. `--scope local` stores config in ~/.claude.json (NOT the repo), so
 * it is project-scoped AND token-safe. Non-fatal: if `claude` is absent the
 * returned command is printed for the member to run by hand.
 */
export function registerClaudeCodeMcp(
  gatewayUrl: string,
  token: string,
  run: Runner = defaultRunner,
): { ok: boolean; command: string } {
  const args = [
    "mcp",
    "add",
    "--transport",
    "http",
    "--scope",
    "local",
    "memorylayer",
    `${gatewayUrl}/mcp`,
    "--header",
    `Authorization: Bearer ${token}`,
  ];
  const command = `claude ${args.join(" ")}`;
  try {
    run("claude", args);
    return { ok: true, command };
  } catch {
    return { ok: false, command };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/init-remote.ts test/init-remote.test.mjs
git commit -m "feat(init): registerClaudeCodeMcp helper (scope local, fail-open)"
```

---

## Task 6: `runInitRemote` orchestration + wire `--remote`

Ties the pieces together: parse flags, write the gitignored env, project hooks (`wayform`), Cursor gitignored MCP, Claude Code MCP via helper, gitignore updates, and printed next steps (incl. Codex snippet). Does NOT write the committed stdio `.mcp.json`.

**Files:**
- Modify: `src/init-remote.ts`
- Modify: `src/init.ts` (delegate on `--remote`)
- Test: covered by the integration test in Task 8; this task adds the orchestration.

**Interfaces:**
- Consumes: `mergeClaudeSettings/mergeCursorHooks/mergeCodexHooks(existing, "wayform")`, `mergeCursorRemoteMcp`, `codexRemoteMcpToml` (Task 1–2), `buildRemoteHookEnv` (Task 3), `registerClaudeCodeMcp` (Task 5), `gitConfigDefault`/`ensureGitignore` (existing `init-env.ts`).
- Produces: `runInitRemote(args: string[]): Promise<void>`.

- [ ] **Step 1: Implement `runInitRemote` — append to `src/init-remote.ts`**

Add the imports and function:

```typescript
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  mergeClaudeSettings,
  mergeCursorHooks,
  mergeCodexHooks,
  mergeCursorRemoteMcp,
  codexRemoteMcpToml,
} from "./init-configs.js";
import {
  buildRemoteHookEnv,
  gitConfigDefault,
  ensureGitignore,
} from "./init-env.js";

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const has = (args: string[], name: string): boolean =>
  args.includes(`--${name}`);

function readJson(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fs.copyFileSync(file, `${file}.bak`);
    console.warn(`! ${file} was not valid JSON — backed up to ${file}.bak.`);
    return undefined;
  }
}

function writeJson(cwd: string, rel: string, data: unknown): void {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  console.log(`  wrote ${rel}`);
}

export async function runInitRemote(args: string[]): Promise<void> {
  const cwd = process.cwd();
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    console.warn(
      "! Not a git repository. Hooks are project-scoped; run this in your project root.",
    );
  }

  const gatewayUrl = (flag(args, "gateway") ?? "").replace(/\/+$/, "");
  const token = flag(args, "token") ?? "";
  if (!gatewayUrl || !token) {
    throw new Error(
      "wayform init --remote requires --gateway <url> and --token <mlk_...>",
    );
  }

  // Identity (attribution/display; the gateway is authoritative on write).
  const useDefaults = has(args, "yes");
  const rl =
    useDefaults || (flag(args, "author") && flag(args, "email"))
      ? undefined
      : readline.createInterface({ input, output });
  const ask = async (q: string, def: string): Promise<string> => {
    if (!rl) return def;
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def;
  };
  const author =
    flag(args, "author") ?? (await ask("Author name", gitConfigDefault("user.name")));
  const email =
    flag(args, "email") ??
    (await ask("Author email", gitConfigDefault("user.email")));
  const project = flag(args, "project") ?? path.basename(cwd);
  rl?.close();

  // --- Project tier: session/Stop hooks calling the `wayform` binary ---
  writeJson(
    cwd,
    ".claude/settings.json",
    mergeClaudeSettings(readJson(path.join(cwd, ".claude/settings.json")), "wayform"),
  );
  writeJson(
    cwd,
    ".cursor/hooks.json",
    mergeCursorHooks(readJson(path.join(cwd, ".cursor/hooks.json")), "wayform"),
  );
  writeJson(
    cwd,
    ".codex/hooks.json",
    mergeCodexHooks(readJson(path.join(cwd, ".codex/hooks.json")), "wayform"),
  );

  // --- Cursor native HTTP MCP (gitignored — carries the token) ---
  writeJson(
    cwd,
    ".cursor/mcp.json",
    mergeCursorRemoteMcp(
      readJson(path.join(cwd, ".cursor/mcp.json")),
      gatewayUrl,
      token,
    ),
  );

  // --- User tier: gitignored gateway env (hosted-only, no CONTEXT_REPO_URL) ---
  const envFile = path.join(cwd, ".memorylayer-hook.env");
  if (fs.existsSync(envFile) && !has(args, "force")) {
    console.log(
      "  .memorylayer-hook.env exists — leaving it (use --force to rewrite).",
    );
  } else {
    fs.writeFileSync(
      envFile,
      buildRemoteHookEnv({ gatewayUrl, token, project, author, email }),
    );
    console.log("  wrote .memorylayer-hook.env (gitignored)");
  }

  // --- Gitignore secrets: env + local settings + the token-bearing cursor mcp ---
  const giPath = path.join(cwd, ".gitignore");
  const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";
  fs.writeFileSync(
    giPath,
    ensureGitignore(gi, [
      ".memorylayer-hook.env",
      ".claude/settings.local.json",
      ".cursor/mcp.json",
    ]),
  );
  console.log("  updated .gitignore");

  // --- Claude Code native HTTP MCP (project-scoped, token in ~/.claude.json) ---
  const claude = registerClaudeCodeMcp(gatewayUrl, token);
  if (claude.ok) {
    console.log("  registered Claude Code MCP (claude mcp add --scope local)");
  } else {
    console.log(
      "  ! Could not run the Claude CLI — register Claude Code MCP by hand:\n",
    );
    console.log(`    ${claude.command}\n`);
  }

  console.log("\nNext steps:");
  console.log("  1. Commit the project hook configs so teammates inherit them:");
  console.log(
    "       git add .claude .cursor/hooks.json .codex .gitignore && git commit -m 'chore: wire Wayform (remote)'",
  );
  console.log(
    "     (.cursor/mcp.json and .memorylayer-hook.env are gitignored — each member runs init --remote.)",
  );
  console.log("  2. Codex users: add this to ~/.codex/config.toml (MCP tools):\n");
  console.log(codexRemoteMcpToml(gatewayUrl, token));
}
```

- [ ] **Step 2: Wire `--remote` into `runInit` (`src/init.ts`)**

At the very top of `runInit` (after the `--help` check), delegate:

```typescript
  if (has(args, "remote")) {
    const { runInitRemote } = await import("./init-remote.js");
    await runInitRemote(args);
    return;
  }
```

Update the `USAGE` string in `src/init.ts` to mention the remote mode:

```
  --remote                hosted member: wire gateway URL+token (see --gateway/--token)
  --gateway <url>         (remote) hosted gateway base URL
  --token <mlk_...>       (remote) member token
```

- [ ] **Step 3: Build and smoke it in a temp repo**

Run:

```bash
npm run build
TMP=$(mktemp -d) && git -C "$TMP" init -q && (cd "$TMP" && node "$OLDPWD/dist/cli.js" init --remote --gateway https://gw.example.com --token mlk_smoke --project demo --author Dana --email dana@acme.com --yes) ; echo "--- env ---"; cat "$TMP/.memorylayer-hook.env"; echo "--- gitignore ---"; cat "$TMP/.gitignore"; ls -a "$TMP"; rm -rf "$TMP"
```

Expected: prints "wrote .memorylayer-hook.env", "wrote .cursor/mcp.json", a Claude CLI line (registered OR fail-open manual command), a Codex snippet; `.memorylayer-hook.env` has the gateway vars and NO `CONTEXT_REPO_URL`; `.gitignore` contains `.cursor/mcp.json`; no committed `.mcp.json` at repo root.

- [ ] **Step 4: Run full suite**

Run: `npm test && npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/init-remote.ts src/init.ts
git commit -m "feat(init): wayform init --remote hosted-member onboarding flow"
```

---

## Task 7: Rename to `wayform` (package + bin alias) and user-facing strings

**Files:**
- Modify: `package.json`
- Modify: `src/cli.ts` (usage strings)
- Modify: `docs/onboarding/self-onboarding.md`
- Test: `test/cli.test.mjs`

**Interfaces:**
- Produces: installable `wayform` binary; `memorylayer` retained as a transitional alias.

- [ ] **Step 1: Update `package.json`**

Set the package name and both bin entries (preserve all other fields, including `version`, `scripts`, `type`, `files`, `prepare`/`build`):

```json
  "name": "wayform",
  "bin": {
    "wayform": "dist/cli.js",
    "memorylayer": "dist/cli.js"
  },
```

- [ ] **Step 2: Update the CLI usage strings (`src/cli.ts`)**

Update the header comment and the unknown-command error to name `wayform`:

```typescript
      console.error(
        `Unknown command "${sub}". Use: wayform [hook|stop-review|init|doctor] …`,
      );
```

- [ ] **Step 3: Verify the CLI still runs under both names**

Run:

```bash
npm run build
node dist/cli.js --help >/dev/null 2>&1; echo "cli runs: $?"
node dist/cli.js init --help 2>&1 | grep -q -- "--remote" && echo "remote help present"
```

Expected: `cli runs: 0` (or the tool's help exit code — no crash) and `remote help present`.

- [ ] **Step 4: Ensure `test/cli.test.mjs` reflects the new usage string**

If `test/cli.test.mjs` asserts the unknown-command message contains `memorylayer`, update that assertion to `wayform`. Run the targeted test:

Run: `npm test 2>&1 | grep -Ei "cli|unknown command"`
Expected: PASS.

- [ ] **Step 5: Document the remote path in `docs/onboarding/self-onboarding.md`**

Under the Claude Code client-setup section, add a short note:

```markdown
### Hosted member, one command (wayform init --remote)

Once `wayform` is installed (`npm install -g wayform`), a hosted member wires up
their project in one step (no git clone, token stays out of git):

    wayform init --remote --gateway <gateway-url> --token mlk_THEIR_TOKEN

This writes the gitignored gateway env + `wayform` session/Stop hooks, registers
project-scoped Claude Code MCP (`claude mcp add --scope local`) and a gitignored
`.cursor/mcp.json`, and prints the Codex snippet (Codex MCP is global-only).
```

- [ ] **Step 6: Run full suite + format**

Run: `npm test && npm run typecheck && npm run lint && npm run format:check`
Expected: PASS. (If `format:check` fails, run `npm run format` and re-commit.)

- [ ] **Step 7: Commit**

```bash
git add package.json src/cli.ts docs/onboarding/self-onboarding.md test/cli.test.mjs
git commit -m "chore: rename package/bin to wayform (memorylayer alias retained)"
```

---

## Task 8: Integration tests — gateway-only hook injection + init --remote artifacts

**Files:**
- Modify: `test/integration.test.mjs`

**Interfaces:**
- Consumes: built `dist/cli.js`, `dist/hook.js`; Task 4 (gateway-only runtime) and Task 6 (`init --remote`).

- [ ] **Step 1: Write the failing integration tests**

Add to `test/integration.test.mjs` (reuse its existing imports: `node:test`, `assert`, `node:child_process` `execFileSync`, `node:http`, `node:fs`, `node:path`, `node:os`, `fileURLToPath`; add any missing):

```javascript
import http from "node:http";

const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const hookJs = fileURLToPath(new URL("../dist/hook.js", import.meta.url));

test("gateway-only hook injects the gateway's /hook/read text (no clone)", async () => {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith("/hook/read")) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("SHARED MEMORY FROM GATEWAY");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try {
    const out = execFileSync(process.execPath, [hookJs], {
      input: "",
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        MEMORYLAYER_HOOK_CLIENT: "raw",
        MEMORYLAYER_AUTHOR: "Dana",
        MEMORYLAYER_PROJECT: "acme-eng",
        MEMORYLAYER_GATEWAY_URL: `http://127.0.0.1:${port}`,
        MEMORYLAYER_GATEWAY_TOKEN: "mlk_x",
        // deliberately NO CONTEXT_REPO_URL — hosted-only member
      },
    });
    assert.match(out, /SHARED MEMORY FROM GATEWAY/);
  } finally {
    server.close();
  }
});

test("gateway-only hook fails open (no clone, unreachable gateway) and writes no stray files", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-gwonly-"));
  try {
    const out = execFileSync(process.execPath, [hookJs], {
      cwd,
      input: "",
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        MEMORYLAYER_HOOK_CLIENT: "claude-code",
        MEMORYLAYER_AUTHOR: "Dana",
        MEMORYLAYER_PROJECT: "acme-eng",
        MEMORYLAYER_GATEWAY_URL: "http://127.0.0.1:1",
        MEMORYLAYER_GATEWAY_TOKEN: "mlk_unreachable",
      },
    });
    assert.equal(out.trim(), "{}"); // empty no-op, exit 0
    assert.ok(!fs.existsSync(path.join(cwd, "metrics")), "no stray metrics dir");
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("init --remote writes hosted config set, gitignores the token file, no committed .mcp.json", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ml-initremote-"));
  execFileSync("git", ["init", "-q"], { cwd });
  try {
    execFileSync(
      process.execPath,
      [
        cliPath, "init", "--remote",
        "--gateway", "https://gw.example.com",
        "--token", "mlk_x",
        "--project", "acme-eng",
        "--author", "Dana", "--email", "dana@acme.com", "--yes",
      ],
      { cwd, encoding: "utf8" }, // claude CLI absent in CI → helper fails open, init still completes
    );

    const env = fs.readFileSync(path.join(cwd, ".memorylayer-hook.env"), "utf8");
    assert.match(env, /MEMORYLAYER_GATEWAY_URL=https:\/\/gw\.example\.com/);
    assert.match(env, /MEMORYLAYER_GATEWAY_TOKEN=mlk_x/);
    assert.ok(!/CONTEXT_REPO_URL/.test(env));

    const cursorMcp = JSON.parse(
      fs.readFileSync(path.join(cwd, ".cursor/mcp.json"), "utf8"),
    );
    assert.equal(cursorMcp.mcpServers.memorylayer.url, "https://gw.example.com/mcp");
    assert.equal(
      cursorMcp.mcpServers.memorylayer.headers.Authorization,
      "Bearer mlk_x",
    );

    const claude = JSON.parse(
      fs.readFileSync(path.join(cwd, ".claude/settings.json"), "utf8"),
    );
    assert.equal(
      claude.hooks.SessionStart[0].hooks[0].command,
      "wayform hook claude-code",
    );

    const gi = fs.readFileSync(path.join(cwd, ".gitignore"), "utf8");
    assert.match(gi, /^\.cursor\/mcp\.json$/m);
    assert.match(gi, /^\.memorylayer-hook\.env$/m);

    assert.ok(
      !fs.existsSync(path.join(cwd, ".mcp.json")),
      "hosted members do not get the committed stdio .mcp.json",
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run to verify they pass**

Run: `npm test 2>&1 | grep -Ei "gateway-only|init --remote"`
Expected: PASS (requires Tasks 4 and 6 built into `dist/`).

- [ ] **Step 3: Full green gate**

Run: `npm test && npm run typecheck && npm run lint && npm run format:check`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add test/integration.test.mjs
git commit -m "test(integration): gateway-only hook injection + init --remote artifacts"
```

---

## Self-Review

**Spec coverage:**
- §1 command surface (`init --remote`, flags) → Task 6 (+ usage in Task 7). ✓
- §2 user-tier gitignored env (no `CONTEXT_REPO_URL`) → Task 3 + Task 6; project hooks calling `wayform` → Task 1 + Task 6; MCP registration (Claude `--scope local`, gitignored Cursor, Codex snippet) → Task 2 + Task 5 + Task 6; gitignore incl. `.cursor/mcp.json` → Task 6; no committed `.mcp.json` → Task 6 + asserted Task 8. ✓
- §3 `loadConfig` gateway-only + clone guards → Task 4. ✓
- §4 runtime flow (inject on success, fail-open on unreachable) → Task 4 logic + Task 8 integration. ✓
- §5 per-client MCP detail → Tasks 2, 5, 6. ✓
- §6 tests (unit mergers, gitignore, loadConfig both directions; integration inject + fail-open) → Tasks 1–5 unit + Task 8 integration. ✓
- §7 out-of-scope respected (no stdio server for hosted, no Plan C, no env/space rename) — the plan touches none of them; bin rename is in-scope per the recorded decision and handled non-breakingly (Task 7). ✓
- Global constraint: public npm name `wayform` + `memorylayer` alias → Task 7. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code; commands have expected output. ✓

**Type consistency:** `registerClaudeCodeMcp(gatewayUrl, token, run?) => {ok, command}`, `Runner = (cmd, args) => void`, `runInitRemote(args) => Promise<void>`, `buildRemoteHookEnv({gatewayUrl, token, project, author, email})`, `mergeCursorRemoteMcp(existing, gatewayUrl, token)`, `codexRemoteMcpToml(gatewayUrl, token)`, mergers `(existing, bin?)` — names/signatures match across Tasks 1–8. The `repoUrl`/`repoPath` sentinel stays typed `string`, so no downstream `string | undefined` errors. ✓

**Note on `git-repo.ts` / `store.ts`:** unchanged — they still receive `string` (the `""` sentinel) and are only constructed on the local path, which the Task 4 hook guard prevents in gateway-only mode.
