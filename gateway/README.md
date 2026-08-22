# Wayform Hosted Gateway

Stateless MCP-over-HTTP gateway on Cloudflare Workers. Same tools as the local
CLI (`read_context`, `write_context`, `search_memory`, plus in-agent invite),
same on-disk entry format, stored in a GitHub-App-managed **private repo per
team space**. Members sign in with GitHub. They never copy a Wayform token.

Production:

- Gateway: `https://memorylayer-gateway.memory-layer.workers.dev`
- GitHub App: `https://github.com/apps/memorylayer-gateway`
- CLI: `wayform`

There are three roles in a hosted deployment:

| Role | Does what | How often |
|---|---|---|
| **Gateway operator** | Deploys the Worker, owns the GitHub App, allowlists new teams | Once, then one KV put per new client |
| **Team leader** | Creates a private memory repo, clicks Connect, installs the App on that repo | Once per team |
| **Member** | Clicks Connect (or `claude mcp login` / `codex mcp login` / `wayform login`) | Once per person |

One gateway serves many spaces. Spaces cannot see each other — isolation is
enforced by GitHub's own repo permissions, not by gateway code (see
[Tenancy model](#tenancy-model)).

Invite codes (`wfi_`) and member API keys (`mlk_`) are **retired**. See
[Tenancy model](#tenancy-model). The 2026-07-20 invite-code join design is
superseded by GitHub-username invite + OAuth.

---

## Part 1 — Gateway operator: deploy once

Prerequisites: a free Cloudflare account, a GitHub account, Node ≥ 20,
`openssl`.

### 1.1 Cloudflare: login + KV namespace

```bash
cd gateway
npx wrangler login                        # browser auth
npx wrangler kv namespace create ROUTING  # prints an id
```

Paste the printed id into `wrangler.toml` (`kv_namespaces` → `id` for both
`ROUTING` and `OAUTH_KV`; they may share one namespace until grants need
isolation). Enable `global_fetch_strictly_public` (already in `wrangler.toml`)
so CIMD is advertised.

### 1.2 GitHub App: create it

At <https://github.com/settings/apps> → **New GitHub App** (production App is
already `memorylayer-gateway`):

- **Name:** anything globally unique (e.g. `memorylayer-gateway-<you>`)
- **Homepage URL:** this repo's URL
- **Callback URL:** `https://<gateway>/callback`
- **Webhook:** **Active**. Payload URL `https://<gateway>/webhook/github`,
  content type `application/json`, secret = `WEBHOOK_SECRET`. Subscribe to
  **Meta** plus **Installation**, **Installation repositories**, **Push**, and
  **Pull request** (merged-PR recorder).
- **Permissions:** Repository **Contents → Read and write**. Pull requests
  **Read** if you use the merged-PR recorder.
- **Where can this App be installed?** **Any account** so team leaders host
  the memory repo in their own GitHub.

After creating: note the **App ID** (numeric) and the **Client ID** (`Iv1.…` —
this is `GITHUB_CLIENT_ID`, not the App ID). Generate a private key (`.pem`)
and a **Client secret** (`GITHUB_CLIENT_SECRET`).

### 1.3 Convert the key and set secrets

GitHub ships the key as PKCS#1; Workers' WebCrypto needs PKCS#8:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in ~/Downloads/<your-app>.*.private-key.pem -out app-pkcs8.pem

npx wrangler secret put GITHUB_APP_ID                      # numeric App ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < app-pkcs8.pem
npx wrangler secret put GITHUB_CLIENT_ID                   # Iv1.…
npx wrangler secret put GITHUB_CLIENT_SECRET               # App client secret
openssl rand -hex 32
npx wrangler secret put ADMIN_SECRET                       # operator eval/allowlist only
openssl rand -hex 32
npx wrangler secret put WEBHOOK_SECRET                     # GitHub App webhook HMAC
npm run deploy
rm app-pkcs8.pem                                           # never leave the key on disk
```

`deploy` prints the gateway URL: `https://<worker>.<subdomain>.workers.dev`.

### 1.4 Verify

```bash
curl --tlsv1.2 -s https://<gateway>/health     # → {"ok":true}
curl --tlsv1.2 -s https://<gateway>/mcp        # → 401 + WWW-Authenticate
```

(macOS system curl needs `--tlsv1.2` against workers.dev — a LibreSSL quirk;
SDK clients are unaffected.)

`ADMIN_SECRET` gates operator routes only (`/admin/allowlist`, reindex, eval,
product-repos). It does **not** mint members. If it leaks, rotate it with
`npx wrangler secret put ADMIN_SECRET`; GitHub identities are unchanged.

Allowlist a new team (no secret is created or sent to them):

```bash
curl --tlsv1.2 -s -X POST https://<gateway>/admin/allowlist \
  -H "x-admin-secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{"add":["their-github-login-or-org"]}'
```

---

## Part 2 — Team leader: onboard your team's space

You need: a GitHub account and the MCP URL from the operator. The operator
does **not** create your repo, install the App, or send a token.

### 2.1 Create the space repo

Create a **private** repo in your own account — e.g. `yourteam-memory`. Empty
is fine, but it must have at least one commit on `main` (initialize with a
README). This repo **is** your team's memory: every decision lands here as a
commit, and you keep full ownership and history.

### 2.2 Connect and install the GitHub App

In Cursor (or Claude/Codex), add an MCP server with this URL and nothing else:

`https://memorylayer-gateway.memory-layer.workers.dev/mcp`

Click **Connect**. Browser opens GitHub. Log in and authorize. When GitHub
asks which repos to install the Wayform app on, pick **only** that private
memory repo.

Because the operator already allowlisted you, Wayform activates the space.
You are admin. Writes are attributed to your GitHub name.

If you were not on the allowlist, GitHub login still works, then you get a
design-partner preview page. No space, no writes, no extract.

> Why this is safe to install: the App gets **Contents read/write on exactly
> the repo you selected** — GitHub enforces that scope, not the gateway. It
> cannot see your other repos. Uninstalling it (repo settings → Integrations)
> instantly cuts the whole space off.

### 2.3 Hook login (once per machine)

```bash
npm i -g wayform
wayform init --remote --yes
wayform login
wayform doctor
```

Restart the agent. Session-start hooks send a short-lived Bearer from the OS
keychain. If you are logged out they fail-open (existing contract); doctor
says `run: wayform login`.

### 2.4 Verify the space works (~1 minute)

Ask the agent to record a test decision, start a new chat, and confirm it is
already in context. Check the memory repo on GitHub: a new commit, authored
as you.

### 2.5 Ongoing space administration (in-agent, no dashboard)

| Need | How |
|---|---|
| Add a member | In Cursor: `invite <github-username> to this Wayform space` (`invite_member`). They click Connect. |
| Org teammate | Installing the App on an org repo auto-joins org members who OAuth in. |
| Remove a member | `revoke_member` with their GitHub username. |
| Nuke the whole space | Uninstall the App from the repo. Every member's GitHub writes die; the repo stays yours. |
| Read the memory as a human | It's a git repo — browse it on GitHub or clone it. |

---

## Part 3 — Member: connect your client

Config files contain **only** the MCP URL. Tokens live in the client / OS
keychain after browser OAuth.

**Cursor**

```json
{ "mcpServers": { "wayform": { "url": "https://memorylayer-gateway.memory-layer.workers.dev/mcp" } } }
```

Click **Connect**.

**Claude Code**

```bash
claude mcp add --transport http wayform https://memorylayer-gateway.memory-layer.workers.dev/mcp
claude mcp login wayform
```

No `--header`.

**Codex**

```toml
[mcp_servers.wayform]
url = "https://memorylayer-gateway.memory-layer.workers.dev/mcp"
auth = "oauth"
```

Then `codex mcp login wayform`.

**Hooks**

`.memorylayer-hook.env` has URL + project + author only. Once per machine:
`wayform login`. Commit the URL-only MCP configs to the **product** repo so
later teammates only click Connect.

ChatGPT custom connectors with a path token (`/mcp/mlk_…`) are **out of
scope**. Headless grants are not part of this onboarding.

## Relevance index (Phase A)

The gateway can serve **query-conditioned, relevance-ranked** retrieval over a
space's whole history — not just the most recent entries — via a disposable
index in D1 (roadmap `docs/roadmap/2026-07-07-remote-relevance-engine.md`,
Phase A). It is entirely derived from the git ledger and rebuildable from
scratch, so there is no new source of truth and no data to migrate. It is
**optional**: with no `DB` binding the gateway falls back to the recency reads
described above, unchanged.

### One-time provisioning (operator)

```bash
cd gateway
npx wrangler d1 create memorylayer-index          # prints database_id
# paste database_id into wrangler.toml ([[d1_databases]] → database_id)
npx wrangler d1 migrations apply memorylayer-index --remote
openssl rand -hex 32
npx wrangler secret put WEBHOOK_SECRET            # paste it; used for webhook HMAC
npm run deploy
```

The `[ai]` binding (Workers AI, model `@cf/baai/bge-base-en-v1.5`) and the
`[triggers]` cron are already declared in `wrangler.toml`. With no `AI`
binding the pipeline still runs keyword (BM25) ranking; embeddings just make
paraphrase matches work too.

### GitHub App webhook events

Part 1.2 already enables the webhook. Subscribe to **Pushes**, **Installation**,
and **Installation repositories** (plus **Pull request** if you use the merged-PR
recorder). Pushes index the ledger within seconds; a missed webhook is caught
by the cron reconciler within 15 minutes (it compares each space's indexed sha
to the ledger HEAD). Installation events provision the space.

### Backfill existing entries

The spaces registry is populated when a GitHub App installation is activated.
Rebuild every registered space from the ledger:

```bash
curl --tlsv1.2 -s -X POST https://<gateway>/admin/reindex \
  -H "x-admin-secret: $ADMIN_SECRET" -d '{}'
# → {"reindexed":{"<space>":<entry-count>, ...}}
# scope to one repo with -d '{"repo":"owner/name"}'
```

### New retrieval surface

- `read_context` gains an optional `query` — when set, returns relevance-ranked
  matches from the whole indexed history instead of the recency window.
- `search_memory(query, project?, kinds?)` — a dedicated whole-space search tool
  (both planes; the local CLI proxies to `GET /api/read`).
- `GET /api/read` — JSON read endpoint the local CLI uses for remote-first reads.
- Every query-conditioned retrieval is logged to the `retrieval_log` table in
  D1 (trigger, query, returned ids+scores, injected flag) — the calibration
  data Phases B/C build on.

### Local client: turn on remote-first reads

`.memorylayer-hook.env` keeps the gateway URL + identity only. After
`wayform login`, the session hook and `read_context`/`search_memory` send a
short-lived Bearer from the OS keychain, falling back to the local clone when
the gateway is unreachable (hosted-only members fail-open to empty context).

### Degradation (every layer fails open)

| Condition | Behavior |
|---|---|
| No `DB` binding | Recency reads only; `search_memory` reports "not enabled". |
| No `AI` binding | BM25 (keyword) ranking only — no semantic matches. |
| Webhook dropped | Cron reconciler reindexes within 15 min via sha drift. |
| Gateway unreachable from CLI | Local clone serves the read (offline fallback). |

## Relevance index (Phase B1) — facts & briefing

Phase B1 replaces Phase A's one-doc-per-entry indexing with **LLM-extracted
atomic facts**, entity tags, a **canon** tier, and a selective session-start
**briefing + topic manifest**. All of it lives in the gateway; the local plane
inherits it via the remote-first reads above (no local changes).

### What changed

- **Ingest extracts facts.** Each ledger entry is condensed by Workers AI text-gen
  (`@cf/meta/llama-3.1-8b-instruct`, $0 free-tier) into 1–5 atomic facts, each
  embedded with `bge-base-en-v1.5`. A fact is a `docs` row with a synthetic id
  `<entry-id>#<n>` and a `source_id` grouping its set. **Fail-open:** if the model
  is absent, errors, or returns invalid JSON, the entry is indexed whole as one
  `normal` fact — exactly Phase A behavior, so recall never regresses.
- **Idempotent re-ingest.** Re-indexing an entry (webhook re-fire, cron, reindex)
  runs delete-then-insert by `source_id`, so non-deterministic extraction never
  leaves duplicate or orphan facts.
- **Canon tier + entity tags** feed retrieval: canon facts get a ranking boost,
  and an entity-tag candidate generator joins BM25 + cosine (three recall paths).
- **Session-start briefing.** `/hook/read` now returns canon facts + open
  questions + decisions from the last 7 days + a one-line topic manifest
  (`memory covers: <entity> (<n>), …`) instead of a raw recency dump. If the index
  is empty or unavailable it falls back to the verbatim Phase A recency dump.
- **Gateway write path is async.** `write_context` returns immediately and ingests
  via `ctx.waitUntil` (extraction would otherwise add ~1–3 s per write); the entry
  is already committed and served by the recency read, so this costs only seconds
  of eventual consistency on the extracted view.

### Apply the migration + backfill (once, after deploy)

```bash
wrangler deploy
wrangler d1 migrations apply memorylayer-index            # local
wrangler d1 migrations apply memorylayer-index --remote   # production

# Rebuild every fact from the ledger for each space (extraction + embeddings):
curl -sX POST https://<gateway>/admin/reindex \
  -H "x-admin-secret: $ADMIN_SECRET"
# large/old spaces: paginate with -d '{"limit":40}' and repeat until nextOffset is null
```

Verify: `search_memory` for the Cursor topic returns the atomic
project-scoped-config fact, and `/hook/read` shows a topic manifest. The
extraction-fidelity audit (B1 exit gate) samples these backfilled facts against
their source entries.

## Relevance index (Phase B2) — supersession & conflicts

Phase B2 adds **fact lifecycle** on top of B1's atomic facts:

- **Async auto-supersession** on ingest: entity-scoped cosine candidates → LLM
  judge → `superseded_by` write **only** on a clear `replaces` verdict.
- **Sync conflict surfacing** on every `write_context`: embeds the raw payload,
  judges top live facts, returns `contradicts` and `uncertain` hits in the tool
  response (~100–500 ms; write already committed).
- **Author override:** optional `supersedes: ["fact-id", ...]` on
  `write_context` skips conflict checks for those ids and links without judge.
- **Briefing:** session-start text includes an **Unresolved conflicts** section
  from recent `contradicts`/`uncertain` log rows (last 7 days).
- **Audit:** every judgment is logged to `supersession_log` in D1.

### Apply migration + first B2 deploy

```bash
wrangler deploy
wrangler d1 migrations apply memorylayer-index --remote

# First B2 deploy on an existing index: clear stale edges, then rebuild facts
curl -sX POST https://<gateway>/admin/reindex \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"clearSupersession": true}'
```

### Operator tools

```bash
# Sample auto-linked edges for the B2 exit audit
curl -s "https://<gateway>/admin/supersession-audit?space=<space>&limit=20" \
  -H "x-admin-secret: $ADMIN_SECRET"

# Full recent verdict trail (not just auto-links)
curl -s "https://<gateway>/admin/supersession-audit?space=<space>&auto_linked_only=0" \
  -H "x-admin-secret: $ADMIN_SECRET"

# Recovery if a bad deploy auto-linked wrongly (does not reindex)
curl -sX POST https://<gateway>/admin/clear-supersession \
  -H "x-admin-secret: $ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"space":"<space>"}'
```

B2 exit criterion: supersession-accuracy audit passes on sampled auto-links (zero
false supersessions on the sample at pilot scale).

## Reference

### Endpoints

OAuth 2.1 (MCP clients; `workers-oauth-provider`):

- `GET /.well-known/oauth-protected-resource` — RFC 9728 metadata
- `GET /.well-known/oauth-authorization-server` — AS metadata (PKCE S256)
- `POST /oauth/register` — dynamic client registration
- `GET /authorize`, `POST /authorize/consent`, `GET /callback` — GitHub App user OAuth
- `POST /oauth/token` — authorization_code / refresh_token

Member plane (OAuth access token required; unauthenticated and `mlk_` bearers get `401` + `WWW-Authenticate`):

- `POST /mcp` — MCP Streamable HTTP
- `GET /hook/read?project=<name>[&budget=<n>]` — session-start briefing
- `POST /hook/prompt` — Claude UserPromptSubmit injection
- `GET /api/read?project=<name>[&query=<q>][&budget=<n>][&kinds=a,b][&trigger=<t>]`

Outside the member OAuth plane:

- `POST /webhook/github` — GitHub App webhook (HMAC-signed, `WEBHOOK_SECRET`)
- `POST /admin/allowlist` — `{ "add": ["login-or-org"] }` (`x-admin-secret`)
- `GET /admin/allowlist`
- `POST /admin/reindex` — rebuild spaces from the ledger (`x-admin-secret`)
- `GET /admin/supersession-audit`, `POST /admin/clear-supersession`
- `POST /admin/product-repos` — merged-PR recorder registry
- `GET /admin/installations?owner=` — lookup App installation id
- `GET /health`

Retired (404): `POST /admin/members`, `POST /admin/invites`, `POST /join`.
`ADMIN_SECRET` is **not** used to mint members.

### Tenancy model

One private GitHub repo per space; the App is installed on exactly that repo.
Members are keyed by `github_id` after GitHub App user-to-server OAuth. Every
GitHub call uses a per-installation token that **GitHub itself** scopes to that
one repo. No authenticated API surface accepts a repo/space parameter.
`write_context.author` is ignored: attribution comes from the GitHub user.

New spaces activate only if the repo owner or org is on the KV allowlist
(`signup:allowlist`). Teammates of an already-active space OAuth in without
being on the list (org membership or `invite_member`). Unknown installers see
a design-partner preview page — no space, no writes, no extract. Space records
carry `plan=pilot` for later billing; extract spend stays on the account-wide
neuron cap.

### Limits (Workers free plan)

- 100k requests/day, no cold-sleep (isolates, not containers).
- 50 subrequests/request → reads fetch at most the **40 newest** entry files
  (`MAX_ENTRY_FETCH`); `total` still reports the full count.
- GitHub API: 5,000 req/hr **per installation** — every space gets its own
  quota by design.
- Workers AI: account-wide neuron budget (see `neuron-budget.ts`).

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| `curl` TLS handshake failure on macOS | Add `--tlsv1.2` (LibreSSL quirk; workers.dev only). |
| `401` on `/mcp` or `/hook/read` | Not logged in, or the OAuth grant expired. Click Connect / `wayform login`. `mlk_` bearers are rejected. |
| Browser shows design-partner preview | GitHub user/org is not on the allowlist and they are not joining an existing space. |
| `403` on `/admin/allowlist` | Wrong `x-admin-secret`. |
| Write fails with `404`/`installation token exchange failed` | App not installed on that repo, or the installation was suspended/deleted. |
| Write fails with `409`/branch error | Space repo has no commits, or the space record's `branch` doesn't exist. Initialize the repo with a README. |
| Reads return nothing but writes work | Project names are slugged (lowercased, punctuation → `-`). |
| Team leader can't install the App | App is set to "Only on this account" — operator flips it to "Any account" (App settings → Advanced). |

### Deploy internals

Full provisioning notes live with the Worker. Development: `npm test` in this
directory (Node ≥ 20); the Worker entry is `dist/gateway/src/worker.js` after
`npm run build`.
