# MemoryLayer

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

MemoryLayer fixes the loop with three properties nothing else combines:

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
git clone https://github.com/skandaramanan/MemoryLayer /tmp/memorylayer \
  && npm install -g /tmp/memorylayer
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
memorylayer init
```

`init` writes, idempotently and without clobbering existing config:

- **Session-start read hooks + MCP registration** for Claude Code
  (`.claude/settings.json`, `.mcp.json`), Cursor (`.cursor/hooks.json`,
  `.cursor/mcp.json`), and Codex (`.codex/hooks.json`; MCP is a printed block
  to paste into `~/.codex/config.toml`, since Codex registers MCP globally)
- **End-of-turn write-review hooks** (the Stop hook — see
  [The loop](#the-loop-how-reads-and-writes-actually-happen))
- Your per-user, **gitignored** `.memorylayer-hook.env` (identity + repo URL —
  secrets never enter git)

One person commits the project configs; each teammate runs `memorylayer init`
once to set their own identity. Done — the next coding session in that project
starts with the team's context already loaded.

**Verify the round-trip:** from a session, say *"record this decision: testing
MemoryLayer, because we just set it up."* Then have a teammate (or a second
machine) open a fresh session — the decision should be in their context without
anyone pasting it. That round-trip is the product.

---

## Hosted gateway (beta)

The local mode above needs each member to hold a git token. The **hosted
gateway** removes even that: a stateless Cloudflare Worker exposes the same two
tools over MCP Streamable HTTP, storing to the same kind of private GitHub repo
via a GitHub App — so joining a team space becomes *paste a URL and a token*.

- **Same store, same format.** Gateway-written entries are byte-identical to
  local ones (both planes compile the same serialization module). A space's
  repo can serve hosted members and local git-token members simultaneously.
- **Tenant isolation by construction.** One private repo per space; the GitHub
  App is installed on exactly that repo; every request resolves to a
  per-installation token that GitHub itself scopes to that one repo. No API
  surface accepts a repo/space parameter, so a routing bug cannot cross
  tenants. Member tokens are stored only as SHA-256 hashes.
- **Works with closed clients.** Anything that speaks MCP over HTTP — including
  clients that can't run local hooks — configures:

```json
{ "url": "https://<your-gateway>/mcp",
  "headers": { "Authorization": "Bearer mlk_..." } }
```

Endpoints, tenancy model, limits, and the deploy runbook live in
[gateway/README.md](gateway/README.md). Client-side hook shims for the gateway
ship today: `wayform init --remote --gateway <url> --invite <code>` wires an
agent to a hosted space, and `wayform doctor` verifies the round trip.

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
`memorylayer` as a stdio server (or point Desktop at the hosted gateway) and it
reads when the model chooses to — path 1 is your write path there.

## Configuration (`.memorylayer-hook.env`)

Written by `init`, per-user, gitignored, self-loaded from the project root at
runtime. Keys are an **allowlist** — a crafted file cannot inject other env
into hook subprocesses:

| Var | Required | Meaning |
|-----|----------|---------|
| `CONTEXT_REPO_URL` | yes | Shared context repo URL (may embed a token). |
| `MEMORYLAYER_AUTHOR` | yes | Your name — commit author / attribution. |
| `MEMORYLAYER_AUTHOR_EMAIL` | no | Commit email. Defaults from author name. |
| `MEMORYLAYER_PROJECT` | no | Project/space name. Default: repo directory name. |
| `CONTEXT_REPO_PATH` | no | Local clone path. Default: keyed per repo URL under `$XDG_DATA_HOME/memorylayer/clones/<repo-slug>-<hash>` (falls back to `~/.local/share/...`), so two spaces can never share a clone. |
| `MEMORYLAYER_READ_BUDGET_TOKENS` | no | Read token budget. Default 4000; `<=0` = unlimited. |
| `MEMORYLAYER_AUTO_PUSH` | no | `false` to skip pushing (local smoke tests). |

## Diagnostics

```bash
memorylayer doctor
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
  permission on exactly one repo per space; member bearer tokens are stored
  only as SHA-256 hashes; the Worker holds secrets in Cloudflare's secret
  store, never in code or git.
- **Trust boundary to know about:** everything a space member writes is
  injected into every member's sessions. You trust the people in your space —
  that's the model, stated plainly.

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `memorylayer: command not found` right after `npm install -g github:...` | npm 10 git-global-install bug: the global bin points at an ephemeral cache clone with no files. Fix: the clone-then-install path from the Quickstart, or `npm pack` + `npm install -g ./memorylayer-*.tgz`. |
| `ENOTDIR` reinstalling over a previous failed install | Same bug, stale symlink. Remove the target dir shown in the error, then clone-then-install. |
| Reads/writes silently do nothing | `memorylayer doctor`. Most common: missing `.memorylayer-hook.env`, no repo access, or unpushed local commits (self-heals on next read). |
| Teammates still see old behavior after an upgrade | The fix lives in the **global binary** — each teammate must reinstall it (committed project configs aren't enough), and a running MCP server needs a restart to pick it up. |
| macOS `curl` fails TLS against the hosted gateway (`workers.dev`) | LibreSSL negotiation quirk — add `--tlsv1.2`. Client-side only; SDK-based MCP clients are unaffected. |

## Project status

Working and in daily two-person dogfood; hosted gateway deployed and
smoke-tested end-to-end (including live interop: a gateway-written entry read
byte-intact by the local tool). Currently running a multi-week reliance pilot —
the success signal is a collaborator who **stops re-explaining decisions**
because they trust the shared space.

**Deliberately not built yet** (gated on the pilot proving pull): context
graph/index, dashboard UI, accounts/RBAC, summarization/RAG, custom merge
engine (git *is* the merge engine). Next increments: gateway client shims
(`init --remote`), space-provisioning CLI.

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
memorylayer --help      # subcommands: init, hook, stop-review, doctor
```

Both planes share the entry format modules (`src/frontmatter.ts`,
`src/slug.ts`, `src/token-budget.ts`) — change the format in one place or not
at all.
