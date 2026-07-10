# Plan C — `wayform space create` onboarding CLI

Date: 2026-07-10
Status: DESIGN APPROVED (brainstorm complete, ready for implementation plan).
Owner: Skanda

## Purpose

Replace the manual, multi-step operator flow for standing up a new hosted space —
create a GitHub repo, install the GitHub App on it, hand-run a `curl` against
`POST /admin/members` to mint the first member token, hand-deliver the secret out
of band — with one command:

```
wayform space create --space <name> --owner <owner> --repo <repo>
```

This is "Plan C" from the hosted-gateway-core plan
(`docs/plans/2026-07-05-hosted-gateway-core.md:41`), explicitly deferred out of
Plan B's scope (`docs/superpowers/specs/2026-07-09-hosted-member-onboarding-design.md:229`:
*"The leader / `wayform space create` provisioning flow — that is Plan C."*).

It addresses the `[scale-blocking]` gap recorded in
`docs/roadmap/2026-07-09-enterprise-roadmap.md:215-218`: *"Onboarding is an operator
running curl commands... no self-serve signup, no provisioning UI."* Plan C does
**not** solve self-serve signup (that is roadmap Phase F, a separate, larger
initiative gated on identity/billing work) — it makes the *operator's* job one
command instead of four manual steps across two systems.

Plan B (this space's members joining) and Plan C (this space being created) are
deliberately separate concerns with no shared code path: Plan C's output is a
token + a printed `wayform init --remote` command: the same manual handoff a
customer already receives today, just generated instead of hand-assembled.

## Background — what already exists vs. what is missing

Already present:
- `POST /admin/members` (`gateway/src/github-auth.ts`) — ADMIN_SECRET-guarded,
  mints a member token given `{ space, installationId, owner, repo, author,
  authorEmail }`, returns the raw token once. This is the endpoint the manual
  `curl` flow already hits today.
- GitHub App installation-token minting (`appJwt`, `github-auth.ts`) — the
  gateway already holds `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` and can mint
  a JWT to call GitHub's App API.
- `gitConfigDefault()` (`src/init-env.ts`) and the `Runner`-injection /
  fall-open-on-shell-out pattern (`registerClaudeCodeMcp`, `src/init-remote.ts`) —
  both reused as-is.
- `test:gateway` npm script (root `package.json`) already runs the gateway's
  103 tests locally (`cd gateway && npm test`) but is **not** wired into CI.

Missing / blocking:
1. **No `wayform space create` command.** Repo creation, App installation, and
   token minting are three separate manual steps today.
2. **No way to discover an `installationId` from outside the gateway.** Only the
   gateway can mint the JWT needed to call GitHub's `GET /app/installations`
   (`GITHUB_APP_PRIVATE_KEY` never leaves the Worker). A CLI-driven flow needs a
   new gateway-side endpoint to resolve this.
3. **Gateway package has no CI coverage.** `.github/workflows/ci.yml` only runs
   the root CLI package's checks; the gateway's test suite is invisible to CI.

## Settled decisions (from the 2026-07-10 brainstorm)

1. **Fully automated, three-step flow.** The CLI drives repo creation, walks the
   operator through App installation (open URL, poll until detected), and mints
   the token — not just a thin wrapper around the token-mint step.
2. **App-install detection = new gateway admin endpoint that polls GitHub.**
   `GET /admin/installations?owner=<owner>` (ADMIN_SECRET-guarded, same trust
   tier as `/admin/members`) lists the App's installations via the existing JWT
   logic and matches by `account.login`. The CLI polls this endpoint after
   opening the install URL — the CLI itself never needs GitHub App credentials.
   Pilot-scale assumption (matches the `/admin/members` comment already in
   `github-auth.ts`): one installation per account. Two+ matches → `409`, CLI
   falls back to printing the manual `curl` command rather than building
   disambiguation UI for a rare edge case.
3. **Repo creation: `gh`-first, PAT fallback.** If `gh` is on PATH and
   authenticated, shell out to `gh repo create`. Otherwise prompt for a PAT
   (repo-creation scope), call GitHub's REST API directly, and discard the PAT
   from memory after the one call — never written to disk. Avoids a hard
   dependency on `gh` while keeping the best UX when it's available.
4. **Repo owner and name are separate, explicit inputs** (`--owner`, `--repo`),
   not derived from `--space`. Matches `/admin/members`'s existing separate
   `owner`/`repo`/`space` fields — no new coupling between space naming and repo
   naming.
5. **CI wiring is in scope for this spec**, alongside the CLI itself (the
   original Plan C scope note bundled them). Scope is test-only: add the
   already-existing `npm run test:gateway` script as a CI step. No deploy job,
   no new secrets — `wrangler deploy` stays a deliberate manual act.
6. **Auth model: operator-only today, but the credential resolution is
   isolated.** `ADMIN_SECRET` is a single shared Worker secret, not
   per-customer — this command is not self-serve, matching the roadmap's
   framing (self-serve signup is a separate, larger Phase F initiative). The
   CLI resolves it through one small function (`resolveAdminSecret()`) so that
   if the auth model later changes (e.g., a scoped invite token), only that one
   seam changes — without building speculative multi-auth-method plumbing now.
7. **Post-mint handoff is print-only.** The CLI prints the token, the gateway
   URL, and the exact `wayform init --remote --gateway <url> --token <token>`
   command — it does **not** also run `init --remote` locally. Keeps space
   creation and space joining as separate, decoupled flows (matches decision 1
   above and Plan B/Plan C's separate-plans framing).

## 1. CLI command

```
wayform space create --space <name> --owner <owner> --repo <repo> [--public] [--app-slug <slug>]
```

- `--space` — the space name, forwarded to `/admin/members` verbatim.
- `--owner` — GitHub user or org that will own the new repo.
- `--repo` — new repo's name (created under `--owner`).
- `--public` — optional; repo defaults to private.
- `--app-slug` — optional; the GitHub App's slug used to build the install URL
  (`https://github.com/apps/<slug>/installations/new`). Not a secret (it's a
  public URL segment) — defaults to a documented constant, overridable via
  `WAYFORM_GITHUB_APP_SLUG` env var or this flag. No new gateway endpoint is
  added solely to serve this value.
- `--author` / `--author-email` — optional overrides; default to
  `gitConfigDefault()` (same resolution `init --remote` already uses).
- `ADMIN_SECRET` — read from `WAYFORM_ADMIN_SECRET` env var only, never a CLI
  flag (avoids shell-history/process-list leakage of the shared operator
  credential).

## 2. Flow

Implemented in a new `src/space-create.ts`, routed from `src/cli.ts` alongside
`hook`/`init`/`doctor` (`case "space":` dispatching on the next arg, `create`
today). Mirrors `init-remote.ts`'s shape: small pure functions, an injectable
`Runner` for shell-outs, testable without live network/process calls.

1. **Create the repo.**
   - Detect `gh`: run `gh auth status` via `execFileSync` with the same bounded,
     non-interactive posture as `registerClaudeCodeMcp` (`stdio: ["ignore",
     "ignore", "ignore"]`, timeout, closed stdin).
   - If authenticated: `gh repo create <owner>/<repo> [--private|--public]`.
   - If `gh` is absent *or* unauthenticated: fall through (not fail) to a
     `readline`-based PAT prompt, then `POST /user/repos` (or
     `/orgs/<owner>/repos` when `--owner` is an org) directly against GitHub's
     REST API using that PAT. The PAT lives only in the process's memory for
     that one call.

2. **Install the GitHub App.**
   - Print `https://github.com/apps/<slug>/installations/new` and instruct the
     operator to install it on the repo just created.
   - Poll `GET /admin/installations?owner=<owner>` (header
     `x-admin-secret: <WAYFORM_ADMIN_SECRET>`) every few seconds, bounded to a
     ~2-minute total timeout, printing a waiting indicator.
   - On success: `{ installationId }`.
   - On timeout or `409` (ambiguous match): print the install URL again plus
     the equivalent manual `curl -X POST .../admin/members` command as a
     fallback, then exit non-zero — the operator is never stuck without a path
     forward.

3. **Mint the token.**
   - `POST /admin/members` with `{ space, installationId, owner, repo, author,
     authorEmail }` — unchanged endpoint, unchanged contract.

4. **Print the handoff.**
   - The raw token (shown once, per the endpoint's existing contract), the
     gateway URL, and the literal command:
     `wayform init --remote --gateway <url> --token <token>`
   - No local project side-effects — nothing is written to the operator's
     current directory.

## 3. Gateway change — `GET /admin/installations`

New handler in `gateway/src/github-auth.ts`, next to `handleAdminAddMember`:

- Guarded by `x-admin-secret` (same check as `handleAdminAddMember`).
- Query param `owner` (required).
- Uses the existing `appJwt()` helper to call `GET /app/installations`
  (paginated), filters results where `account.login.toLowerCase() ===
  owner.toLowerCase()`.
- Zero matches → `404`. One match → `200 { installationId }`. Two-plus matches
  → `409` with both IDs listed (operator resolves manually — matches decision 2
  above).

## 4. Error handling

- Repo already exists → surface GitHub's error verbatim, exit non-zero. Nothing
  has been minted yet, so there's no partial state to clean up.
- `gh` present but unauthenticated → falls through to the PAT prompt rather
  than hard-failing (same fall-open posture as `registerClaudeCodeMcp`).
- Install-poll timeout → manual fallback (install URL + equivalent `curl`),
  exit non-zero.
- `409` from `/admin/installations` → manual fallback (both installation IDs +
  equivalent `curl`), exit non-zero.

## 5. Testing

- `src/space-create.ts` unit tests (root `test/`, `node:test`, matching
  existing style): flag parsing; `gh`-present vs. `gh`-absent/unauthenticated
  branching via a stubbed `Runner`; the install-poll loop against a stubbed
  `fetch` (success, timeout, `409`); handoff message formatting. No live
  GitHub or gateway calls.
- `gateway/src/github-auth.ts` — unit tests for the new
  `handleAdminListInstallations` handler (stubbed GitHub API responses):
  single match, zero matches, ambiguous match. Same shape as the existing
  `handleAdminAddMember` tests.
- No new live/integration tests — the existing live-smoke coverage of the
  gateway's GitHub App JWT path already exercises the credential this reuses.

## 6. CI wiring

`.github/workflows/ci.yml` gets one additional step running the already-defined
root script `npm run test:gateway` (`cd gateway && npm test`, which builds and
runs the gateway's 103 `node:test` tests). No new secrets, no deploy job —
`gateway`'s `npm run deploy` (`wrangler deploy`) remains a deliberate, manual
act, unchanged by this spec.

## 7. Out of scope (YAGNI)

- Self-serve signup / customer-run provisioning (roadmap Phase F —
  identity/billing-gated, materially larger scope).
- Auto-deploy of the gateway on merge to `main`.
- Disambiguation UI for multiple GitHub App installations under one account
  (pilot-scale assumption: one installation per account; ambiguity falls back
  to the existing manual `curl` path).
- Any change to `/admin/members`'s existing contract or auth model.
- A pluggable multi-auth-method credential system for `ADMIN_SECRET` — only the
  single resolution seam (`resolveAdminSecret()`) is isolated for a future
  swap; no speculative plumbing beyond that.

## 8. Risks / notes

- **Shared ADMIN_SECRET blast radius.** Anyone holding it can list
  installations and mint member tokens for *any* space — unchanged from
  today's `curl` flow, just easier to invoke. No new exposure, but worth
  keeping in mind if this credential is ever loosened from "operator-only."
- **GitHub API pagination on `/app/installations`.** At pilot scale this is a
  handful of installations; if the App is ever installed on hundreds of
  accounts, the owner-filter scan could need multiple pages — acceptable now,
  worth revisiting if that scale is reached.
- **PAT fallback path is the less-tested UX.** Most operators are expected to
  have `gh` available; the PAT path exists for completeness but should get
  real dogfooding before being relied on.
