# MemoryLayer Hosted Gateway

Stateless MCP-over-HTTP gateway on Cloudflare Workers. Same two tools as the
local stdio server (`read_context`, `write_context`), same on-disk entry
format, stored in a GitHub-App-managed **private repo per team space**. Members
join with a URL and a token — no git credentials, no local install.

There are three roles in a hosted deployment:

| Role | Does what | How often |
|---|---|---|
| **Gateway operator** | Deploys the Worker, owns the GitHub App and the admin secret | Once |
| **Team leader** | Creates their team's space: one private repo + App install; requests member tokens | Once per team |
| **Member** | Pastes a URL + token into their MCP client | Once per person |

One gateway serves many spaces. Spaces cannot see each other — isolation is
enforced by GitHub's own repo permissions, not by gateway code (see
[Tenancy model](#tenancy-model)).

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

Paste the printed id into `wrangler.toml` (`kv_namespaces` → `id`).

### 1.2 GitHub App: create it

At <https://github.com/settings/apps> → **New GitHub App**:

- **Name:** anything globally unique (e.g. `memorylayer-gateway-<you>`)
- **Homepage URL:** this repo's URL
- **Webhook:** ⚠️ *uncheck "Active"* (no webhook needed)
- **Repository permissions:** **Contents → Read and write.** Nothing else.
- **Where can this App be installed?** — this choice matters:
  - *Only on this account* → only repos you own can be spaces (fine for
    dogfood)
  - **Any account** → team leaders can host their space repo in *their own*
    GitHub account, which is the intended multi-team model. **Pick this (or
    flip it later under App settings → Advanced) before onboarding an external
    team** — otherwise their App install will fail.

After creating: note the **App ID** (top of the App settings page), then
**Generate a private key** (downloads a `.pem`).

### 1.3 Convert the key and set secrets

GitHub ships the key as PKCS#1; Workers' WebCrypto needs PKCS#8:

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in ~/Downloads/<your-app>.*.private-key.pem -out app-pkcs8.pem

npx wrangler secret put GITHUB_APP_ID                      # the App ID number
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < app-pkcs8.pem
openssl rand -hex 32                                       # generate admin secret
npx wrangler secret put ADMIN_SECRET                       # paste it; ALSO save it
                                                           # in a password manager
npm run deploy
rm app-pkcs8.pem                                           # never leave the key on disk
```

`deploy` prints the gateway URL: `https://<worker>.<subdomain>.workers.dev`.

### 1.4 Verify

```bash
curl --tlsv1.2 -s https://<gateway>/health     # → {"ok":true}
```

(macOS system curl needs `--tlsv1.2` against workers.dev — a LibreSSL quirk;
SDK clients are unaffected.)

The **admin secret is the master key for minting member tokens** — treat it
like a root credential. If it ever leaks, re-run
`npx wrangler secret put ADMIN_SECRET` with a new value; existing member
tokens keep working.

---

## Part 2 — Team leader: onboard your team's space

You need: a GitHub account, ~10 minutes, and the gateway operator reachable
(they run one command per member for you).

### 2.1 Create the space repo

Create a **private** repo in your own account — e.g. `yourteam-memory`. Empty
is fine, but it must have at least one commit on `main` (initialize with a
README). This repo **is** your team's memory: every decision lands here as a
commit, and you keep full ownership and history.

### 2.2 Install the GitHub App on that repo — and only that repo

Open the App's install page (the operator gives you the link,
`https://github.com/apps/<app-name>`) → **Install** → choose your account →
**"Only select repositories"** → pick your space repo → Install.

You land on `github.com/settings/installations/<NUMBER>` — that number is your
**installation id**. Send it to the operator along with your repo's
owner/name.

> Why this is safe to install: the App gets **Contents read/write on exactly
> the repo you selected** — GitHub enforces that scope, not the gateway. It
> cannot see your other repos. Uninstalling it (repo settings → Integrations)
> instantly cuts the whole space off.

### 2.3 Get member tokens minted (operator runs this)

One per member — each token carries that member's identity, which becomes the
commit attribution on everything they write:

```bash
curl --tlsv1.2 -s -X POST https://<gateway>/admin/members \
  -H "x-admin-secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{
    "space": "yourteam",
    "installationId": <NUMBER>,
    "owner": "<github-user>",
    "repo": "yourteam-memory",
    "author": "Ada Lovelace",
    "authorEmail": "ada@yourteam.io"
  }'
# → {"token":"mlk_...","member":{...}}
```

Notes for the operator:

- `branch` defaults to `main`; pass it only for a non-default branch.
- **The raw token is shown exactly once** and stored server-side only as a
  SHA-256 hash. Before handing it off, record its hash so you can revoke it
  later: `printf '%s' 'mlk_...' | shasum -a 256`.
- Deliver tokens over a reasonable channel (password manager share, not group
  chat).

### 2.4 Hand each member their config

Each member gets: the gateway URL + their personal `mlk_...` token. That's the
entire onboarding. See Part 3.

### 2.5 Verify the space works (leader smoke test, ~1 minute)

```bash
TOK=mlk_...   # your own member token
curl --tlsv1.2 -s -X POST https://<gateway>/mcp \
  -H "authorization: Bearer $TOK" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write_context","arguments":{"project":"onboarding","type":"context","payload":"space is live"}}}'
```

Expect `"Recorded context in 'onboarding' as <you> ..."` — then check your
space repo on GitHub: there's a new commit, authored by you, containing
`context/onboarding/<you>/....md`. That commit is the product working.

### 2.6 Ongoing space administration

| Need | How |
|---|---|
| Add a member | Operator mints another token (2.3). |
| Remove a member | Operator deletes their KV record: `npx wrangler kv key delete --namespace-id <KV_ID> "member:<sha256-of-token>"` (this is why 2.3 records hashes). Takes effect immediately. |
| Member lost their token | Revoke the old one (above), mint a new one. Tokens are never recoverable — only replaceable. |
| Nuke the whole space | Uninstall the App from the repo (repo → Settings → GitHub Apps). Every member's access dies at once; your repo and its history remain yours, untouched. |
| Read the memory as a human | It's a git repo — browse it on GitHub or clone it. Entries are plain markdown with frontmatter. |
| Use hosted + local together | Fine by design: local (git-token) members and hosted members can share one space repo — entries are byte-identical. |

---

## Part 3 — Member: connect your client

Any MCP client that speaks Streamable HTTP:

```json
{
  "url": "https://<gateway>/mcp",
  "headers": { "Authorization": "Bearer mlk_..." }
}
```

For Claude Code, that's an entry in `.mcp.json`; most other MCP clients have
an equivalent HTTP-server config. You get `read_context` and `write_context`
immediately.

Session-start auto-injection for hosted members (the `/hook/read` endpoint
below) has a thin client shim coming in the next increment (`init --remote`);
until then, hosted members read via the MCP tool.

---

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

### GitHub App webhook (indexes local-plane `git push` writes)

In the App settings → **Webhook**: set **Active**, **Payload URL**
`https://<gateway>/webhook/github`, **Content type** `application/json`,
**Secret** = the same `WEBHOOK_SECRET`, and subscribe to **Pushes only**. A
member's `git push` is then indexed within seconds; a missed webhook is caught
by the cron reconciler within 15 minutes (it compares each space's indexed sha
to the ledger HEAD).

### Backfill existing entries

The spaces registry is populated as members are minted. For spaces minted
before this release, re-run the mint (2.3) once per space (or re-POST the same
member body) so the repo registers, then rebuild every registered space from
the ledger:

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

Set these in a project's `.memorylayer-hook.env` (or the environment):

```
MEMORYLAYER_GATEWAY_URL=https://<gateway>
MEMORYLAYER_GATEWAY_TOKEN=mlk_...
```

The session hook and `read_context`/`search_memory` then read from the gateway
index, falling back to the local clone when the gateway is unreachable. Without
these vars (or offline), the CLI behaves exactly as before.

### Degradation (every layer fails open)

| Condition | Behavior |
|---|---|
| No `DB` binding | Recency reads only; `search_memory` reports "not enabled". |
| No `AI` binding | BM25 (keyword) ranking only — no semantic matches. |
| Webhook dropped | Cron reconciler reindexes within 15 min via sha drift. |
| Gateway unreachable from CLI | Local clone serves the read (offline fallback). |

## Reference

### Endpoints

- `POST /mcp` — MCP Streamable HTTP (stateless JSON). `Authorization: Bearer mlk_...`
- `GET /hook/read?project=<name>[&budget=<n>]` — plain-text, ready-to-inject
  session context (60s per-space cache, invalidated on write; empty 200 body
  when the project has no entries)
- `GET /api/read?project=<name>[&query=<q>][&budget=<n>][&kinds=a,b][&trigger=<t>]`
  — JSON read (`{text,total,matched}`); `query` runs the relevance pipeline,
  absent = recency read. `Authorization: Bearer mlk_...`
- `POST /webhook/github` — GitHub push webhook (HMAC-signed, `WEBHOOK_SECRET`)
- `POST /admin/reindex` — rebuild spaces from the ledger (`x-admin-secret`);
  optional body `{"repo":"owner/name"}` to scope to one space
- `POST /admin/members` — mint a member token (`x-admin-secret` header)
- `GET /health`

### Tenancy model

One private GitHub repo per space; the App is installed on exactly that repo.
A member token maps (via SHA-256 hash in Workers KV) to one space record;
every GitHub call uses a per-installation token that **GitHub itself** scopes
to that one repo. No authenticated API surface accepts a repo/space parameter
— a routing bug cannot cross tenants because the credential can't.
`write_context.author` is ignored: attribution always comes from the
authenticated token, so members cannot write as each other.

### Limits (Workers free plan — $0 at pilot scale)

- 100k requests/day, no cold-sleep (isolates, not containers).
- 50 subrequests/request → reads fetch at most the **40 newest** entry files
  (`MAX_ENTRY_FETCH`); `total` still reports the full count.
- GitHub API: 5,000 req/hr **per installation** — every space gets its own
  quota by design.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| `curl` TLS handshake failure on macOS | Add `--tlsv1.2` (LibreSSL quirk; workers.dev only). |
| `401` on `/mcp` or `/hook/read` | Missing/typo'd `Authorization: Bearer` header, or the token was revoked. |
| `403` on `/admin/members` | Wrong `x-admin-secret`. |
| Write fails with `404`/`installation token exchange failed` | App not installed on that repo, wrong `installationId`, or owner/repo typo in the member record. Re-check 2.2's number. |
| Write fails with `409`/branch error | Space repo has no commits, or member record's `branch` doesn't exist. Initialize the repo with a README. |
| Reads return nothing but writes work | Project names are slugged (lowercased, punctuation → `-`): `"My Project"` and `my-project` are the same space-project; a different spelling is a different one. |
| Team leader can't install the App | App is set to "Only on this account" — operator flips it to "Any account" (App settings → Advanced). |

### Deploy internals

Full provisioning + smoke runbook (with expected outputs):
`docs/plans/2026-07-05-hosted-gateway-core.md`, Task 8. Development:
`npm test` in this directory (Node ≥ 20); the Worker entry is
`dist/gateway/src/worker.js` after `npm run build`.
