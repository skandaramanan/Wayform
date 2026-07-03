# MemoryLayer `init` Installer — Design

Date: 2026-07-02
Status: Approved (ready for implementation planning)
Phase: 0.5 (frictionless onboarding for the 4-week reliance test — no remote infra)

## Problem

Today MemoryLayer only runs if you have cloned this repo and built it: the hooks call
`bash ./hooks/session-start.sh`, which sources `.memorylayer-hook.env` and runs
`node dist/hook.js` — all relative to a local clone. For the 4-week reliance test (SoT §8,
Phase 1), collaborators will not work inside the MemoryLayer repo; they will work inside
**their own shared project repo** and need MemoryLayer wired into *that*. The current path
forces each collaborator to clone a second repo, build it, and hand-wire per-client hooks +
MCP registration. That setup friction is a real barrier to even starting the test, and
"no signal without 2 committed humans" is a recorded open risk (SoT §9).

This is **setup** friction (one-time onboarding), which has zero signal value and is safe to
remove. It is distinct from **usage/reliance** friction (does the model reliably read/write),
which is exactly what the 4-week test measures and must NOT be automated away pre-signal. The
installer attacks only the former.

## Goal

One command that a collaborator runs inside their project to get the full local MemoryLayer
loop — guaranteed session-start read, per-turn Stop write-review, `/remember`, and the MCP
tools — with no clone, no manual per-client wiring, and no remote server. Keep git-as-auth and
local hooks intact; do not touch the neutral core or the reliability mechanics under test.

Non-goals (scope creep is the documented #1 failure mode): no Claude Desktop path (MCP-only,
global config — documented manual fallback); no remote/hosted anything; no auto-creation of the
context repo; no metrics (separate sequenced workstream).

## Settled decisions (from brainstorming, 2026-07-02)

- **Distribution: private GitHub repo install, NOT `npm publish`.** `npm install -g
  github:skandaramanan/MemoryLayer`. Reuses git-as-auth (collaborators already need GitHub
  access to the private *memory* repo; the private *code* repo is the same gate), keeps the
  tool code private and unindexed (nothing on the npm registry, nothing in npm search), and is
  free. Rejected: public npm (code public); private npm scoped package (paid plan + every
  collaborator needs an npm account + `npm login` — more friction than removed). Reversible: a
  one-time `npm publish` later if the test succeeds, no rewrite.
- **Invocation: global install, then `init`.** Hooks call the fast local `memorylayer` command,
  not `npx github:…` per invocation. The Stop hook fires every turn; resolving a GitHub repo
  each turn would add latency and fail offline — and a failing hook fail-opens, silently losing
  writes (the exact reliability under test). The one-time global install buys a fast,
  offline-safe command.
- **Client scope: the three hook-capable clients only (Claude Code, Cursor, Codex).** Symmetric,
  project-scoped, delivers the full guaranteed-read + write-review loop. Desktop excluded.
- **Detection: wire all three, zero-guess.** One person runs `init`, commits, and it works
  regardless of which of the three tools any teammate opens (mixed-client-proof). Cost is three
  small inert config dirs (the same three that coexist in this repo today). Rejected: detect a
  single client — optimizes tidiness at the expense of the mixed-team case.

## Approach

### Architecture change: one command, subcommands, self-loading env

The bash launchers (`hooks/session-start.sh`, `hooks/stop-review.sh`) are relative to a clone
and bash-only, so they cannot live in a collaborator's project. Retire them. Move env-loading
into the command and route subcommands through the single `memorylayer` bin:

```
memorylayer                       → MCP server        (current dist/index.js behavior)
memorylayer hook <client>         → read hook         (current dist/hook.js behavior)
memorylayer stop-review <client>  → Stop/write hook   (current dist/stop-hook.js behavior)
memorylayer init                  → the installer
```

`loadConfig` gains a step: if `.memorylayer-hook.env` exists in the current working directory,
load it (dotenv-style) and merge into `process.env` before reading config. The clients run
hooks from the project root, so CWD is correct.

**The payoff — one secret, everything else committable.** Because the command self-loads the
per-user env, every config `init` writes (hooks AND MCP registration) is secret-free: they only
invoke `memorylayer`, which self-loads. The single per-user secret file is gitignored.

```
PROJECT TIER  (committed, shared — one person runs init, whole team inherits)
  .claude/settings.json · .cursor/hooks.json · .codex/hooks.json   → hook wiring
  .mcp.json · .cursor/mcp.json · (codex MCP registration)          → MCP server = `memorylayer`
  all secret-free: they invoke `memorylayer`, which self-loads the env

USER TIER  (gitignored, per-person — each collaborator runs init once for themselves)
  .memorylayer-hook.env   → MEMORYLAYER_AUTHOR, MEMORYLAYER_AUTHOR_EMAIL,
                            CONTEXT_REPO_URL (+ token), MEMORYLAYER_PROJECT
```

Retiring the launchers also drops the bash dependency (works on Windows). This repo's own
committed hooks migrate to call `node ./dist/cli.js hook <client>` for local dev, so the repo
keeps dogfooding without needing a global self-install.

### Collaborator setup (the whole thing)

```
npm install -g github:skandaramanan/MemoryLayer   # once per machine
cd team-app                                        # their shared project repo
memorylayer init                                   # wires this project + sets their identity
```

A `prepare` script (`tsc`) runs on install so `npm install -g github:…` compiles `dist/` on
fetch (today `dist/` is gitignored; `prepare` is the clean git-install build hook).

### What `init` does

```
memorylayer init
  1. Confirm we are in a git repo (hooks are project-scoped; warn + confirm if not).
  2. PROJECT TIER — merge (never clobber) into the three clients' configs:
       - write SessionStart + Stop hook entries → `memorylayer hook/stop-review <client>`
       - register the `memorylayer` MCP server
       - if a config already exists, merge our entries and leave everything else untouched
  3. USER TIER — if .memorylayer-hook.env is missing, prompt (with defaults):
       - author        (default: git config user.name)
       - email         (default: git config user.email)
       - context repo  (URL + token — the one thing the team lead hands out)
       - project name  (default: repo directory name)
     ...then write the file. If it exists, leave it unless --force.
  4. Ensure .memorylayer-hook.env and .claude/settings.local.json are gitignored.
  5. Print next steps: commit the project configs so teammates inherit them; each
     teammate runs `memorylayer init` to set their own identity.
```

## Components

- `src/cli.ts` (new) — subcommand dispatch for the `memorylayer` bin: `init` / `hook` /
  `stop-review` / (default) server. Keeps each entrypoint's logic in its existing module; this
  is thin routing.
- `src/init.ts` (new) — the installer: orchestrates the five steps above.
- `src/init-configs.ts` (new) — pure, testable builders + mergers for each client's hook config
  and MCP registration (merge-not-clobber). One function per artifact; no I/O.
- `src/init-env.ts` (new) — `.memorylayer-hook.env` generation, `git config` default lookup,
  gitignore updater. Pure where possible; I/O isolated.
- `src/config.ts` (modified) — self-load `.memorylayer-hook.env` from CWD before reading config.
- `package.json` (modified) — `bin` stays `{ "memorylayer": "dist/cli.js" }` (was
  `dist/index.js`); add `prepare` build script.
- Retire `hooks/session-start.sh`, `hooks/stop-review.sh`; migrate this repo's own committed
  hooks to `node ./dist/cli.js …`.

**Known unknown for planning:** Claude Code and Cursor register project-scoped MCP servers via
committed files (`.mcp.json`, `.cursor/mcp.json`). Codex's MCP registration location must be
verified — it may be global (`~/.codex/config.toml`) rather than project-committed. If so, the
Codex MCP step is a per-user global write (like the env file), not a committed project-tier
artifact; the hooks stay project-committed regardless. The plan resolves this against current
Codex docs before implementing.

## Data flow

**Install-time (`init`):**
```
memorylayer init → detect git repo → for each client {build config, merge into existing file}
              → register MCP server (secret-free) → ensure .memorylayer-hook.env (prompt if new)
              → update .gitignore → print next steps
```

**Run-time (a hook fires, post-install), unchanged mechanics:**
```
session start / turn end → client runs `memorylayer hook|stop-review <client>`
   → loadConfig self-loads .memorylayer-hook.env from CWD
   → neutral core (store/read or review-prompt) → per-vendor envelope (hook-clients.ts)
   → emit; fail-open on any error (exit 0)
```

## Error handling

`init` is **loud, not fail-open** — the inverse of the hooks. A hook must never block a session,
but a half-written setup must be surfaced, not swallowed:

- Not in a git repo → warn and confirm before proceeding (project-scoped hooks assume a repo).
- Existing config file is unparseable JSON → back it up (`.bak`) and warn; never destroy it.
- Missing `git config user.name`/`user.email` → prompt without a default.
- Re-run is idempotent: our entries are added at most once; existing unrelated entries are
  preserved.

The run-time hooks keep their existing fail-open contract unchanged.

## Testing (matches existing `node:test` style)

- Unit (`init-configs`): merge into an empty/absent config; merge into a config that already has
  *other* hooks/MCP entries (assert ours added, theirs preserved); re-run idempotent (no
  duplication); all three clients' exact shapes.
- Unit (`init-env`): `.memorylayer-hook.env` generation; defaults sourced from `git config`;
  gitignore updater adds each entry exactly once.
- Unit (`config`): self-loads `.memorylayer-hook.env` from CWD when present; unchanged when
  absent (fail-open preserved).
- Unit (`cli`): subcommand dispatch routes `hook`/`stop-review`/`init`/default correctly.
- Integration: run `init` in a throwaway git repo; assert all three hook configs + MCP
  registrations + env + gitignore land correctly; run again and assert zero duplication.

Green bar required: build, lint, prettier, full suite.

## Neutrality check

The neutral core (store, MCP contract, projected context, review-prompt text) is untouched.
Vendor-specific behavior still lives only in `src/hook-clients.ts` and the per-vendor config
files. `init` writes those same per-vendor files mechanically; it does not add a new place where
neutrality is spent. Consistent with the read-hook and write-trigger neutrality decisions.

## Scope boundaries (explicitly NOT in scope)

- Claude Desktop (MCP-only, global config — documented manual fallback until Phase 2).
- Any remote/hosted delivery (stays Phase 2, gated behind a passed test).
- Auto-creating the context repo (team lead creates it; `init` consumes the URL).
- Metrics-to-git (separate sequenced workstream, not this spec).
