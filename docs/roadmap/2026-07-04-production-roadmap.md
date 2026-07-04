# Production Roadmap — Free-Hosted, Multi-Tenant MemoryLayer

**Status:** Planning artifact only. Nothing here is built or approved for build. It
maps the whole path so the gating is visible.

**Date:** 2026-07-04

---

## Framing & assumptions

This roadmap answers one question: **given free-tier hosting and ~30 users, what is
the maximum capability MemoryLayer can reach — and in what order?**

Fixed assumptions (settled with the owner; change these and the roadmap changes):

- **"Free" means free-tier hosting** — $0 recurring infrastructure, not "zero infra."
  Free dev tooling (GitHub Actions, npm registry, GitHub App) counts as free.
- **Scale target: ~30 users across ~10 independent 2–3 person spaces**, with **hard
  tenant isolation** — space A never sees space B's memory. This is a multi-tenant
  shape. At this scale the free-tier *limits* are not the ceiling; the *architecture*
  is.
- **Sequencing: harden the core first, then host.** You cannot run a multi-tenant
  service on an unhardened single-user core.
- **The git thesis is non-negotiable.** Git remains the consistency layer and audit
  log ("we rent it, we don't rebuild it"). The hosted plane uses GitHub as storage —
  it does not replace git with a database.
- **This is a separate track from the SQLite-index product.** Read-scale / query
  performance lives on that roadmap. Where this roadmap bumps into it, it names the
  boundary and hands off rather than solving it here.

### Gating legend

Every item is tagged with when it may be built:

- `[pilot-blocking]` — needed for the 4-week 2–3 person pilot to not fall over. The
  only tier that could be built *before* proof-of-pull, and only the subset the pilot
  actually touches.
- `[gated-on-pull]` — build only once the core loop has demonstrably shown a pull of
  its own (the venture's standing guardrail).
- `[future]` — post-adoption; valuable but earns its place only after Phase 1 lands.

---

## Phase 0 — Harden the core (free, substrate for everything)

Prerequisite regardless of hosting: the hosted gateway just calls this core over the
network, so every core weakness becomes a multi-tenant weakness. Ordered by
*trust earned per unit of work*.

### 0.1 Data integrity — `[pilot-blocking]`

This is a memory product; **silent loss or silent reordering is fatal**. Concrete
gaps in the current `store.ts` / `git-repo.ts`:

- **Clock-skew reordering.** Write order is derived from `new Date().toISOString()`
  on each machine (`store.ts:97`). Two machines with skewed clocks interleave
  decisions in the wrong order for everyone. Mitigation to design: prefer commit
  order / a monotonic sequence, or record and surface both wall-clock and commit
  order so the projection isn't at the mercy of one laptop's clock.
- **Partial-write orphans.** `writeImpl` writes the file, then commits
  (`store.ts:109–117`). If the process dies between, an untracked `.md` orphan is
  left in the working tree. Design a reconcile-on-next-op sweep (commit or discard
  stray untracked entry files).
- **Rebase-retry gives up after one attempt.** `push()` rebases and retries exactly
  once (`git-repo.ts:70–86`). Under real concurrency across ~10 spaces the second
  push can also lose the race. Design bounded exponential retry.
- **Repair & backup path.** No `fsck`/repair, no backup guidance. Add a documented
  recovery story (the shared repo *is* the backup, but say so and verify it).
- **History-rewrite handling.** A force-push to the shared repo desyncs every clone's
  rebase-pull silently. Detect and surface it rather than fail-open into confusion.

### 0.2 Security — `[pilot-blocking]` (token audit) + `[gated-on-pull]` (injection stance)

- **Token-leakage audit — `[pilot-blocking]`.** A push token can live in
  `CONTEXT_REPO_URL`, the git remote config, thrown error strings
  (`git-repo.ts:80–84`), and potentially metrics. Audit every path so the token is
  never logged, echoed, or committed. Redact URLs in all surfaced errors.
- **Prompt-injection via shared context — `[gated-on-pull]`.** *Not currently
  tracked, and the sharpest production risk of a shared-memory tool:* any entry a
  collaborator writes is injected **verbatim** into every collaborator's
  session-start (that is the entire point of the read hook). A hostile or compromised
  writer can therefore inject instructions into everyone's agent. Design a stance:
  provenance/attribution shown at read time, an explicit "context is data, not
  instructions" wrapper around injected content, and a documented trust boundary
  (you trust your space's members). Isolation between spaces is enforced by Phase 1;
  *within* a space this is a policy + presentation problem.
- **Path traversal — already handled.** `slug()` collapses `../` to safe tokens
  (`store.ts:33–40`). Keep the test that proves it.
- **Env allowlist — already good.** Keep it; extend the allowlist deliberately, never
  by pattern.

### 0.3 Distribution & release — `[gated-on-pull]`

Today it installs from a raw `github:` ref with `dist/` committed. For strangers:

- Publish to npm with semver; keep `dist/` out of git and build in CI on release.
- Signed / provenance-attested releases (`npm publish --provenance` via GitHub
  Actions is free).
- `npx memorylayer …` support so trial needs no global install.
- A `CHANGELOG` discipline (the `/ship` flow already bumps VERSION/CHANGELOG).

### 0.4 Observability & diagnostics — `[pilot-blocking]` (doctor) + `[gated-on-pull]` (rest)

The core is **fail-open everywhere**, which is right for UX but means failures are
invisible — a support nightmare at 30 users.

- **`memorylayer doctor` / `status` — `[pilot-blocking]`.** One command that checks
  config presence, context-repo connectivity/auth, clone health, and last successful
  push. This is what turns "it's silently not working" into a two-second diagnosis.
- **Opt-in debug logging — `[gated-on-pull]`.** A `MEMORYLAYER_DEBUG` that turns the
  swallowed `catch {}` blocks into a local log, without ever breaking a session.
- **"Writes not pushed in N days" surfacing — `[gated-on-pull]`.** The self-heal push
  can retry forever in silence; surface prolonged un-pushed local state to the user.

### 0.5 CI — `[pilot-blocking]`

- GitHub Actions matrix (macOS/Linux × Node 18/20/22): lint, typecheck, `node --test`.
- An **integration test against an ephemeral git remote** (a temp bare repo) that
  exercises real clone/pull/commit/push and the concurrent-write path — the behavior
  unit tests can't cover and the thing most likely to break in production.

### 0.6 Onboarding UX — `[gated-on-pull]`

- `init` connectivity + auth check (fail early with a clear message, not at first
  write).
- Idempotent re-init (safe to run twice; today's behavior should be verified).
- A documented uninstall / cleanup path.

---

## Phase 1 — Free-hosted multi-tenant gateway (Approach 1) — `[gated-on-pull]`

**The spine, confirmed:** a **stateless MCP-over-HTTP gateway** on a free serverless
tier that uses a **GitHub App** as the storage plane, with **one private repo per
space**. No local git, no persistent disk, no always-on box. Tenant isolation falls
out of GitHub's own repo permissions + per-installation tokens. This preserves the
git thesis (GitHub is still the log) while fitting the most generous free tiers, with
headroom for thousands of users — not 30.

### Free-tier stack

| Concern | Service (free tier) | Why |
|---|---|---|
| Gateway / MCP-over-HTTP | Cloudflare Workers **or** Deno Deploy | ~100k req/day free; negligible cold start; no persistent process needed |
| Auth / routing state (user → space → installation) | Workers KV **or** Deno KV | Free key-value; tiny footprint |
| Storage plane (source of truth + audit log) | GitHub App, one **private repo per space** | Free; isolation via repo perms + scoped installation tokens; keeps git thesis |
| Secrets (App private key, signing keys) | Platform secret store (Workers secrets / Deno env) | Never in a repo |
| Static dashboard | Cloudflare Pages **or** GitHub Pages | Free static hosting, auth-gated |
| CI / releases | GitHub Actions | Free |

**Recurring cost: $0. Ceiling at this stack: thousands of users, not 30.**

### 1.1 The gateway — MCP over Streamable HTTP

Expose the same two tools (`read_context`, `write_context`) over MCP's Streamable
HTTP transport instead of stdio, so **closed clients reach it** — Claude Desktop, web,
anything that can't run local hooks. The tool contract is identical to the stdio
server; only the transport and the storage backend change.

### 1.2 Storage plane — reimplement store ops against the GitHub API

The bounded cost of Approach 1: `store.ts`/`git-repo.ts` assume a local clone and
child-process `git`. Serverless has neither. Reimplement the same operations against
GitHub's REST + Git Data (Trees/Blobs/Commits) API:

- **Write** = create a blob + a tree entry + a commit on the space's repo, authored as
  the user (attribution preserved). Per-author file paths keep concurrent writes
  conflict-free, exactly as today.
- **Read** = one **Trees API** call (recursive) to list, then batch-fetch entries.
- Keep the neutral projection/format layer (`context-format.ts`, `frontmatter.ts`)
  unchanged — only the git plumbing is swapped, mirroring how the store already
  isolates plumbing behind `GitRepo`.

### 1.3 Tenancy & isolation — the load-bearing correctness property

- **One private repo per space.** A space is a repo; membership is the GitHub App
  installation on that repo.
- **Never a global token.** Every request resolves to a **per-installation token
  scoped to exactly one space's repo**, minted per request. A routing bug then cannot
  hand space A's data to space B — the token literally can't read B.
- **Isolation tests are mandatory** and belong in the same suite as the gateway: prove
  a space-A credential cannot read/write space B under any tool call.

### 1.4 Auth & onboarding — kill the raw git token

Today the "shared key" is a raw git URL-with-token every user pastes. Replace with:

- The gateway issues a **per-user token bound to a space** (stored in KV). Users
  configure *that*, not a GitHub push token — the App holds the git credentials
  server-side.
- Space creation / member invite flow (can start CLI- or dashboard-driven).
- Result: onboarding a teammate no longer means handing them repo write access.

### 1.5 Read at hosted scale — boundary to the SQLite-index roadmap

Read is `list-tree + fetch-every-entry`; it grows O(n) and GitHub API calls are
rate-limited (5000/hr per installation — fine at 30 users, not free forever). The
**zero-new-dependency** mitigations that belong *here*: the recursive Trees API (one
call to list), conditional requests (ETags), and a short-lived KV cache of the
projection. **Anything beyond that — a real index/query engine — is the SQLite-index
roadmap. This roadmap stops at the cache and hands off.**

### 1.6 Free static dashboard — `[future]`

Auth-gated, read-only browse + curate of a space's memory on Cloudflare/GitHub Pages.
Turns "curate the store" from an agent-only act into something a human can see.

### 1.7 Metrics aggregation — `[future]`

Roll the per-author `metrics/*.jsonl` (already written) into a per-space view on the
dashboard. Data already exists; this is just presentation.

---

## Phase 2 — Beyond free — `[future]`

Named only so the cliff is visible, not planned:

- **When you'd outgrow free tiers:** sustained >100k gateway req/day, GitHub API rate
  pressure across many active spaces, or a need for real-time push. The first paid
  step is likely a small always-on cache/index service — which is where this roadmap
  and the SQLite-index roadmap finally converge.
- **Real-time cross-user sync into Claude Desktop remains client-limited**, not
  server-limited: a hosted server still cannot *push* into Desktop (no hook system).
  The hosted gateway makes Desktop's *pull* reliable and tokenless; it cannot make it
  automatic. State this honestly to users.

---

## Risk register

| Risk | Severity | Where addressed |
|---|---|---|
| **Cross-tenant leakage** (routing bug serves wrong space) | Critical | 1.3 — per-space scoped tokens + isolation tests |
| **Prompt-injection via shared context** | High | 0.2 — provenance + data-not-instructions framing |
| **Silent write loss / reordering** (clock skew, orphan, retry) | High | 0.1 |
| **Token leakage** (URL/remote/error/metrics) | High | 0.2 |
| **Secret management** (App private key) | High | Platform secret store; never in repo |
| **GitHub API rate limits** at growth | Medium | 1.5 — Trees API + ETag + KV cache; then SQLite track |
| **MCP HTTP-transport / auth spec churn** | Medium | Pin transport version; keep tool contract stable |
| **Desktop cannot be pushed to** (client limit) | Low (expectation-setting) | Phase 2 note |

---

## Explicit non-goals / boundaries

- **SQLite index & query performance** — separate roadmap. This one hands off at the
  KV cache.
- **No custom merge engine** — git remains the merge engine (per-author files).
- **No accounts beyond per-space membership** at this scale — no org hierarchy, no
  RBAC matrix, no SSO until well past 30 users.
- **No paid infra** anywhere in Phase 0 or Phase 1.

---

## Open questions (resolve before any Phase 1 build)

1. **Gateway platform:** Cloudflare Workers vs. Deno Deploy — decide on the MCP
   Streamable-HTTP SDK ergonomics and KV story, not price (both free).
2. **Space provisioning:** who creates a space's GitHub repo + installs the App — a
   CLI command, or the dashboard? (Affects whether 1.6 is `[future]` or moves up.)
3. **Migration:** do existing pilot spaces (raw-git-token model) need a one-time
   import into the App-managed model, or do they coexist?
