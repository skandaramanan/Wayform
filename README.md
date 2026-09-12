# Wayform

**Shared planning memory for teams that build with AI.** A decision made in one
person's Claude session is already loaded in their teammate's Cursor session —
automatically, at session start, with nobody pasting anything.

```
you (Claude Code)                     teammate (Cursor)
      │                                     │
      │  "we decided X because Y"           │  new session opens
      ▼                                     ▼
 write_context ──► shared git repo ──► session-start hook
                   (your repo,           injects every decision
                    your history)        as already-known context
```

## Why this exists

AI pair-programming has a memory problem, and it's worse in teams. Every session
starts cold. Every collaborator re-explains the same settled decisions to their
own agent, every day. The context that matters — *what we decided and why* —
lives in Slack scrollback and people's heads.

Wayform fixes the loop with three properties nothing else combines:

- **Multiplayer.** One shared store per team. Your agent reads what your
  teammate's agent wrote. Attribution is git commit authorship — you always know
  who decided what, when.
- **Vendor-neutral.** Works identically across **Claude Code, Cursor, and
  Codex** (plus any MCP client). The store, the tool contract, and the injected
  context are byte-identical across tools — a decision written from Cursor lands
  in a Claude session and vice versa. Switching AI tools never loses your
  team's memory.
- **You own the data.** The store is a **private git repo in your account** —
  append-only log, immutable commits, full history, `git log` as the audit
  trail. We rent git's consistency model; we don't rebuild it. No vendor
  database holds your team's decisions.

**The write model is deliberately curated:** a write is *"we decided X because
Y"* — settled decisions and durable context, not a firehose of reasoning
tokens. That's what keeps the store worth injecting into every session instead
of degrading into a junk drawer.

---

## Quickstart (local mode)

Three steps: install the CLI, create the shared repo, wire your project.

### 1. Install the CLI (once per machine)

```bash
git clone https://github.com/skandaramanan/Wayform /tmp/wayform \
  && npm install -g /tmp/wayform
```

Requires Node ≥ 18. `dist/` is pre-built and committed, so no build step runs
on install.

> **Why not `npm install -g github:...`?** npm 10 has a git-global-install bug
> (the package is symlinked to an ephemeral cache dir that never gets checked
> out) that makes the one-liner fail with `command not found` or `ENOTDIR`.
> The clone-then-install path above uses npm's copy path and works everywhere.
> See [Troubleshooting](#troubleshooting).

### 2. Create the shared context repo (once per team)

One person creates a **private** git repo (e.g. `yourteam-memory`) and grants
each collaborator push access. This is the team's memory; it starts empty. The
v1 "shared key" is simply git access to this repo — an HTTPS URL with a token,
or SSH. No accounts, no separate auth.

### 3. Wire it into your project

From your project repo:

```bash
wayform init
```

`init` writes, idempotently and without clobbering existing config:

- **Session-start read hooks + MCP registration** for Claude Code
  (`.claude/settings.json`, `.mcp.json`), Cursor (`.cursor/hooks.json`,
  `.cursor/mcp.json`), and Codex (`.codex/hooks.json` and project
  `.codex/config.toml`)
- **End-of-turn write-review hooks** (the Stop hook — see
  [The loop](#the-loop-how-reads-and-writes-actually-happen))
- Your per-user, **gitignored** `.memorylayer-hook.env` (identity + repo URL —
  secrets never enter git)

One person commits the project configs; each teammate runs `wayform init`
once to set their own identity. Done — the next coding session in that project
starts with the team's context already loaded.

**Verify the round-trip:** from a session, say *"record this decision: testing
Wayform, because we just set it up."* Then have a teammate (or a second
machine) open a fresh session — the decision should be in their context without
anyone pasting it. That round-trip is the product.

---

## Hosted gateway

The local mode above needs each member to hold a git token. The **hosted
gateway** removes even that: a stateless Cloudflare Worker exposes the same
tools over **MCP Streamable HTTP**. Identity is **GitHub OAuth** (the same App
that writes the memory repo). Members never copy, paste, or store a Wayform
credential.

Wayform is **vendor-neutral**. The same URL works in Cursor, Claude Code,
Codex, Devin, Antigravity, or any MCP client that speaks Streamable HTTP +
OAuth. Configure it in **this product repo** (the codebase you work in) — never
as a user-global MCP, or it will follow you into unrelated folders.

Every customer is a new team. The operator allowlists their GitHub user or org;
they create their own private memory repo, initialize project-scoped config,
and select that memory repo in the guided App installation. Teammates are
invited in-agent by GitHub username.

**Operator (once per client):** add their GitHub login or org to the allowlist,
then send the MCP URL. Never send a token.

**They do:**

1. On GitHub, create a **private** team-memory repo and give it a first commit
   (for example, initialize it with a README).
2. In the product repo, run
   `wayform init --remote --clients cursor,claude` with the clients the team
   actually uses. This writes URL-only, project-scoped configuration.
3. Connect the `wayform` MCP server. Sign in with GitHub, follow the guided App
   installation, and select only the private memory repo from step 1.
4. Run `wayform login` once on the machine so session hooks can authenticate.
5. Run `wayform doctor`; resolve every failed hosted check before continuing.
6. Ask the agent to record a test decision, then open a new session and confirm
   that decision is already present.
7. Commit the URL-only project configuration. Teammates run remote init and
   authenticate; nobody copies a credential.

### Client setup (project-scoped, OAuth)

Same URL everywhere. OAuth credentials are managed internally by each MCP
client or the native OS credential store; users never copy or configure them.

| Client | Project file (commit this) | Do **not** use (global) | Authenticate |
|---|---|---|---|
| **Cursor** | `.cursor/mcp.json` → `{ "mcpServers": { "wayform": { "url": "…" } } }` | `~/.cursor/mcp.json` | Connect |
| **Claude Code** | `.mcp.json` (same JSON), or `claude mcp add --transport http --scope project wayform <url>` | `--scope user` | `claude mcp login wayform` |
| **Codex** | `.codex/config.toml` → `url` + `auth = "oauth"` | `~/.codex/config.toml` | `codex mcp login wayform` |
| **Devin CLI** | `.devin/mcp_config.json` → `{ "url": "…", "transport": "http" }` | `--scope user` / `~/.config/devin/mcp_config.json` | `devin mcp login wayform` |
| **Antigravity** | `.agents/mcp_config.json` → `{ "serverUrl": "…" }` | `~/.gemini/config/mcp_config.json` | Authenticate in MCP settings (DCR) |

`wayform init --remote --clients cursor,claude` writes **only** those
clients' files. With `--yes` and no `--clients`, it updates folders
already in the repo and does not create the rest. `wayform doctor` says
"run wayform login" when the hook session is missing — never "paste a token".

Do **not** add Wayform as a Devin Cloud **organization-wide** MCP if you only
want it in this repo — that surface is shared across the org, not one folder.

Endpoints, allowlist, and the deploy runbook live in
[gateway/README.md](gateway/README.md).

---

## The guard

Reading decisions back is half the loop. The other half is catching an agent
about to contradict one.

With the hosted gateway configured, `wayform init` wires a `PreToolUse` hook in
Claude Code. Before any `Edit`, `Write`, or `Bash`, the proposed action is
checked against the team's live decisions. If it contradicts one, you get a
confirmation prompt naming the decision, who made it, and when:

> **Wayform — this contradicts a recorded team decision:**
> We ruled out a second datastore; Postgres is not being added.
> — Skanda, 2026-07-12

It **asks**; it never blocks. Reads are never guarded, so only mutating tools
pay any latency, capped at 1.5s before the check gives up and allows.

Turn it off per machine with `WAYFORM_GUARD=off` in `.memorylayer-hook.env`.

How often it fires:

```bash
curl -H "$WAYFORM_AUTH" \
  "$GATEWAY/admin/retrieval-log?space=<space>&trigger=hook_guard"
# → { "rows": [...], "fired": 12 }
```

---

## The two tools

Everything reads and writes through one MCP contract (identical in local stdio
and hosted HTTP modes):

| Tool | What it does |
|---|---|
| `read_context(project, budget_tokens?)` | Pull latest and return the projected context — every recorded decision, in write order, packed to a token budget (default 4000) so reads never flood a session as the store grows. |
| `write_context(project, type, payload)` | Append one decision (`type: "decision"`) or durable background (`type: "context"`) as its own file, commit, push. The commit is the event; the author is the attribution. |

Each write is its own file under `context/<project>/<author>/`, so concurrent
writers never touch the same file and never merge-conflict. Many working repos
may share one memory repo (kept separate inside it by `context/<project>/`).

## The loop — how reads and writes actually happen

**Reads are guaranteed, not hoped for.** MCP alone is pull-based — an agent
reads only when it decides to. The session-start hook removes that dependency:
it injects the project's context before the agent does anything. Hooks are
**project-scoped on purpose** — they fire only in this project's coding
sessions, never in unrelated chats.

**Writes have three paths, softest first:**

1. **Say it** (any client, incl. Claude Desktop): *"record this decision: X
   because Y."* A direct command the model complies with near-reliably.
2. **`/remember`** (Claude Code / Cursor): one-word gesture; ships in
   `.claude/commands/remember.md`. `/remember we decided X because Y`, or bare
   `/remember` to record the last settled decision.
3. **End-of-turn self-review** (Claude Code / Cursor / Codex): a Stop hook asks
   the model at each turn's end — *"did this turn settle a decision that isn't
   recorded? If yes, write it; if not, do nothing."* This closes the weak half
   of the loop (models don't spontaneously notice). Loop-guarded to fire at
   most once per turn.

**Everything runtime is fail-open.** Offline, bad config, empty store — hooks
emit their client's no-op and exit 0. A broken memory layer can never break a
coding session. (The flip side: failures are quiet — that's what `doctor` is
for.)

**Claude Desktop** has no hook system, so it's MCP-pull-only: register
`wayform` as a stdio server (or point Desktop at the hosted gateway URL and
Connect) and it reads when the model chooses to — path 1 is your write path
there.

## Configuration (`.memorylayer-hook.env`)

Written by `init`, per-user, gitignored, self-loaded from the project root at
runtime. Keys are an **allowlist** — a crafted file cannot inject other env
into hook subprocesses:

| Var | Required | Meaning |
|-----|----------|---------|
| `CONTEXT_REPO_URL` | local mode | Shared context repo URL (may embed a git token). |
| `MEMORYLAYER_GATEWAY_URL` | hosted mode | Gateway base URL. Presence selects hosted (no clone). |
| `MEMORYLAYER_AUTHOR` | local mode | Your name — local commit author / attribution. Hosted attribution comes from GitHub OAuth. |
| `MEMORYLAYER_AUTHOR_EMAIL` | no | Local commit email. Defaults from author name. |
| `MEMORYLAYER_PROJECT` | no | Project/space name. Default: repo directory name. |
| `CONTEXT_REPO_PATH` | no | Local clone path. Default: keyed per repo URL under `$XDG_DATA_HOME/memorylayer/clones/<repo-slug>-<hash>` (falls back to `~/.local/share/...`), so two spaces can never share a clone. |
| `MEMORYLAYER_READ_BUDGET_TOKENS` | no | Read token budget. Default 4000; `<=0` = unlimited. |
| `MEMORYLAYER_AUTO_PUSH` | no | `false` to skip pushing (local smoke tests). |

Hosted hook env contains only project settings and the gateway URL. The OAuth
session is held by the native OS credential store after `wayform login`.

## Diagnostics

```bash
wayform doctor
```

Read-only. Checks the env file, resolved config, clone health and origin,
remote connectivity/auth, unpushed commits, and the default project name.
Tokens embedded in URLs are redacted before printing. Run it whenever a read or
write "silently" does nothing — fail-open means problems hide here first.

## Security & data ownership

- **Local mode:** your data never transits anything but git between your
  machine and your own private repo. The env allowlist blocks env injection;
  project/author names are slugged so a hostile name can't path-traverse out of
  `context/`; error output redacts embedded tokens.
- **Hosted mode:** the gateway is a stateless proxy — the source of truth stays
  a private GitHub repo in *your* account. The App holds Contents-only
  permission on exactly one repo per space; members are keyed by GitHub user
  id after OAuth. The Worker holds operator secrets in Cloudflare's secret
  store, never in code or git. Members never see a Wayform API key. For now,
  one GitHub user can belong to one Wayform space; multi-space membership is a
  deferred product decision.
- **Trust boundary to know about:** everything a space member writes is
  injected into every member's sessions. You trust the people in your space —
  that's the model, stated plainly.
- **Rate limits — wired but NOT currently enforcing.** Verified live
  2026-08-30: the binding is bound and called on every request, but returned
  success for 100+ requests in seconds against a limit of 20/60s. Treat these
  surfaces as **unprotected** until a `ratelimit_block` line appears in Workers
  Logs. Intended shape: unauthenticated surfaces (`/authorize`, `/callback`,
  `/oauth/register`, `/oauth/token`, `/install/*`, `/admin/*`) are capped at 20
  requests per minute per caller. `/mcp` is not capped — it requires a valid
  token, so abuse there is a revocation problem, not a throttling one.
  `/health` and the signed GitHub webhook are never throttled: dropping a
  webhook would stall indexing silently, which is worse than the abuse it would
  prevent. If the limiter is unavailable the gateway serves normally rather
  than refusing traffic.

### Managing your own sessions

Every editor you connect is a separate OAuth grant. You can review and
disconnect them yourself, from any agent — no operator involved:

> "list my wayform sessions"
> "revoke wayform session <id>"

`list_sessions` shows each connected client, when it was connected, and marks
the one you are currently using. `revoke_session` disconnects one and takes
effect immediately; that client must sign in again. Both act only on **your**
account — removing a *teammate* from the space is `revoke_member`, and is
admin-only. A revoke that cannot be confirmed reports an error rather than
claiming success, so "revoked" always means revoked.

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `wayform: command not found` right after `npm install -g github:...` | npm 10 git-global-install bug: the global bin points at an ephemeral cache clone with no files. Fix: the clone-then-install path from the Quickstart, or `npm pack` + `npm install -g ./wayform-*.tgz`. |
| `ENOTDIR` reinstalling over a previous failed install | Same bug, stale symlink. Remove the target dir shown in the error, then clone-then-install. |
| Reads/writes silently do nothing | `wayform doctor`. Hosted: usually `wayform login`. Local: missing `.memorylayer-hook.env`, no repo access, or unpushed local commits (self-heals on next read). |
| Teammates still see old behavior after an upgrade | The fix lives in the **global binary** — each teammate must reinstall it (committed project configs aren't enough), and a running MCP server needs a restart to pick it up. |
| macOS `curl` fails TLS against the hosted gateway (`workers.dev`) | LibreSSL negotiation quirk — add `--tlsv1.2`. Client-side only; SDK-based MCP clients are unaffected. |

## Project status

Working and in daily two-person dogfood on GitHub OAuth (no member API keys).
Hosted onboarding is Connect + GitHub App install on your private memory repo.

**Deliberately not built yet:** Stripe/paid plans, per-space extract caps,
dashboard UI, custom merge engine (git *is* the merge engine).

## Repo layout

```
src/            local CLI + stdio MCP server (init, hooks, store, doctor)
gateway/        hosted gateway — Cloudflare Worker (own README + runbook)
dist/           pre-built JS, committed (installs need no toolchain)
docs/plans/     implementation plans        docs/specs/  design specs
docs/roadmap/   production + graph-store roadmaps
test/           node:test suites (gateway has its own under gateway/test/)
```

## Development

```bash
npm test                # build + full local suite, lint: npm run lint
npm run test:gateway    # gateway suite (Node >= 20)
wayform --help          # subcommands: init, login, hook, doctor, space
```

Both planes share the entry format modules (`src/frontmatter.ts`,
`src/slug.ts`, `src/token-budget.ts`) — change the format in one place or not
at all.
