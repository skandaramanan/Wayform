# Per-Space Clone Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every distinct memory repo its own collision-proof local clone under an XDG data dir, and make each clone self-correct its `origin`, so multiple spaces on one machine can never share or freeze a clone (the confirmed cross-space leak).

**Architecture:** Two surgical changes. (1) `src/config.ts` derives `repoPath` from a hash of the normalized `CONTEXT_REPO_URL` under an XDG-resolved base dir, instead of one shared hardcoded path. (2) `src/git-repo.ts` `ensure()` reconciles `origin` to the configured `repoUrl` on every run. Then a one-time operational cleanup migrates this machine to XDG and purges the existing leak.

**Tech Stack:** TypeScript (ESM, compiled to `dist/` via `tsc`), `simple-git`, Node built-in `node:test` + `node:assert/strict`, `node:crypto`. Zero new dependencies.

## Global Constraints

- **Zero new runtime dependencies** — use `node:crypto` only (repo precedent).
- **Tests import from `../dist/*.js`** (compiled output), not `../src`. Run order: build first, then `node --test`.
- **All 87 existing tests stay green.** New tests are additive except the one existing `repoPath` test, which is intentionally rewritten for the new behavior (Task 2).
- **ESM** — `import`/`export`, `.js` extensions on relative imports in `src`.
- **`CONTEXT_REPO_PATH` remains an explicit per-repo override** that wins over all derivation (back-compat + test escape hatch).
- **No `~/.memorylayer` path is ever produced** by the new code (XDG-only).
- Full-suite command: `npm test` (runs `npm run build && node --test test/*.test.mjs`). Single file: `npm run build && node --test test/<file>.test.mjs`.

---

### Task 1: URL normalization + clone key (pure functions)

**Files:**
- Modify: `src/config.ts` (add `import crypto from "node:crypto";` and two exported functions)
- Test: `test/config.test.mjs` (add cases)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `export function normalizeRepoUrl(url: string): string` — host+path, lowercased, no credentials, no trailing `.git`/slashes.
  - `export function cloneKey(repoUrl: string): string` — `<slug>-<hash8>`, filesystem-safe, deterministic per normalized URL.

- [ ] **Step 1: Write the failing tests**

Add to `test/config.test.mjs`. Add the import at the top alongside the existing import:

```js
import { loadConfig, loadHookEnv, normalizeRepoUrl, cloneKey } from "../dist/config.js";
```

Append these tests:

```js
test("normalizeRepoUrl strips credentials, .git, and case", () => {
  const bare = "github.com/skandaramanan/testmem";
  assert.equal(
    normalizeRepoUrl("https://github.com/skandaramanan/testmem.git"),
    bare,
  );
  assert.equal(
    normalizeRepoUrl("https://x-access-token:SECRET@github.com/skandaramanan/testmem.git"),
    bare,
  );
  assert.equal(
    normalizeRepoUrl("https://github.com/skandaramanan/testmem/"),
    bare,
  );
  assert.equal(
    normalizeRepoUrl("git@github.com:skandaramanan/testmem.git"),
    bare,
  );
});

test("cloneKey is deterministic, slug+hash shaped, and token-free", () => {
  const withToken = cloneKey("https://TOKEN@github.com/skandaramanan/testmem.git");
  const without = cloneKey("https://github.com/skandaramanan/testmem");
  assert.equal(withToken, without); // token/.git variance collapses to one key
  assert.match(withToken, /^testmem-[0-9a-f]{8}$/);
  assert.ok(!withToken.includes("TOKEN"));
});

test("cloneKey differs for different repos", () => {
  assert.notEqual(
    cloneKey("https://github.com/o/testmem.git"),
    cloneKey("https://github.com/o/memorylayer-memory.git"),
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/config.test.mjs`
Expected: build succeeds; the three new tests FAIL (`normalizeRepoUrl is not a function` / `cloneKey is not a function`).

- [ ] **Step 3: Implement the functions in `src/config.ts`**

Add near the top, after the existing imports (`import fs from "node:fs";`):

```ts
import crypto from "node:crypto";
```

Add these exported functions (place them above `loadConfig`):

```ts
/**
 * Normalize a git remote URL to a stable identity: host+path only, lowercased,
 * credentials/token dropped, no trailing `.git` or slashes. So the same repo via
 * token-embedded HTTPS, bare HTTPS, or SSH maps to ONE identity — and a rotated
 * token never changes it (nor leaks into a derived directory name).
 */
export function normalizeRepoUrl(url: string): string {
  let s = url.trim();
  const scp = /^[^/@]+@([^:/]+):(.+)$/.exec(s); // git@host:org/repo(.git)
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    try {
      const u = new URL(s);
      s = `${u.host}${u.pathname}`; // u.host excludes userinfo → token dropped
    } catch {
      // Not a parseable URL (e.g. a bare test token); fall through with s as-is.
    }
  }
  return s
    .toLowerCase()
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
}

/**
 * Filesystem-safe, collision-proof directory key for a repo's local clone:
 * `<repo-name-slug>-<hash8>`. The readable prefix aids humans browsing the
 * clones dir; the hash of the normalized URL guarantees uniqueness even when two
 * repo names slugify identically.
 */
export function cloneKey(repoUrl: string): string {
  const normalized = normalizeRepoUrl(repoUrl);
  const hash = crypto
    .createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 8);
  const lastSeg = normalized.split("/").pop() || "repo";
  const slug =
    lastSeg.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
  return `${slug}-${hash}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/config.test.mjs`
Expected: all config tests PASS (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.mjs
git commit -m "feat(clone-isolation): normalizeRepoUrl + cloneKey"
```

---

### Task 2: XDG base dir + keyed `repoPath` in `loadConfig`

**Files:**
- Modify: `src/config.ts` (add `dataHome()`; rework `repoPath` derivation in `loadConfig`)
- Test: `test/config.test.mjs` (rewrite the existing repoPath test; add base-dir tests; extend env-cleanup list)

**Interfaces:**
- Consumes: `cloneKey` (Task 1).
- Produces: `loadConfig().repoPath` now equals `<base>/clones/<cloneKey(repoUrl)>` when `CONTEXT_REPO_PATH` is unset, where `<base>` resolves `MEMORYLAYER_HOME` → `$XDG_DATA_HOME/memorylayer` → `~/.local/share/memorylayer`.

- [ ] **Step 1: Update the env-cleanup list and rewrite the failing tests**

In `test/config.test.mjs`, extend the `MEMORYLAYER_VARS` array so the new base-dir env vars are isolated per-test:

```js
const MEMORYLAYER_VARS = [
  "CONTEXT_REPO_URL",
  "CONTEXT_REPO_PATH",
  "MEMORYLAYER_AUTHOR",
  "MEMORYLAYER_AUTHOR_EMAIL",
  "MEMORYLAYER_AUTO_PUSH",
  "MEMORYLAYER_READ_BUDGET_TOKENS",
  "MEMORYLAYER_HOME",
  "XDG_DATA_HOME",
];
```

Replace the existing test `"repoPath defaults under ~/.memorylayer and honors CONTEXT_REPO_PATH"` (currently asserting `~/.memorylayer/context-store`) with:

```js
test("repoPath is a keyed clone under the XDG data dir, honors CONTEXT_REPO_PATH", () => {
  withEnv(
    {
      MEMORYLAYER_AUTHOR: "S",
      CONTEXT_REPO_URL: "https://github.com/skandaramanan/testmem.git",
    },
    () => {
      assert.equal(
        loadConfig().repoPath,
        path.join(
          os.homedir(),
          ".local",
          "share",
          "memorylayer",
          "clones",
          cloneKey("https://github.com/skandaramanan/testmem.git"),
        ),
      );
    },
  );
  withEnv(
    {
      MEMORYLAYER_AUTHOR: "S",
      CONTEXT_REPO_URL: "u",
      CONTEXT_REPO_PATH: "/tmp/store",
    },
    () => {
      assert.equal(loadConfig().repoPath, "/tmp/store");
    },
  );
});

test("repoPath base dir resolves MEMORYLAYER_HOME > XDG_DATA_HOME > ~/.local/share", () => {
  const url = "https://github.com/o/r.git";
  withEnv(
    { MEMORYLAYER_AUTHOR: "S", CONTEXT_REPO_URL: url, MEMORYLAYER_HOME: "/custom/ml" },
    () => {
      assert.equal(
        loadConfig().repoPath,
        path.join("/custom/ml", "clones", cloneKey(url)),
      );
    },
  );
  withEnv(
    { MEMORYLAYER_AUTHOR: "S", CONTEXT_REPO_URL: url, XDG_DATA_HOME: "/xdg" },
    () => {
      assert.equal(
        loadConfig().repoPath,
        path.join("/xdg", "memorylayer", "clones", cloneKey(url)),
      );
    },
  );
});

test("repoPath never produces a legacy ~/.memorylayer path", () => {
  withEnv(
    { MEMORYLAYER_AUTHOR: "S", CONTEXT_REPO_URL: "https://github.com/o/r.git" },
    () => {
      assert.ok(!loadConfig().repoPath.includes(path.join(".memorylayer")));
    },
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/config.test.mjs`
Expected: the rewritten/added repoPath tests FAIL (current code still returns `~/.memorylayer/context-store`).

- [ ] **Step 3: Implement in `src/config.ts`**

Add this helper above `loadConfig` (near `cloneKey`):

```ts
/**
 * Base directory for MemoryLayer's local state, XDG-compliant. Clones live in
 * the DATA bucket (not cache): a clone can transiently hold unpushed commits
 * (the offline / selfHealPush path), so it must survive cache cleaners.
 * Resolution: MEMORYLAYER_HOME > $XDG_DATA_HOME/memorylayer > ~/.local/share/memorylayer.
 */
function dataHome(): string {
  const explicit = process.env.MEMORYLAYER_HOME?.trim();
  if (explicit) return explicit;
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return path.join(xdg, "memorylayer");
  return path.join(os.homedir(), ".local", "share", "memorylayer");
}
```

In `loadConfig`, hoist `repoUrl` and derive `repoPath` from it. Replace the current opening of `loadConfig` (the `author`/`repoPath` block, `src/config.ts:89-93`) with:

```ts
export function loadConfig(): Config {
  const author = required("MEMORYLAYER_AUTHOR");
  const repoUrl = required("CONTEXT_REPO_URL");
  const repoPath =
    process.env.CONTEXT_REPO_PATH?.trim() ||
    path.join(dataHome(), "clones", cloneKey(repoUrl));
```

Then in the returned object, replace `repoUrl: required("CONTEXT_REPO_URL"),` with just `repoUrl,` (it is now a hoisted const). Leave every other field unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/config.test.mjs`
Expected: all config tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts test/config.test.mjs
git commit -m "feat(clone-isolation): key repoPath by URL under XDG data dir"
```

---

### Task 3: Reconcile `origin` in `GitRepo.ensure()`

**Files:**
- Modify: `src/git-repo.ts:22-33` (`ensure()`)
- Test: `test/git-repo.test.mjs` (new file)

**Interfaces:**
- Consumes: `GitRepo` from `../dist/git-repo.js`, `Config` shape (repoUrl/repoPath/author/authorEmail/autoPush).
- Produces: after `ensure()`, the clone's `origin` URL always equals `cfg.repoUrl`.

- [ ] **Step 1: Write the failing test**

Create `test/git-repo.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitRepo } from "../dist/git-repo.js";

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

/** A fresh bare repo seeded with one commit on main. Returns its path. */
function bareRepo(tmp, name) {
  const bare = path.join(tmp, name);
  git(tmp, "init", "--bare", "--initial-branch=main", bare);
  const seed = path.join(tmp, `${name}-seed`);
  git(tmp, "clone", bare, seed);
  fs.writeFileSync(path.join(seed, "README.md"), name);
  git(seed, "add", ".");
  git(seed, "-c", "user.email=s@x", "-c", "user.name=seed", "commit", "-m", "init");
  git(seed, "push", "origin", "main");
  return bare;
}

function cfg(repoUrl, repoPath) {
  return {
    repoUrl,
    repoPath,
    author: "Alice",
    authorEmail: "alice@memorylayer.local",
    autoPush: true,
    readBudgetTokens: 4000,
  };
}

const originUrl = (repoPath) => git(repoPath, "remote", "get-url", "origin");

test("ensure() sets origin to repoUrl on a fresh clone", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-gr-"));
  try {
    const a = bareRepo(tmp, "a.git");
    const clone = path.join(tmp, "clone");
    await new GitRepo(cfg(a, clone)).ensure();
    assert.equal(originUrl(clone), a);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("ensure() re-points a mis-targeted existing clone to the configured repoUrl", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-gr-"));
  try {
    const a = bareRepo(tmp, "a.git");
    const b = bareRepo(tmp, "b.git");
    const clone = path.join(tmp, "clone");
    // First run clones A → origin points at A.
    await new GitRepo(cfg(a, clone)).ensure();
    assert.equal(originUrl(clone), a);
    // Second run at the SAME path but configured for B → origin must become B.
    await new GitRepo(cfg(b, clone)).ensure();
    assert.equal(originUrl(clone), b);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/git-repo.test.mjs`
Expected: the "re-points" test FAILS (origin stays at A — current `ensure()` never reconciles).

- [ ] **Step 3: Implement the reconcile in `src/git-repo.ts`**

Replace the body of `ensure()` (`src/git-repo.ts:22-33`) with:

```ts
  async ensure(): Promise<void> {
    const { repoPath, repoUrl, author, authorEmail } = this.cfg;

    if (!existsSync(path.join(repoPath, ".git"))) {
      await fs.mkdir(path.dirname(repoPath), { recursive: true });
      await simpleGit().clone(repoUrl, repoPath);
    }

    this.git = simpleGit(repoPath);
    // Reconcile origin to the configured repoUrl every run: declared config is
    // the source of truth, so a mis-pointed clone (e.g. a shared path from an
    // older layout) or a rotated token self-corrects here instead of silently
    // pushing to the wrong remote.
    await this.git.remote(["set-url", "origin", repoUrl]);
    await this.git.addConfig("user.name", author);
    await this.git.addConfig("user.email", authorEmail);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/git-repo.test.mjs`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/git-repo.ts test/git-repo.test.mjs
git commit -m "feat(clone-isolation): reconcile origin to repoUrl in ensure()"
```

---

### Task 4: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the entire suite**

Run: `npm test`
Expected: build clean; **all tests PASS** (87 prior + 3 config normalization/key + 3 config repoPath/base-dir + 2 git-repo = ~95). No failures.

- [ ] **Step 2: Lint + format check**

Run: `npm run lint && npm run format:check`
Expected: clean (no errors). If `format:check` flags the new code, run `npm run format` and amend the last commit.

- [ ] **Step 3: Confirm no legacy path remains in source**

Run: `grep -rn "\.memorylayer/context-store\|\"context-store\"" src/ || echo "clean"`
Expected: `clean` (the hardcoded shared default is fully gone from `src/`).

---

### Task 5: One-time machine cleanup + XDG migration (operational)

**Not code.** Touches real remotes and this machine's state — run in the main session, with the user, after Tasks 1–4 land. Order preserves the pending metrics before anything is deleted.

- [ ] **Step 1: Preserve the pending memorylayer metrics** (the uncommitted `metrics/skanda.jsonl` belongs to the memorylayer space = MemoryLayer-Memory):

```bash
git -C ~/.memorylayer/context-store add metrics/skanda.jsonl
git -C ~/.memorylayer/context-store commit -m "metrics: sync skanda" || echo "(nothing to commit)"
git -C ~/.memorylayer/context-store push origin main
```

- [ ] **Step 2: Purge the leaked Lyrebird space from MemoryLayer-Memory** (discard, per decision):

```bash
git -C ~/.memorylayer/context-store rm -r context/lyrebird-takehome
git -C ~/.memorylayer/context-store commit -m "chore: remove cross-space leaked lyrebird-takehome data"
git -C ~/.memorylayer/context-store push origin main
```

- [ ] **Step 3: Migrate to XDG — remove the entire legacy dir** (its only content was the now-synced/purged shared clone):

```bash
rm -rf ~/.memorylayer
```

- [ ] **Step 4: Verify re-homing under XDG.** Trigger a read/write in each project (or run the hook) so the new code clones fresh, then confirm isolation:

```bash
ls ~/.local/share/memorylayer/clones/
# For each keyed clone, origin must match that space's CONTEXT_REPO_URL:
for d in ~/.local/share/memorylayer/clones/*/; do
  echo "$d -> $(git -C "$d" remote get-url origin)"
done
```

Expected: one folder per space; the memorylayer clone's origin is MemoryLayer-Memory, the Lyrebird clone's origin is testmem, and neither contains the other's `context/<project>/` dir.

---

## Notes

- The Lyrebird `.memorylayer-hook.env` (identity/URL) and all `.claude`/`.cursor`/`.codex`/`.mcp.json` configs are unchanged — scoping is already project-local; only the clone location/target changes.
- `dist/` is committed in this repo (git-install requirement); the final commit before any push must include the rebuilt `dist/`.
