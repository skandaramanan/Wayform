# MemoryLayer Hosted Gateway

Stateless MCP-over-HTTP gateway on Cloudflare Workers. Same two tools as the
local stdio server (`read_context`, `write_context`), same on-disk entry
format, stored in a GitHub-App-managed private repo per space.

## Endpoints
- `POST /mcp` — MCP Streamable HTTP (stateless JSON): `Authorization: Bearer mlk_...`
- `GET /hook/read?project=<name>` — plain-text session-start context (60s per-space cache, invalidated on write)
- `POST /admin/members` — mint a member token (`x-admin-secret` header)
- `GET /health`

## Tenancy model
One private GitHub repo per space; the GitHub App is installed on exactly that
repo. A member token maps (via SHA-256 hash in KV) to one space record; every
GitHub call uses a per-installation token scoped to that one repo. No API
surface accepts a repo/space parameter — isolation is by construction.
`write_context.author` is ignored: attribution comes from the token.

## Interop
Entries written here are byte-identical to local-tool entries (shared
`src/frontmatter.ts`). A space repo can be used by hosted members and local
raw-git-token members simultaneously.

## Limits (Workers free plan)
- 50 subrequests/request → reads fetch at most the 40 newest entry files
  (`MAX_ENTRY_FETCH`); `total` still reports the full count.
- GitHub API: 5,000 req/hr **per installation** — per-space quota by design.

## Deploy
See Task 8 of docs/plans/2026-07-05-hosted-gateway-core.md (provisioning
runbook: KV namespace, GitHub App, PKCS#8 key conversion, secrets, smoke).

## Client config (any MCP HTTP client)
    { "url": "https://<worker>/mcp", "headers": { "Authorization": "Bearer mlk_..." } }
