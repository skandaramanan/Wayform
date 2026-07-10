# Plan B — Hosted-member onboarding (`wayform init --remote`)

Date: 2026-07-09
Status: DESIGN APPROVED (brainstorm complete, ready for implementation plan).
Owner: Skanda

## Purpose

Take a new **hosted member** from "the team leader handed me a gateway URL and a
token" to "my coding sessions auto-load the team's shared memory, and I can
read/write it from my agent" — with:

- **no access grant to any code repo** (only the gateway URL + token),
- **no git clone** of the memory repo,
- **project-scoped** client config (not global, except where a client forces it),
- **no token committed to git.**

This is "Plan B" from the hosted-gateway-core plan
(`docs/plans/2026-07-05-hosted-gateway-core.md`), the deferred client-shim /
`init --remote` increment. It is the piece that gives hosted members
**session-start auto-injection**, which the native HTTP MCP alone cannot provide.

Non-goals are listed in §7.

## Background — what already exists vs. what is missing

The runtime already supports remote reads; only the **installer** and one
**config guard** are missing.

Already present:
- `remoteHookRead(cfg, project, budget)` → `GET /hook/read` (session hook path),
  and `remoteApiRead(...)` → `GET /api/read` (MCP `read_context` / `search_memory`).
  Both are gated on `cfg.gatewayUrl && cfg.gatewayToken`, time-bounded, fail-open
  (return `null` → caller falls back). — `src/remote-read.ts`
- `runHook()` already tries `remoteHookRead` first and injects its result. — `src/hook.ts`
- `loadConfig()` already reads `MEMORYLAYER_GATEWAY_URL` / `MEMORYLAYER_GATEWAY_TOKEN`. — `src/config.ts`
- `.memorylayer-hook.env` is already gitignored by `init`. — `src/init.ts`

Missing / blocking:
1. **`loadConfig()` hard-requires `CONTEXT_REPO_URL`** (`required("CONTEXT_REPO_URL")`,
   `src/config.ts:169`). A hosted-only member (gateway creds, no local clone) makes
   `loadConfig()` throw; in `runHook()` that throw is caught **before**
   `remoteHookRead` is ever called, so the hook fail-opens to **silence**. This is
   the real reason the shim "isn't shipped."
2. **No `init --remote` command** to write the hosted-member config set.
3. **No native HTTP MCP registration** in `init` (today it only writes the local
   stdio server into committed `.mcp.json`). The stdio server's `write_context` is
   **local-only** (`src/index.ts` — `store.write`, no remote proxy) and `runServer()`
   requires a clone, so it is unusable for hosted members. Hosted members must use
   the gateway's native HTTP MCP at `/mcp`.

## Settled decisions (from the 2026-07-09 brainstorm)

1. **Member type = hosted-only.** No local clone. Gateway URL+token is the sole
   source. Matches the 2026-07-08 "remote-only onboarding" decision (zero git/npm
   exposure for onboarding).
2. **Hook engine = the global `wayform` binary.** Member runs `npm install -g wayform`
   once, then `wayform init --remote`. The session-start hook calls the fast local
   binary (offline-safe, no per-turn latency). Per-turn `npx` and remote-resolved
   hooks were rejected by the 2026-07-02 decision (latency + offline fail-open =
   silently lost context).
3. **Distribution = public npm as `wayform`** (`npm install -g wayform`), the
   GitHub-CLI / wrangler / vercel model: one-command install, no private-repo access.
   Reverses the 2026-07-02 "private GitHub install to keep code private" stance,
   which itself flagged public npm as a reversible later step; recorded view is code
   isn't the moat. brew/standalone are possible **later additional** channels, not
   a replacement.
4. **Rename scope:** binary/package = `wayform`; the **store project space stays
   `memorylayer`** (no ledger migration yet). Env var names (`MEMORYLAYER_*`,
   `CONTEXT_REPO_URL`) and hook idempotency markers are unchanged this pass. Full
   rename to Wayform is a later incremental task.
5. **MCP registration = native HTTP, project-scoped, token-safe** — see §5.

## 1. Command surface

New subcommand, routed in `src/cli.ts` alongside `init`:

```
wayform init --remote --gateway <url> --token <mlk_...> [--project <name>]
             [--author <name>] [--email <email>] [--yes] [--force] [--help]
```

- `--remote` selects the hosted-member flow. Absent → the existing local `init`
  is unchanged.
- `--gateway` (required in remote mode): gateway base URL. Trailing slashes trimmed.
- `--token` (required in remote mode): the member's `mlk_...` bearer token.
- `--project` (optional): shared space name; default = current repo dir name,
  slugged consistently with the rest of the tool.
- `--author` / `--email` (optional): attribution display; prompt defaults from
  `git config`, same as local `init`. (Note: the gateway ignores client-declared
  author on write; attribution is the token. These values are for local display /
  parity only.)
- `--yes` accepts defaults without prompting; `--force` rewrites an existing
  `.memorylayer-hook.env`.
- Runs in the member's **working project directory** (their dev repo), not a memory
  clone.

Posture matches local `init`: **LOUD, not fail-open** — unparseable existing
configs are backed up to `.bak`, never destroyed; re-running is idempotent.

## 2. What `init --remote` writes

### User tier (gitignored) — `.memorylayer-hook.env`

Extend the env builder with a remote variant that writes:

```
MEMORYLAYER_GATEWAY_URL=<url>
MEMORYLAYER_GATEWAY_TOKEN=<mlk_...>
MEMORYLAYER_PROJECT=<project>
MEMORYLAYER_AUTHOR=<author>
MEMORYLAYER_AUTHOR_EMAIL=<email>
```

Deliberately **no `CONTEXT_REPO_URL`** (hosted-only). The file stays gitignored
(existing `init` already adds it to `.gitignore`).

### Project tier (committed, token-free) — session + Stop hooks

Reuse the existing hook mergers unchanged, except the invoked binary is `wayform`:

- `.claude/settings.json` — `SessionStart` → `wayform hook claude-code`;
  `Stop` → `wayform stop-review claude-code`
- `.cursor/hooks.json` — `sessionStart` → `wayform hook cursor`;
  `stop` → `wayform stop-review cursor`
- `.codex/hooks.json` — `SessionStart` → `wayform hook codex`;
  `Stop` → `wayform stop-review codex`

These are safe to commit (no token; the binary self-loads the gitignored env).
The `addOnce` idempotency marker is the `<subcommand> <client>` token
(e.g. `hook claude-code`), independent of the binary name, so re-running does not
duplicate hooks even if a machine previously wrote `memorylayer hook ...`.

### MCP registration (native HTTP, project-scoped, token-safe) — see §5

The committed local-stdio `.mcp.json` is **not** written in remote mode.

### Gitignore

Ensure `.gitignore` contains `.memorylayer-hook.env`, `.claude/settings.local.json`,
and (new) **`.cursor/mcp.json`** (because in remote mode that file carries the
token — see §5).

## 3. Required code change — `loadConfig()` gateway-only mode

Make `CONTEXT_REPO_URL` **optional when a gateway is configured.**

- If `MEMORYLAYER_GATEWAY_URL` and `MEMORYLAYER_GATEWAY_TOKEN` are both present,
  `loadConfig()` must succeed with `repoUrl`/`repoPath` absent (or a clearly-unused
  sentinel) and populate `gatewayUrl`/`gatewayToken`.
- If neither gateway nor `CONTEXT_REPO_URL` is present, keep today's LOUD error.
- Local-only behavior (CONTEXT_REPO_URL set, no gateway) is **unchanged.**

Downstream guards required so gateway-only config never touches the clone:
- `runHook()` reaches `remoteHookRead` before any `ContextStore` use — verify the
  gateway-only path returns before `new ContextStore(cfg)` / `store.ensure()`.
- Any code that constructs `ContextStore` when only a gateway is configured must be
  gated (the hook's local fallback branch must be skipped in gateway-only mode, or
  `ContextStore` must tolerate an absent repoUrl by being unreachable on that path).

This is the load-bearing change; everything else is installer plumbing.

## 4. Runtime flow after onboarding (hosted-only member)

1. **Session start:** client fires its hook → `wayform hook <client>` →
   `runHook()` → `loadConfig()` succeeds (gateway-only) → `remoteHookRead` → gateway
   `/hook/read` returns injectable context → injected. Gateway unreachable/slow →
   `remoteHookRead` returns `null` → in gateway-only mode there is no local clone,
   so emit the client's empty no-op (fail-open to silence, never an error).
2. **Read/search during work:** native HTTP MCP tools (`read_context`,
   `search_memory`) hit the gateway directly.
3. **Write:** native HTTP MCP `write_context` → gateway `/mcp` → gateway commits via
   the App installation token (attribution = the member's bearer token).

## 5. MCP registration detail (per client)

Goal: **project-scoped AND token-not-in-git**, everywhere technically possible.
"Project-scoped vs global" (which projects the server is active in) and
"committed vs gitignored" (token safety) are independent axes; we want
project-scoped + not-committed.

- **Claude Code** — shell out to the Claude CLI:
  `claude mcp add --transport http --scope local memorylayer <url>/mcp
   --header "Authorization: Bearer <token>"`.
  `--scope local` = this project only, stored in `~/.claude.json` (not the committed
  repo). Project-scoped **and** token-safe. If the `claude` CLI is absent, fall back
  to printing the exact command for the member to run, and warn (LOUD).
- **Cursor** — write/merge the HTTP server into the project's `.cursor/mcp.json`
  **and gitignore that file.** Project-scoped, per-member, token stays out of git.
  Shape:
  ```json
  { "mcpServers": { "memorylayer": {
      "url": "<url>/mcp",
      "headers": { "Authorization": "Bearer <token>" } } } }
  ```
- **Codex** — **global-only** (`~/.codex/config.toml`) via the `mcp-remote` bridge;
  a documented Codex platform limitation (no project-scoped MCP; recorded in the
  2026-07-04 scoping audit). Merge that file (no new TOML dependency — string-merge
  as today) or print the snippet. Documented as the single unavoidable global
  exception.

The MCP **server name** registered is `memorylayer` (unchanged this pass, per the
rename scope), even though the binary is `wayform`.

## 6. Testing

Unit:
- MCP config mergers: Cursor `.cursor/mcp.json` HTTP-server shape; idempotent
  re-run; non-clobbering of unrelated servers; Codex TOML string-merge.
- `.gitignore` includes `.cursor/mcp.json` in remote mode.
- Remote env builder emits gateway vars and **omits** `CONTEXT_REPO_URL`.
- `loadConfig()`: (a) gateway-only config succeeds with no `CONTEXT_REPO_URL`;
  (b) local-only config unchanged; (c) neither present → still throws LOUD.

Integration:
- Hosted-only env (gateway vars, no `CONTEXT_REPO_URL`) drives `runHook()` through
  `remoteHookRead` (stubbed fetch) and injects the returned text via the correct
  client envelope.
- Gateway unreachable in gateway-only mode → `runHook()` emits the client empty
  no-op, exit 0 (no clone touched, no throw surfaced).

All existing tests stay green; the local `init` and local-only hook paths are
untouched.

## 7. Out of scope (YAGNI)

- Local stdio MCP server for hosted members (native HTTP MCP replaces it; stdio
  can't do hosted writes anyway).
- The leader / `wayform space create` provisioning flow — that is **Plan C**.
- brew / standalone-binary distribution channels (possible later addition).
- Claude Desktop auto-injection (still pull-only; no session-start hook primitive).
- Renaming env vars, the MCP server name, or the store project space (deferred to
  the eventual full Wayform rename).
- Any gateway-side change: the gateway already serves `/hook/read`, `/api/read`,
  and `/mcp`.

## 8. Risks / notes

- **Coexistence:** a maintainer machine may have both `memorylayer` (old local) and
  `wayform` binaries. Hosted-only members are clean-machine (`wayform` only), so no
  conflict; the idempotency marker also prevents duplicate hooks if both were ever
  installed in one project.
- **`claude` CLI dependency** for the Claude Code path: mitigated by the
  print-and-warn fallback so onboarding never hard-fails on its absence.
- **npm-10 global-install footgun** (recorded in the README troubleshooting) is an
  install-surface tax; note it in the onboarding docs but it is not a Plan B code
  change.
