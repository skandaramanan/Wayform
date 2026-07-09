# Enterprise & Superuser Roadmap — From Dogfood MVP to a Product Strangers Trust With Their Company's Memory

Date: 2026-07-09
Status: PLANNING ARTIFACT. Nothing here is built or approved for build. It is the
gap register between "works in a two-person dogfood" and "an enterprise buys it,
their security team clears it, and their staff engineers live in it daily."

## 0. Scope, and what is deliberately NOT re-listed here

This roadmap lists **only pain points and findings not already owned by another doc.**
It does not restate:

- **Retrieval quality** (recency-only, no query param, flat pull, multi-fact blur,
  supersession, canon tier, briefing/manifest, prompt-hook, τ, evals, golden set) —
  owned by §1–§9 above. Those are the *withdrawal* story and they are the right story.
- **Core hardening** (clock-skew reordering, partial-write orphans, rebase-retry,
  token-leakage audit, path traversal, env allowlist, `doctor`, CI matrix, npm
  distribution, idempotent `init`) — owned by `2026-07-04-production-roadmap.md` Phase 0.
- **The stateless-gateway / repo-per-space / scoped-installation-token tenancy spine**
  — owned by the production roadmap Phase 1 and shipped.

Everything below is the *residue* — the classes of work neither retrieval nor core-
hardening nor the hosted-gateway plan covers, and every one of which a real enterprise
buyer, or a power user betting their team's institutional memory on this, will hit.

### Gating legend (extends the production roadmap's)

- `[validation-blocking]` — the core value hypothesis is unproven; spending on anything
  else is premature until this clears.
- `[trust-blocking]` — a stranger will not put real, sensitive decisions in until this
  exists. The bar to go from "our own dogfood" to "someone else's data."
- `[enterprise-blocking]` — a procurement / security / legal review will hard-stop the
  deal without it.
- `[scale-blocking]` — silently breaks (correctness or cost) as spaces, members, or
  corpus grow past the pilot.
- `[unicorn-surface]` — expansion, moat, or monetization; earns its place only after
  adoption is real, but named so the ceiling is visible.

The venture guardrail still holds: **the multiplayer pull must prove real first (§0.0),
and everything past `[trust-blocking]` is gated on a first paying design partner, not on
taste.** This roadmap maps the whole climb so the sequencing is visible; it is not a
license to build ahead of the pull.

---

## 0.0 The unvalidated core — the gate above every gate — `[validation-blocking]`

**Finding, stated plainly: the product's central hypothesis has never actually been
tested.** Every metric collected to date is *single-author dogfood* (confirmed in the
store: ~1 day, one person, opportunistic pull flat). The whole thesis — *"a collaborator
stops re-explaining settled decisions because they trust the shared space"* — is a
**cross-person** signal, and there has never been sustained cross-person usage to measure
it. The reliance test measured one author reading their own writes.

Why this sits above the enterprise work: every section below is investment in *scaling
and hardening a value that is not yet demonstrated to exist*. A prompt-injection audit,
an SSO integration, and a billing plan are all worthless if two real people sharing a
space does not, in practice, save re-explanation. **Before any `[trust-blocking]` spend:
run one genuine 2–3 person week and measure whether cross-author reads displace
re-explanation.** If they don't, the fix is the *write curation + retrieval* loop, not
enterprise features. This is the cheapest, highest-leverage item in the entire document
and it requires zero code.

---

## 1. The correction problem — append-only collides with "wrong," "secret," and "forget me" — `[trust-blocking]` / `[enterprise-blocking]`

The append-only immutable git ledger is the moat. It is also, unaddressed, the single
biggest structural liability, because **three different real needs all require *unwriting*
something the design says can never be unwritten:**

| Need | Why the ledger can't do it today | Severity |
|---|---|---|
| **Correct a wrong fact.** Someone records "we decided Postgres" but it was Postgres*QL managed*, or it was simply wrong. | There is no edit and no delete. Supersession (§4 above) is the *only* correction primitive and **it isn't built yet** — and even once built, the wrong fact stays physically present and injectable until a *newer* fact supersedes it. You cannot fix a typo; you can only argue with it. | High |
| **A secret leaks into memory.** A member pastes an API key, a customer name, or a credential into "record this decision." It is now committed to git history *and* injected into every member's session at every start, *and* extracted into the index. | Immutable history means the secret is permanent. Rotating it doesn't remove it from the ledger. There is no write-time secret/PII scan. | Critical |
| **Right to erasure (GDPR Art. 17 / CCPA).** An employee leaves; a customer invokes deletion; a decision references a person who must be scrubbed. | "Immutable append-only log, `git log` is the audit trail" is *directly opposed* to "delete on request." History rewrite desyncs every clone (the production roadmap flags the *detection* of force-push, not a *supported erasure workflow*). | Enterprise-blocking |

**This is the finding that most changes the architecture story.** "You own the data / git
is immutable" was a purity argument; enterprise reality needs **a governed mutation path**:
an audited tombstone/redaction mechanism (crypto-shred a blob, rewrite with coordinated
re-clone, or move the source of truth to content-addressed blobs with a revocable
pointer), retention policies, legal hold, and a write-time secret/PII gate that refuses or
masks before the commit. None of this exists or is planned. Decide the erasure model
*before* a stranger's data lands, because retrofitting deletion onto an immutable ledger
after it holds real PII is the worst possible time.

---

## 2. Access & governance beyond "one token = the whole space" — `[trust-blocking]` / `[enterprise-blocking]`

The tenancy spine is strong *between* spaces. *Within* a space it is a single trust tier,
which is fine for 2–3 trusted peers and unacceptable for an org.

- **Non-expiring bearer tokens, no rotation, no expiry.** A `mlk_...` token is valid
  forever until an operator hand-deletes a KV key. No TTL, no rotation, no self-service
  revoke. A leaked token is a permanent cross-session read/write of the whole space until
  someone notices. `[trust-blocking]`
- **No roles.** Everyone who can read can write, and everyone who writes is injected into
  everyone else. There is no read-only member, no admin, no "write requires approval,"
  no service-account vs human distinction. `[enterprise-blocking]`
- **The trust boundary is the whole space.** "Everything a member writes is injected into
  every member's session" (stated plainly in the README) does not survive contact with a
  20-person org where not everyone should see every project's decisions. Enterprise needs
  **per-project ACLs / sub-space scoping**, which the current one-repo-per-space model
  doesn't express. `[enterprise-blocking]`
- **Manual offboarding.** Removing a member is an operator running
  `wrangler kv key delete` by hand (per the gateway README). No admin UI, no SCIM
  deprovisioning, no "disable everyone from domain X." `[enterprise-blocking]`
- **No SSO / SAML / OIDC / SCIM.** Identity is a pasted token, not the company's IdP.
  This is a hard procurement gate at any company with an IT function. `[enterprise-blocking]`
- **Attribution is only as trustworthy as the token.** Attribution comes from the
  authenticated token (good — members can't write *as* each other), but there is no
  signed-write / non-repudiation story, so a *leaked* token writes convincingly as its
  owner into everyone's context. Given writes are auto-injected, spoofed attribution is a
  social-engineering vector, not just an audit gap. `[trust-blocking]`
- **No org/team layer.** A person is a member of one space via one token. Multi-space
  membership, team hierarchies, and a person's preferences travelling across spaces (the
  open question in §8 above) all need an identity model that doesn't exist yet.
  `[unicorn-surface]`

---

## 3. Compliance & data-flow governance — `[enterprise-blocking]`

None of this is tracked anywhere, and all of it is table stakes for selling to a company:

- **Subprocessor & data-flow disclosure — including the one the pitch omits.** "You own
  the data / nothing but git" is no longer strictly true: **ingest now sends ledger
  content to Workers AI (an LLM) for fact extraction and embedding.** A customer's
  decisions — potentially containing confidential material — leave the git repo and
  transit an AI model. That is a real subprocessor (Cloudflare Workers AI) processing
  customer content, and the data-ownership story must say so, get it into the DPA, and
  offer a **no-AI / bring-your-own-extraction** mode for customers who forbid it.
- **No SOC 2 / ISO 27001 / GDPR DPA / HIPAA posture.** No audit, no policies, no
  subprocessor list, no data-processing agreement, no privacy policy. Every one is a
  checkbox a security review will demand.
- **No data residency control.** GitHub repo region, D1 region, and Workers AI region are
  wherever the platform puts them; a customer requiring EU-only processing can't be
  served.
- **Read auditing is absent.** The ledger audits *writes* (git authorship). Enterprise
  audit needs *who read / who had which decision injected when* — the `retrieval_log`
  exists in D1 but is per-space-internal and unexposed, and hook reads aren't logged as
  access events. "Show me everyone who saw decision X" is unanswerable.
- **No encryption-at-rest guarantees beyond the platforms' defaults; no CMK/BYOK.**
  Enterprises increasingly require customer-managed keys.
- **No PII / secret detection or classification** at write or ingest (ties to §1).

---

## 4. Reliability, disaster recovery & the silent scale ceilings — `[scale-blocking]` / `[trust-blocking]`

- **The 40-entry read cap is a silent correctness ceiling, not just a rate-limit note.**
  The gateway recency read fetches "at most the 40 newest entry files" (`MAX_ENTRY_FETCH`,
  Workers 50-subrequest limit). On the *recency* path (index absent/unavailable, i.e. the
  fail-open fallback everyone lands on when D1/AI is down) a space with >40 entries
  **silently drops the rest** — `total` reports the true count but the content is
  truncated. The index path mitigates this, but the failure mode is exactly "when the
  smart layer is down, you silently see a fraction of your memory." Name it, bound it,
  surface it. `[scale-blocking]`
- **No SLA, uptime monitoring, alerting, or on-call.** Fail-open is a great *UX* property
  and a terrible *operations* property: everything degrades to silence, so an outage is
  invisible until someone notices their memory went quiet. There is no synthetic monitor,
  no error-rate alarm, no status page. `[trust-blocking]`
- **Two hard external SPOFs with no failover: GitHub and Cloudflare.** A GitHub outage
  takes writes *and* the source of truth offline; a Cloudflare/D1/Workers-AI outage takes
  the whole intelligence plane offline (degrading to §4's truncated recency read). The
  "platform concentration" note in §8 above concedes the *index* is disposable — but the
  *ledger's* availability is entirely GitHub's, with no mirror. `[enterprise-blocking]`
- **No ledger backup / DR drill.** The index is rebuildable (proven), but the ledger's
  only copy is the GitHub repo. "The shared repo *is* the backup" (production roadmap) is
  asserted, never verified with a restore drill, and has no off-GitHub mirror.
  `[trust-blocking]`
- **No gateway release safety.** No versioned deploys, canary, or rollback for the Worker;
  a bad deploy hits every tenant at once. `[scale-blocking]`
- **Cron-reconciler and webhook are the only ingest-durability net** and neither is
  monitored; a persistently failing webhook plus a silently erroring cron = an index that
  drifts from the ledger with no alarm. `[scale-blocking]`

---

## 5. Scale economics & the $0 cliff — `[scale-blocking]` / `[unicorn-surface]`

The production roadmap names the free-tier request cliff. It does **not** cover the new
per-event AI cost or the business model:

- **Extraction + embedding cost per write is now non-zero and unmetered.** Every write
  triggers an LLM extraction call and N embedding calls; every prompt-hook (Phase C) adds
  a query embedding. Workers AI free allocation covers pilot volume; at org scale this is
  real recurring spend with no metering, no per-space attribution, and no budget guard.
  A single member scripting writes could exhaust the AI allocation for the whole gateway.
- **No abuse / rate limiting / quota per member or per space.** One noisy tenant degrades
  everyone (shared Worker, shared AI allocation, shared 100k-req/day).
- **No billing, metering, or plans.** There is no path from "$0 dogfood" to "revenue."
  A unicorn needs usage metering, plan tiers, and cost accounting — none exist, and the
  $0 constraint (correct for the pilot) actively forbids the always-on index/cache that
  scale eventually needs.

---

## 6. The missing human product — everything assumes an agent, no human surface — `[trust-blocking]`

The dashboard is filed as `[future]` in the production roadmap. That undersells it: **the
absence of any human surface is a trust and adoption blocker, not a nice-to-have.**

- **A human cannot browse, search, correct, or curate memory without cloning a git repo.**
  A team lead evaluating "should I trust this with our decisions?" has *no way to look at
  what's in it* except `git clone` + read markdown. That is the buying-decision surface and
  it doesn't exist.
- **No curation/correction UI** (ties to §1): the only way to fix or remove a fact is
  through an agent, in prose, hoping supersession fires.
- **No usage / ROI analytics for the buyer.** "Is my team actually using this? Is it
  saving re-explanation? Which decisions get retrieved?" — the data (metrics JSONL,
  `retrieval_log`) exists and is *never surfaced to a human*. The person who has to
  renew the contract can't see value.
- **Onboarding is an operator running curl commands.** Space creation is a manual
  multi-step operator flow (create repo, install App, mint tokens via `curl`, hand-deliver
  secrets). There is no self-serve signup, no provisioning UI, no "invite by email." Every
  new team is human-operator toil. `[scale-blocking]`
- **The npm global-install bug** (documented in the README troubleshooting as a real npm
  10 footgun requiring a clone-then-install workaround) is an adoption tax on the *local*
  plane's first five minutes.
- **Human discoverability.** The topic manifest helps *agents* know what exists; a human
  joining a team has no equivalent "what does this space know" view.

---

## 7. Memory quality & curation at scale — beyond ranking — `[gated-on-pull]`

Retrieval §5 ranks well; it does not keep the *corpus* healthy as many authors write for
months:

- **No dedup of near-identical writes.** Two members recording the same decision (or the
  stop-hook re-recording across turns) yields duplicate facts that both rank and both
  inject. Supersession handles *contradiction*, not *duplication*.
- **No disagreement / conflict-resolution surface.** When two members record conflicting
  decisions, `conflicts_with` (§4) *surfaces* it — but there is no workflow to *resolve*
  it, no "the team ruled X," no owner, no escalation. Conflicts accrete.
- **No moderation / approval path.** Every write is live and injected instantly. An org
  may want "decisions from junior members are proposed until an owner ratifies." No such
  tier exists (canon is a *type*, not an *approval state*).
- **Write quality is unmeasured and undisciplined.** The write model rests on prompt
  discipline + the stop-hook; there is no measurement of whether writes are actually
  atomic, sourced, and decision-shaped vs. noise. Garbage-in silently degrades retrieval,
  and nothing watches for it.
- **Extraction-quality drift is unmonitored in production.** The model was already swapped
  once (8B → 70B) after "chatty output" broke parsing (commits #9–#11). Extraction is now
  load-bearing for what gets injected, with no live fidelity monitor — a silent-degradation
  risk every time the model changes underneath.
- **No decision-lineage / timeline view.** "How did our thinking on X evolve" is
  reconstructable from git in principle and surfaced nowhere.

---

## 8. Ecosystem & ingestion — decisions don't live where the product listens — `[unicorn-surface]`

The README's own premise: *"the context that matters lives in Slack scrollback and
people's heads."* The product's answer is to make people *manually* re-state it into a
memory tool. That is the adoption cliff.

- **No ingestion from where decisions actually get made** — Slack, Linear, Jira, GitHub
  issues/PRs, Notion, meeting transcripts. The single highest-leverage expansion: passively
  capture settled decisions from the channels teams already use, instead of relying on a
  human to remember to `write_context`. This is plausibly the difference between "a tool
  disciplined people use" and "a system of record teams rely on."
- **No outbound notifications / webhooks.** New canon decision → no Slack post, no digest,
  no "your teammate just recorded X." Memory is silent in both directions.
- **No public API / SDK** for third parties to build on (only the two MCP tools).
- **Thin client coverage for auto-injection.** Claude Desktop is pull-only; the hosted
  `init --remote` hook shim is still "next increment" per the README; non-Claude MCP
  clients get tools but not guaranteed session-start reads.

---

## 9. Testing & release engineering for multi-tenant trust — `[trust-blocking]`

The suites are green (118 root + 98 gateway) and the CI matrix exists, but the tests that
specifically de-risk a *multi-tenant, auto-injecting* product are missing:

- **No cross-tenant isolation property/fuzz test.** The isolation argument is "the
  credential can't read another repo" — sound, but unenforced by a test that *tries* space
  A's token against space B across every endpoint. The production roadmap calls these
  "mandatory"; they are not present.
- **No load / performance / concurrency test** against the real caps (40-fetch, 50-
  subrequest, D1 row counts, brute-force cosine at 10k vectors).
- **No end-to-end multi-client interop test in CI.** The Claude↔Cursor↔gateway
  byte-identical round-trip is smoke-tested by hand, not gated.
- **No eval harness in CI.** The golden set (§7 above) is a Phase-C artifact; until it's a
  CI gate, retrieval quality can silently regress on any change to ranking, τ, or the
  extraction model.
- **No staged rollout / canary** for the gateway (ties to §4).

---

## Cross-cutting architectural tensions to resolve deliberately (not drift into)

1. **Moat vs. superpower.** The moat is *the ledger* (git, vendor-neutral, you-own-it).
   The superpower is now *the hosted Cloudflare intelligence plane* (extraction,
   embeddings, ranking, briefing) — centralized, Cloudflare-shaped, and reliant on an AI
   subprocessor. These are two different value propositions living in one product. Offline
   or CF-down, the superpower degrades to the truncated recency read (§4). Decide and state
   which one you're selling, because "you own your data" and "our hosted AI makes it smart"
   pull in opposite directions on residency, portability, and pricing.
2. **Immutable vs. correctable/forgettable.** §1. The purity of append-only is in direct
   tension with correction, secret-scrubbing, and erasure. Pick the governed-mutation model
   before real data lands.
3. **Coarse space-trust vs. enterprise least-privilege.** §2. "Everyone sees everything"
   is the whole design today and the opposite of what an org needs.
4. **Fail-open UX vs. observable operations.** §4. Silence is great for a session and fatal
   for a support/SLA story; the product needs to stay fail-open to the *user* while becoming
   fail-loud to the *operator*.

---

## Risk register (additions only — does not repeat §8 above or the production roadmap's)

| Risk | Severity | Where addressed |
|---|---|---|
| **Core pull unproven** (all metrics single-author) | Critical (gates everything) | §0.0 |
| **Secret/PII committed to immutable history + auto-injected** | Critical | §1 |
| **Right-to-erasure impossible on an append-only ledger** | Enterprise-blocking | §1 |
| **Customer content sent to an AI subprocessor, undisclosed** | Enterprise-blocking | §3 |
| **Leaked non-expiring token = permanent space-wide read/write + spoofed injection** | High | §2 |
| **Silent 40-entry truncation on the fail-open read path** | High | §4 |
| **No monitoring/alerting under a fail-open design (invisible outages)** | High | §4 |
| **Ledger availability wholly dependent on GitHub, no mirror/DR drill** | High | §4 |
| **Unmetered per-write AI cost; one member can exhaust the shared allocation** | Medium→High at scale | §5 |
| **Within-space over-sharing (no per-project ACL) leaks decisions across an org** | High (enterprise) | §2 |
| **No cross-tenant isolation test proving the core safety claim** | High | §9 |
| **Corpus rot: duplicates, unresolved conflicts, unmoderated writes** | Medium | §7 |

---

## Suggested sequencing (mapped, not scheduled — the pull still gates it)

- **Gate 0 — prove the pull (§0.0).** One real 2–3 person week. Zero code. Everything below
  waits on this. *If it fails, fix write-curation + retrieval, not enterprise.*
- **Phase D — earn a stranger's trust (`[trust-blocking]`):** the correction/secret path
  (§1 minimum: write-time secret scan + supersession actually shipped + a redaction/tombstone
  primitive), token expiry+rotation+self-serve revoke (§2), fail-loud operator monitoring
  and the 40-entry truncation surfacing (§4), a ledger backup/restore drill (§4), and a
  read-only **human console** to browse/search/correct (§6). This is the set that lets a
  team that *isn't you* put real decisions in.
- **Phase E — pass a security review (`[enterprise-blocking]`):** RBAC + per-project ACLs
  (§2), SSO/SCIM (§2), the compliance/subprocessor/DPA + no-AI mode + data-residency story
  (§3), read auditing (§3), erasure workflow + retention/legal-hold (§1). Gated on a design
  partner who needs it.
- **Phase F — self-serve & scale (`[scale-blocking]`):** provisioning/signup UI, billing +
  metering + per-space cost attribution (§5), quotas/abuse limits (§5), gateway canary +
  isolation/load tests + eval-in-CI (§9).
- **Phase G — the moat expands (`[unicorn-surface]`):** Slack/Linear/Jira/issue ingestion
  and outbound notifications (§8), public API/SDK, org/multi-space identity (§2), corpus-
  health curation (§7). This is where "a tool disciplined people use" becomes "the system of
  record a company can't leave."

The throughline: **Gate 0 is free and decides whether any of this is worth building.
Phase D is what a real user needs; Phase E is what their lawyer needs; Phase F is what a
business needs; Phase G is what a unicorn needs.** Do them in that order, each gated on the
prior one's demand actually materializing.
