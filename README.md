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

MCP tools are pull-based: an agent only reads when told to. To get the magic moment
(a collaborator's decision already present, unpasted), tell each agent **once** to
read on start. Add this to your project's `CLAUDE.md` and/or Cursor rules:

```markdown
## Shared planning memory
At the start of any planning or design discussion, call
`read_context(project: "<our-project>")` first, so decisions my collaborators
already recorded are in context. When we settle something ("we decided X because Y"),
call `write_context` to record it — deliberate decisions only, not every thought.
```

## The write model (anti-junk-drawer)

A "write" is a **decision or established context** — "we decided X, because Y." NOT a
firehose of every reasoning token. Deliberate commits keep the store from degrading
into a junk drawer under agent load.

## Not in v1 (on purpose)

No context graph, no UI/dashboard, no accounts/permissioning, no summarization/RAG/
vector DB, no custom merge engine (git is the merge engine), no merge-conflict UI.
None of it gets built until the core loop shows a pull of its own.

## The test

Two machines, same repo: one writes a decision from a Claude session, the other reads
it in a fresh session without pasting. That round-trip = day-one done. Then use it for
real with 2–3 collaborators for 4 weeks. Success signal: a collaborator **stops
re-explaining** a decision because they trust it's already in the shared space.
