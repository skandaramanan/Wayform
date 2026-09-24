I looked for a dashboard app in this repo and found none — this repo is only the `wayform` CLI and the `gateway` Cloudflare Worker (the API). I also found that CORS is already fully wired for every route (`gateway/src/router.ts:33-48`): wildcard origin, `GET, POST, OPTIONS`, and `content-type, authorization` headers, stamped on every response including OPTIONS preflight. So the "different domain can't POST JSON" problem is already solved at the transport level for any browser client hitting this API.

That means the real work is more specific than it first sounds, and I need to pin down a few things before planning:

1. **Which API surface is the dashboard POSTing to?**
   - The existing `/mcp` JSON-RPC endpoint (stateless, one POST = one JSON-RPC tool call — e.g. `write_context`, `read_plan`), which is already fully wired for cross-origin POST, or
   - A new plain-REST endpoint (not JSON-RPC) for one specific action the dashboard needs, mirroring how `/mcp/api/read` and `/mcp/api/plans` exist as plain-GET wrappers around MCP tools?

2. **Is the dashboard's codebase outside this repo** (so this task is purely gateway-side: expose/confirm an endpoint + auth), or do you also want a small fetch/client snippet committed here for the dashboard to use?

3. **What auth will the dashboard send?** The existing member routes (`resolveMember` in `gateway/src/tenancy.ts:84`) require a bearer token resolved through the GitHub OAuth flow (`ctx.props.githubId`). Is that the same token the dashboard will hold (e.g., user already completed OAuth elsewhere and the dashboard has the member token), or does the dashboard need a different/lighter auth path?

Once I know which of these, I can write a concrete plan — right now "wire the dashboard to POST JSON" could mean anything from "nothing to do, it already works" to "add a new REST endpoint + auth path." Let me know and I'll finalize the plan.