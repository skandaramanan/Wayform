# Per-Space Clone Isolation — Design Spec

**Context:** Enforces the ratified "one private repo per space" isolation
(see shared-store decision 2026-07-04T07:26:44) at the **local Tier-0** layer,
which currently breaks it.

## Problem

Every space on a machine collapses into one shared local clone, and that
clone's remote is frozen to whichever space ran first.

1. `loadConfig()` derives `repoPath` from a single hardcoded default whenever
   `CONTEXT_REPO_PATH` is unset — which it always is for normal users
   (`src/config.ts:91-93`):

   ```ts
   const repoPath =
     process.env.CONTEXT_REPO_PATH?.trim() ||
     path.join(os.homedir(), ".memorylayer", "context-store");
   ```

   So *every* space points at `~/.memorylayer/context-store`, regardless of its
   configured `CONTEXT_REPO_URL`.

2. `GitRepo.ensure()` clones only when `.git` is absent and **never reconciles
   `origin`** (`src/git-repo.ts:22-33`). The first space to run clones its repo
   there and locks that folder's `origin`. Later spaces find `.git` already
   present, skip the clone, and inherit the stale `origin`. `push()`/`pull()`
   hardcode `origin`, so all reads/writes/pushes for every later space go to the
   **wrong remote**.

**This is a confirmed cross-space leak, not a theoretical one.** On this
machine, `~/.memorylayer/context-store` has `origin → MemoryLayer-Memory` yet
contains both `context/memorylayer/` *and* `context/lyrebird-takehome/` — the
Lyrebird space (configured for `testmem`) has been writing into the
MemoryLayer-Memory repo. For a **team** product this means one team's memory
landing in another team's repo. It must be airtight.

**Non-goal / already correct:** MCP and hook registration are already written
**project-scoped** by `init` for Claude Code (`.claude/settings.json`,
`.mcp.json`) and Cursor (`.cursor/hooks.json`, `.cursor/mcp.json`). The only
global artifact is Codex MCP (`~/.codex/config.toml`), which is a Codex platform
limitation (no project-scoped MCP) and not configured on this machine. The
global `memorylayer` binary is just the executable; it self-loads each project's
`.memorylayer-hook.env` from cwd, so it is not a leak. **No config-scoping change
is needed** — the entire bug is the clone path.

## Approach

Two surgical code changes, both isolation-by-construction:

### 1. Key the default clone directory by the remote URL

When `CONTEXT_REPO_PATH` is not explicitly set, derive a per-repo path instead
of the shared default:

```
~/.memorylayer/clones/<key>/
```

where `<key> = <repo-name-slug>-<hash8>`, e.g. `testmem-a1b2c3d4e5`. The
readable prefix aids humans inspecting `~/.memorylayer/clones/`; the hash
guarantees uniqueness and filesystem-safety.

Two different `CONTEXT_REPO_URL`s therefore get two different directories and can
never share — or freeze — a folder. Explicit `CONTEXT_REPO_PATH` still wins
(back-compat + the escape hatch tests rely on).

**URL normalization** (so the key is stable across cosmetic variations and,
critically, across token rotation — we must not mint a new clone every time a
token changes, nor write the token into a folder name):

`normalizeRepoUrl(url)`:
1. Trim.
2. Convert scp-style SSH (`git@host:org/repo.git`) to `host/org/repo`.
3. Otherwise parse as a URL and take `host + pathname`, **dropping any userinfo**
   (so `https://x-access-token:TOKEN@github.com/o/r` → `github.com/o/r`).
4. Lowercase; strip a trailing `.git` and any trailing/leading slashes.

Key = `slug(lastPathSegment) + "-" + sha256(normalized).slice(0, 8)`, using
`node:crypto` (zero new dependencies). Same repo via HTTPS-with-token,
HTTPS-without, or trailing-`.git` → same key. Different repos → different keys.

### 2. Reconcile `origin` in `ensure()`

After the clone-if-absent step, always point `origin` at the configured
`repoUrl`:

```ts
await this.git.remote(["set-url", "origin", repoUrl]);
```

Rationale — `repoUrl` (from config) is the declared source of truth, so the
clone should always target where config says. This is idempotent when already
correct, **applies a rotated token** on the next run, and **self-corrects any
mis-pointed clone** (including the current broken shared folder, and any
pre-existing folder at a keyed path). Defense-in-depth: even if two spaces were
forced to share a path via explicit `CONTEXT_REPO_PATH`, each session
deterministically retargets `origin` to its own configured repo before pulling
or pushing. (Deliberately sharing one `CONTEXT_REPO_PATH` across two different
URLs is user error we don't otherwise support; with keyed paths as the default
it can't arise.)

## One-time cleanup on this machine (operational, not shipped code)

Performed once, with the user, after the code lands. Order matters so nothing is
lost:

1. **Preserve pending memorylayer metrics.** The shared clone has an uncommitted
   `metrics/skanda.jsonl`; that data belongs to the memorylayer space
   (MemoryLayer-Memory). Commit + push it to MemoryLayer-Memory first.
2. **Purge the leak.** `git rm -r context/lyrebird-takehome/` in
   MemoryLayer-Memory, commit, push. (User's call: discard, not migrate —
   Lyrebird starts fresh in testmem.)
3. **Remove the stale shared clone** `~/.memorylayer/context-store`.
4. **Verify re-homing.** On the next session in each repo, the keyed-clone code
   clones fresh: memorylayer → its keyed dir from MemoryLayer-Memory; Lyrebird →
   its keyed dir from testmem (fresh/empty). Confirm each keyed clone's `origin`
   matches its configured `CONTEXT_REPO_URL`.

No general-purpose migration command is built (scope discipline — the venture
guardrail). The old shared path is simply abandoned by the new default.

## Files touched

- `src/config.ts` — add `normalizeRepoUrl` + `cloneKey`; change the `repoPath`
  fallback to `~/.memorylayer/clones/<key>` derived from `repoUrl`. Import
  `node:crypto`.
- `src/git-repo.ts` — in `ensure()`, add the `remote set-url origin` reconcile
  after the clone-if-absent block.

Everything downstream (`store.ts`, `hook.ts`, `index.ts`, per-space `context/`
namespacing) is unchanged — this only changes *which folder* a space's clone
lives in and *where its `origin` points*.

## Testing (TDD)

New/changed unit + integration tests; all 87 existing tests stay green.

**`config.ts` (unit):**
- Distinct `CONTEXT_REPO_URL`s → distinct `repoPath`s.
- Cosmetic variants of the same repo → identical `repoPath`:
  token-embedded vs bare, trailing `.git` vs not, SSH vs HTTPS host+path.
- Userinfo/token never appears in the derived path.
- Explicit `CONTEXT_REPO_PATH` overrides the derivation.

**`git-repo.ts` (integration, against local bare repos):**
- Fresh clone into a keyed path → `origin` == `repoUrl`.
- Pre-existing clone whose `origin` points at repo A, config says repo B →
  after `ensure()`, `origin` == B (reconcile fixes the mis-point).
- Already-correct `origin` → `ensure()` is a no-op on the remote (idempotent).

## Out of scope

- Hosted GitHub-App storage plane (separate roadmap).
- SQLite index / graph retrieval (gated on reliance-test data).
- Any `memorylayer migrate`/`doctor` command.
- Codex's global MCP registration (platform limitation, not a leak).
