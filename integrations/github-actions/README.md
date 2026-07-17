# MemoryLayer GitHub Actions

> **Hosted-gateway teams:** you likely don't need this Action. Install the
> MemoryLayer GitHub App on your product repos and have the operator register
> them (`POST /admin/product-repos`) — merged PRs are then recorded by the
> gateway itself: no yml to copy, no token secrets in your repo. This Action
> remains the path for self-hosters running without the App.

## record-merged-pr.yml

Records every merged PR into the shared MemoryLayer store as a `context`
entry — title, number, author, merger, branches, a description excerpt, and
up to 10 commit subjects. It is the most reliable write path there is: no
model has to notice that shipped work is worth recording, and it captures
every collaborator's merges, including teammates who never touch the memory
tools directly.

### Setup

1. Copy [`record-merged-pr.yml`](record-merged-pr.yml) into your repo's
   `.github/workflows/`.
2. Edit the `MEMORYLAYER_PROJECT` env at the top to your project name.
3. Add two repository secrets (Settings → Secrets and variables → Actions):

   | Secret | Value |
   | --- | --- |
   | `MEMORYLAYER_MCP_URL` | Your gateway MCP endpoint, e.g. `https://your-gateway.workers.dev/mcp` |
   | `MEMORYLAYER_TOKEN` | A member token (`mlk_…`) minted for your team's space |

4. Test it: Actions → "Record merged PR to MemoryLayer" → **Run workflow**.
   Then confirm the smoke-test entry shows up via `search_memory` (or in the
   context repo) and delete it if you like.

### Notes

- **It can never break a merge.** Missing secrets skip quietly; every failure
  path (API error, timeout, bad token) exits 0.
- **Volume.** Every merged PR becomes one entry. For high-traffic repos, gate
  it on a label — see the comment at the top of the workflow file.
- **Dedupe.** The gateway's near-duplicate write gate and async supersession
  apply to these entries like any other write.
