I've explored the gateway's routing/CORS setup and found no `dashboard` codebase or a POST endpoint the task could obviously target — I need a few specifics before I can write a real plan instead of guessing.

**What I found:**
- CORS is already fully solved and global: `gateway/src/router.ts` answers every `OPTIONS` with 204 + `access-control-allow-origin: *`, and wraps every other response in `withCors()`. So a cross-origin dashboard POSTing JSON with `Content-Type: application/json` and an `Authorization` header will not be blocked by CORS today — nothing to add there.
- There is no `dashboard` directory, package, or frontend anywhere in this repo (checked git tree + grepped for "dashboard" — only unrelated Cloudflare-dashboard mentions).
- Existing browser-facing read endpoints (`/mcp/api/read`, `/mcp/api/plans`) are GET-only, authenticated via `resolveMember(req, env, ctx)` (bearer token), and are thin transport wrappers over service modules (`memory.ts`, `plans.ts`) — no POST endpoint exists for the dashboard to hit yet.
- A standing decision (`b213f40d#1emaqqt`) explicitly says plans are exposed via MCP tools only, with **no REST endpoint until Phase 3** — so if the POST is meant to create/edit a plan, building a new REST route now would contradict that decision unless you're saying we've reached Phase 3.

**What I need from you to plan the actual wiring:**

1. Where does the dashboard live — a separate repo/directory I should know about, or is this the first commit of a new frontend?
2. What is the POST actually for — writing a memory/context entry, an admin action, a plan mutation, something else?
3. Which gateway endpoint should it hit — an existing one (`/mcp` JSON-RPC, `/mcp/api/read`), or a new REST route we need to add?
4. How does the dashboard authenticate — same bearer/member token as the CLI/MCP clients, or a different session mechanism (e.g., cookie)?