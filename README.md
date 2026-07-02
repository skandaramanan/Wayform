# MemoryLayer

A **vendor-neutral, multiplayer planning memory**: a shared context space that 2–3
people *and their AIs* read and write together across Claude, Cursor, and Codex — so
a decision written from one person's session is already present in a collaborator's
session, with nobody pasting anything.

The wedge is not "multiplayer." It's **multiplayer that belongs to no vendor**. Git
is the consistency layer (append-only log, immutable commits, per-write attribution
via commit authorship). We rent it; we don't rebuild it.

## How it works

An MCP server (stdio) exposing two tools over a **git-backed** context store:

- `read_context(project)` → pulls latest, returns the current projected context.
- `write_context(project, entry)` → appends a decision as its own file and commits
  it. Commit = the event. Author = attribution.

Each write is its own file under `context/<project>/<author>/`, so concurrent
writers never touch the same file and never produce a merge conflict.

## Setup

### 1. Create the shared context repo

Create one **private** git repo (GitHub is fine) that all collaborators can push to.
This is the shared memory. It starts empty.

### 2. Build the server

```bash
npm install
npm run build
```

### 3. Configure each MCP client

Point Claude Desktop / Cursor at the server as a stdio MCP server. The "shared key"
for v1 is simply git access to the private context repo (an HTTPS URL with a token,
or SSH). No accounts, no separate auth layer.

**Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "memorylayer": {
      "command": "node",
      "args": ["/absolute/path/to/MemoryLayer/dist/index.js"],
      "env": {
        "CONTEXT_REPO_URL": "https://<token>@github.com/yourteam/planning-memory.git",
        "CONTEXT_REPO_PATH": "/Users/you/.memorylayer/context-store",
        "MEMORYLAYER_AUTHOR": "Skanda",
        "MEMORYLAYER_AUTHOR_EMAIL": "skanda@example.com"
      }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json` or Settings → MCP): same `command`, `args`, and `env`.

### Environment variables

| Var | Required | Meaning |
|-----|----------|---------|
| `CONTEXT_REPO_URL` | yes | URL of the shared context git repo (may embed a token). |
| `MEMORYLAYER_AUTHOR` | yes | Your name — becomes the commit author / attribution. |
| `CONTEXT_REPO_PATH` | no | Local clone path. Default `~/.memorylayer/context-store`. |
| `MEMORYLAYER_AUTHOR_EMAIL` | no | Commit email. Defaults from author name. |
| `MEMORYLAYER_AUTO_PUSH` | no | `false` to skip pushing (local smoke tests). Default pushes. |

### 4. Make reads feel "unprompted"

MCP tools are pull-based: an agent only reads when told to. There are two ways to get
the magic moment (a collaborator's decision already present, unpasted), softest first.

**(a) The convention (soft, ~60–85%).** Tell each agent **once** to read on start.
Add this to your project's `CLAUDE.md` and/or Cursor rules:

```markdown
## Shared planning memory
At the start of any planning or design discussion, call
`read_context(project: "<our-project>")` first, so decisions my collaborators
already recorded are in context. When we settle something ("we decided X because Y"),
call `write_context` to record it — deliberate decisions only, not every thought.
```

**(b) The read hook (guaranteed, for coding tools).** The convention still depends on
the model *choosing* to call the tool, which decays over long chats. To take the
decision away from the model, the bundled session-start hook pulls the project's context
and injects it at the start of a session before the agent does anything.

> **Scope on purpose.** The hook is **project-scoped**, not global. It lives in this
> repo (`.cursor/hooks.json`, `.claude/settings.json`) so it fires **only when you open
> a coding session in this project** — never in unrelated Cursor/Claude Code chats,
> where injecting a planning doc would just pollute context. This scoping is the whole
> reason it lives in the repo rather than in `~/.cursor` / `~/.claude`.

`dist/hook.js` is the **neutral core**: it reads the store, projects the context, and
emits it. Only the *envelope* is per-vendor, isolated in `hook-clients.ts` and selected
by `MEMORYLAYER_HOOK_CLIENT`:

| `MEMORYLAYER_HOOK_CLIENT` | Emits | For |
|---|---|---|
| `cursor` (default) | `{ "additional_context": "…" }` | Cursor `sessionStart` |
| `claude-code` | `{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "…" } }` | Claude Code `SessionStart` |
| `codex` | `{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "…" } }` | Codex `SessionStart` |
| `raw` | the markdown, verbatim on stdout | any client whose start hook injects stdout |

Onboarding a new tool is one `case` in `hook-clients.ts`; the core never changes. This
is where — and the *only* place — vendor-neutrality is spent: the store, the MCP
contract, and the projected context are identical across tools, so a decision written
from Cursor is injected at the start of a Claude Code session and vice versa.

The hook is **fail-open**: on any error (offline, bad config, empty store) it emits the
client's empty no-op (`{}`, or nothing for `raw`) and exits 0, so it can never break a
session. Config is the same env vars as the server, plus optional `MEMORYLAYER_PROJECT`
(project to inject; default `memorylayer`) and `MEMORYLAYER_HOOK_CLIENT` (default `cursor`).

**Setup (once per clone):** copy the config template — your identity/URL stay out of git:

```bash
cp .memorylayer-hook.env.example .memorylayer-hook.env   # then fill in your values
```

Both clients invoke one committed launcher, `hooks/session-start.sh <client>`, which
reads `.memorylayer-hook.env` and runs `dist/hook.js`.

- **Cursor** — already wired via committed `.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [
      { "command": "bash ./hooks/session-start.sh cursor" }
    ]
  }
}
```

- **Claude Code** — wired via `.claude/settings.json` (this repo's `.gitignore` excludes
  `.claude/`, so create it locally per clone):

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/hooks/session-start.sh\" claude-code" }
        ]
      }
    ]
  }
}
```

### End-of-turn self-review (write side, Claude Code / Codex / Cursor)

The read hook guarantees reads; the **Stop hook** does the symmetric job for writes. At the
end of every turn it asks the model: "did we just settle a decision that isn't recorded? If
so, call `write_context`; if not, do nothing." This removes the reliance on the model
*spontaneously* noticing — the weak half of the loop.

Why per-turn and not on session close: Claude Code's `SessionEnd` is cleanup-only (it cannot
re-engage the model), so review must hang off `Stop`, which fires each turn. A
`stop_hook_active` loop guard means it fires at most once per turn, and it is **fail-open**
(any error → allow the turn to end).

It shares the neutral pattern: `dist/stop-hook.js` is the core, the per-vendor envelope is one
`case` in `hook-clients.ts`.

Wired for **Claude Code** (`.claude/settings.json`), **Codex** (`.codex/hooks.json`, Stop
re-engages via `{"decision":"block","reason":…}`), and **Cursor** (`.cursor/hooks.json`, Stop
re-engages via `{"followup_message":…}` with a `loop_limit` backstop). The client-agnostic loop
guard treats `stop_hook_active` (Claude Code / Codex) or `loop_count > 0` (Cursor) as a
continuation and no-ops. **Claude Desktop** stays MCP-pull-only — no hooks.

**Live-verification TODOs** (not yet exercised against real Codex/Cursor installs): (1) Codex
`Stop` actually provides `stop_hook_active`; (2) `.codex/hooks.json` fires in interactive
sessions (cf. openai/codex#17532, which was `config.toml`-only); (3) Cursor `sessionStart`
`additional_context` injection lands.

Wire it locally (this repo's `.gitignore` excludes `.claude/`, so add it per clone) by adding
a `Stop` entry to `.claude/settings.json`:

```json
"Stop": [
  {
    "hooks": [
      { "type": "command", "command": "bash \"$CLAUDE_PROJECT_DIR/hooks/stop-review.sh\" claude-code" }
    ]
  }
]
```

### The `/remember` command (Claude Code / Cursor)

A low-friction muscle-memory write. `.claude/` is gitignored, so create the command per clone
at `.claude/commands/remember.md` with:

    ---
    description: Record a settled decision to the shared MemoryLayer store
    ---

    Record a decision to the shared MemoryLayer planning store for this project.
    If text was provided after the command, use it as the decision. Otherwise, use the
    most recently settled decision from our conversation. Call `write_context` with
    project "memorylayer", type "decision" (or "context"), and a compact payload that
    includes the "because". Only settled decisions — keep the store curated.

    $ARGUMENTS

Then `/remember we decided X because Y` records it; bare `/remember` records the last settled
decision. Cursor has an equivalent command mechanism pointing at the same `write_context` tool.

### Claude Desktop is different — no auto-read

Claude Desktop has **no hook system**; it only speaks MCP, and **MCP is pull-based**.
That means Desktop does **not** read context automatically on a new chat. It reads
**only** when the model decides to call `read_context` — i.e. when the convention in
**(a)** nudges it, which is best-effort, not guaranteed. If you want Desktop to pull on
every new chat, you must say so explicitly in its instructions (and even then it's the
model's choice, not a hard trigger). Guaranteed auto-read on Desktop needs the hosted
proxy (Phase 2), because the client is closed.

## The write model (anti-junk-drawer)

A "write" is a **decision or established context** — "we decided X, because Y." NOT a
firehose of every reasoning token. Deliberate commits keep the store from degrading
into a junk drawer under agent load.

**Three ways a write happens (softest first):**

1. **Explicit phrase (any client, incl. Desktop).** Tell the agent directly: "record this
   decision: X because Y." Because it's a direct command, the model complies near-reliably —
   unlike it *spontaneously* noticing. This is the universal fallback and the only write path
   on Claude Desktop.
2. **`/remember` slash command (Claude Code / Cursor).** A one-word gesture — see setup below.
3. **End-of-turn self-review (Claude Code).** A `Stop` hook asks the model, at the end of each
   turn, to record any decision just settled — see setup below.

## Not in v1 (on purpose)

No context graph, no UI/dashboard, no accounts/permissioning, no summarization/RAG/
vector DB, no custom merge engine (git is the merge engine), no merge-conflict UI.
None of it gets built until the core loop shows a pull of its own.

## The test

Two machines, same repo: one writes a decision from a Claude session, the other reads
it in a fresh session without pasting. That round-trip = day-one done. Then use it for
real with 2–3 collaborators for 4 weeks. Success signal: a collaborator **stops
re-explaining** a decision because they trust it's already in the shared space.
