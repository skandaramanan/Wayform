# Pilot onboarding playbook — PERSONAL, GITIGNORED, DO NOT COMMIT

Contains live secrets and per-member token records. If this file ever shows in
`git status`, stop and fix `.gitignore` before doing anything else.

---

## My live values (operator quick-reference)

| Thing | Value |
|---|---|
| Gateway URL | `https://memorylayer-gateway.memory-layer.workers.dev` |
| Admin secret | `0f044c106420d812a2888d03345e54171f05f27bbafaa799d3017507a1c3bc40` ⚠️ rotate before external teams: `cd gateway && npx wrangler secret put ADMIN_SECRET` |
| KV namespace id | `799c559402d6472993dc63ed26b0fd5e` |
| GitHub App page | `https://github.com/apps/memorylayer-gateway` *(fix slug if the App name differed)* |
| App visibility | ⚠️ currently "Only on this account" — flip to **Any account** (App settings → Advanced) before ANY external team |
| Dogfood space | space `memorylayer` · repo `skandaramanan/MemoryLayer-Memory` · installation id `144657125` |

macOS curl always needs `--tlsv1.2` against workers.dev.

---

## Token ledger (append a row EVERY time you mint — hash is the only revoke handle)

Get the hash before sending the token: `printf '%s' 'mlk_...' | shasum -a 256`

| Date | Member | Space | Token sha256 | Status |
|---|---|---|---|---|
| 2026-07-06 | Skanda | memorylayer | *(never minted — confirmed via empty `wrangler kv key list`)* | dead |
| 2026-07-07 | Skanda | memorylayer | `5d912b27947762c31f588bdfd024434f2759a294615a73dde9536e926f816218` | active |

Revoke a member:

```bash
cd gateway && npx wrangler kv key delete \
  --namespace-id 799c559402d6472993dc63ed26b0fd5e "member:<sha256>"
```

---

## Checklist A — onboard a NEW TEAM (leader flow, ~10 min, do once per team)

Copy this block per team and tick as you go.

```
Team: ____________  Leader: ____________  Date: ________

[ ] 0. (external teams only, first time ever) App visibility = "Any account"
[ ] 1. Leader creates PRIVATE repo in THEIR account (e.g. teamname-memory)
       — must be initialized with a README (needs >=1 commit on main)
[ ] 2. Send leader the App install link; they install it on ONLY that repo
[ ] 3. Leader sends back: repo owner, repo name, installation id
       (the number in github.com/settings/installations/<NUMBER>)
[ ] 4. Mint one token per member (Checklist B) — leader included
[ ] 5. Leader runs the 1-minute smoke (gateway/README.md §2.5) and confirms
       a commit landed in their repo
[ ] 6. Log the team + members below
```

## Checklist B — onboard a NEW MEMBER (~2 min each)

```
Member: ____________  Team/space: ____________  Date: ________

[ ] 1. Mint (fill the 5 CAPS values):
```

```bash
curl --tlsv1.2 -s -X POST https://memorylayer-gateway.memory-layer.workers.dev/admin/members \
  -H "x-admin-secret: 0f044c106420d812a2888d03345e54171f05f27bbafaa799d3017507a1c3bc40" \
  -H "content-type: application/json" \
  -d '{"space":"SPACE","installationId":INSTALLID,"owner":"GHOWNER","repo":"GHREPO","author":"MEMBER NAME","authorEmail":"MEMBER@EMAIL"}'
```

```
[ ] 2. Hash the returned token, append to the ledger above
[ ] 3. Send member: gateway URL + their token (password-manager share, not chat)
[ ] 4. Send them the client setup for their tool (below)
[ ] 5. Verify: they run read_context from their client; you see the read work
       (or they write a hello entry and you see the commit in the space repo)
```

---

## Client setup snippets (send the relevant one to each member)

### Hosted member, one command (`wayform init --remote`)

Once `wayform` is installed (`npm install -g wayform`), a hosted member wires up
their project in one step (no git clone, token stays out of git):

```bash
wayform init --remote --gateway <gateway-url> --token mlk_THEIR_TOKEN
```

This writes the gitignored gateway env + `wayform` session/Stop hooks, registers
project-scoped Claude Code MCP (`claude mcp add --scope local`) and a gitignored
`.cursor/mcp.json`, and prints the Codex snippet (Codex MCP is global-only). The
per-client blocks below are the manual equivalents if you prefer to wire it by hand.

### Claude Code (native HTTP MCP — recommended)

One command, token stays out of committed files (`--scope local` = this
project only, stored in ~/.claude.json; use `--scope user` for all projects):

```bash
claude mcp add --transport http --scope local memorylayer \
  https://memorylayer-gateway.memory-layer.workers.dev/mcp \
  --header "Authorization: Bearer mlk_THEIR_TOKEN"
```

Verify inside Claude Code: `/mcp` shows `memorylayer` connected → ask it to
"read the shared context for project <space's project>".

⚠️ Never put the token in project `.mcp.json` — that file is committed.

### Cursor (native HTTP MCP)

Add to `~/.cursor/mcp.json` (GLOBAL file, not the project one — token safety):

```json
{
  "mcpServers": {
    "memorylayer": {
      "url": "https://memorylayer-gateway.memory-layer.workers.dev/mcp",
      "headers": { "Authorization": "Bearer mlk_THEIR_TOKEN" }
    }
  }
}
```

Verify: Cursor Settings → MCP shows the server green; ask the agent to call
`read_context`.

### Codex / any stdio-only client (bridge via mcp-remote)

In `~/.codex/config.toml`:

```toml
[mcp_servers.memorylayer]
command = "npx"
args = ["-y", "mcp-remote", "https://memorylayer-gateway.memory-layer.workers.dev/mcp",
        "--header", "Authorization: Bearer mlk_THEIR_TOKEN"]
```

### Claude Desktop

Settings → Connectors → Add custom connector → URL
`https://memorylayer-gateway.memory-layer.workers.dev/mcp`. If the UI has no
header field, use the mcp-remote bridge in
`claude_desktop_config.json` (same shape as the Codex block, under
`mcpServers`). Desktop is pull-only: tell members to say "read the shared
context" at chat start, or put it in their Desktop instructions.

---

## Gotchas learned live (check here first when something fails)

- Member on a dogfood machine that ALSO has the local stdio server: two
  servers exposing the same tool names confuses tool choice. For a clean
  remote test, name the remote server `memorylayer` and remove/disable the
  local `.mcp.json` entry in that project (or name the remote one
  `memorylayer-remote` and accept both).
- 401 = bad/revoked token or missing header. 403 on mint = wrong admin secret.
  404/`installation token exchange failed` on write = wrong installation id or
  App not installed on that repo. 409 = space repo has no commits on `main`.
- Project names are slugged: "My Project" ≡ `my-project`; different spelling =
  different project bucket.
- Reads show at most the 40 newest entries per project (Workers subrequest
  cap); `total` is still the true count.
- Hosted members have NO session-start auto-injection yet (Plan B ships the
  hook shim). Until then they read via the MCP tool — set expectations.

## Onboarded log

| Date | Team/space | Repo | Installation id | Members |
|---|---|---|---|---|
| 2026-07-05 | memorylayer (dogfood) | skandaramanan/MemoryLayer-Memory | 144657125 | Skanda |

## Self-onboarding to remote MCP (2026-07-07)

Cut this project (`MemoryLayer` repo itself) over from the local stdio server
to the hosted gateway, coexisting rather than replacing:

- Minted a fresh member token (ledger above) after confirming the
  2026-07-06 token was never actually written to KV (`wrangler kv key list`
  came back empty) — nothing to revoke, just re-minted.
- Registered it as a **separate** server named `memorylayer-remote`
  (`claude mcp add --transport http --scope local memorylayer-remote ...`),
  rather than reusing the name `memorylayer`, so the existing local stdio
  server in `.mcp.json` keeps working side by side. Both write
  byte-identical entries to the same space repo, so coexistence is safe at
  the data layer.
- Did **not** touch the SessionStart hooks in `.claude/settings.json` —
  those still inject from the local clone. The hosted `/hook/read` shim
  (`init --remote`) isn't shipped yet, so remote-only sessions have no
  auto-injection; only the MCP tool works for hosted reads for now.
- New MCP config lives in `~/.claude.json` (`--scope local`), not in any
  committed file — token never touches git.
