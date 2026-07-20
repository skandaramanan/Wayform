# Invite-Code `/join` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Devs self-mint their own `mlk_` member token from a team invite code, so the operator mints one invite per team instead of one token per dev.

**Architecture:** A new `invite:` KV record (hashed code, same pattern as `member:` records) minted by ADMIN_SECRET-guarded `POST /admin/invites`; a public `POST /join` that validates + decrements the invite and mints through a `mintMember()` helper extracted from the existing admin handler; a `--invite` alternative to `--token` on `wayform init --remote`; `wayform space create` prints an invite handoff instead of the leader's own token.

**Tech Stack:** Cloudflare Worker (gateway/, TypeScript, KV via `env.ROUTING`), Node CLI (src/, TypeScript), `node --test` suites compiled via tsc (`npm test` = build + test in both roots).

**Spec:** `docs/superpowers/specs/2026-07-20-invite-code-join-design.md`

## Global Constraints

- Invite defaults: **14-day expiry, 25 uses** (spec).
- Codes are `wfi_` + 32 random url-safe bytes; **only the SHA-256 hash is stored** (never the raw code, never a raw token, in KV keys or logs).
- `/join` failures for missing/expired/exhausted invites return ONE generic message: `400 {"error":"invalid or expired invite"}` — no probing oracle.
- Successful `/join` logs one structured line with the token **hash** (the revoke handle), never the raw token.
- KV decrement race (over-admit by ~1 under concurrency) is accepted; mark with a `ponytail:` comment.
- Gateway tests import from `../dist/gateway/src/*` — `cd gateway && npm test` builds first. Root CLI tests likewise via `npm test`.
- Commit after every green task.

---

### Task 1: Extract `mintMember()` in tenancy.ts (pure refactor)

**Files:**
- Modify: `gateway/src/tenancy.ts:160-192` (`handleAdminAddMember`)
- Test: existing `gateway/test/tenancy.test.mjs` (no new tests — behavior unchanged)

**Interfaces:**
- Produces: `export async function mintMember(env: Env, member: SpaceMember): Promise<string>` — stores the hashed token record, registers the space repo, returns the raw token. Task 2's `/join` calls this.

- [ ] **Step 1: Extract the helper**

In `gateway/src/tenancy.ts`, insert above `handleAdminAddMember`:

```ts
/**
 * Shared member-creation core (admin mint and public /join both land here):
 * store the member under the token's hash, register the space repo, return
 * the raw token — shown exactly once by the caller. Callers validate input.
 */
export async function mintMember(
  env: Env,
  member: SpaceMember,
): Promise<string> {
  const token = newToken();
  await env.ROUTING.put(
    `member:${await sha256Hex(token)}`,
    JSON.stringify(member),
  );
  await registerSpaceRepo(env, {
    space: member.space,
    installationId: member.installationId,
    owner: member.owner,
    repo: member.repo,
    branch: member.branch,
  });
  return token;
}
```

Then replace the tail of `handleAdminAddMember` (everything from `const member = ...` through the final `return`) with:

```ts
  const member = { branch: "main", ...body } as SpaceMember;
  const token = await mintMember(env, member);
  return Response.json({ token, member });
```

- [ ] **Step 2: Run gateway tests to verify no behavior change**

Run: `cd gateway && npm test`
Expected: all pass (182 before this work).

- [ ] **Step 3: Commit**

```bash
git add gateway/src/tenancy.ts gateway/dist
git commit -m "refactor(gateway): extract mintMember from admin handler"
```

---

### Task 2: `gateway/src/invites.ts` — admin invite mint + public /join

**Files:**
- Create: `gateway/src/invites.ts`
- Test: `gateway/test/invites.test.mjs`

**Interfaces:**
- Consumes: `mintMember`, `sha256Hex`, `SpaceMember` from `./tenancy.js`; `b64url` from `./github-auth.js`; `Env` from `./env.js`.
- Produces: `handleAdminCreateInvite(req: Request, env: Env): Promise<Response>` and `handleJoin(req: Request, env: Env): Promise<Response>` (Task 3 wires both into the router); exported consts `INVITE_TTL_MS`, `INVITE_MAX_USES`; KV schema `invite:<sha256(code)>` → `Invite` JSON.

- [ ] **Step 1: Write the failing tests**

Create `gateway/test/invites.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  handleAdminCreateInvite,
  handleJoin,
  INVITE_MAX_USES,
} from "../dist/gateway/src/invites.js";
import { resolveMember, sha256Hex } from "../dist/gateway/src/tenancy.js";
import { makeEnv } from "./helpers.mjs";

const INVITE_BODY = {
  space: "team-a",
  owner: "acme",
  repo: "team-a-memory",
  installationId: 777,
};

function post(url, body, headers = {}) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function createInvite(env, body = INVITE_BODY, secret = "test-admin-secret") {
  return handleAdminCreateInvite(
    post("https://gw.test/admin/invites", body, { "x-admin-secret": secret }),
    env,
  );
}

async function join(env, body) {
  return handleJoin(post("https://gw.test/join", body), env);
}

test("admin invite mint: returns a wfi_ code once; only the hash lands in KV", async () => {
  const env = makeEnv();
  const res = await createInvite(env);
  assert.equal(res.status, 200);
  const { invite, usesLeft } = await res.json();
  assert.match(invite, /^wfi_/);
  assert.equal(usesLeft, INVITE_MAX_USES);
  for (const key of env.ROUTING.map.keys()) {
    assert.ok(!key.includes(invite), "raw invite code must not appear in KV keys");
  }
});

test("admin invite mint rejects wrong secret and missing fields", async () => {
  const env = makeEnv();
  assert.equal((await createInvite(env, INVITE_BODY, "wrong")).status, 403);
  const { space: _drop, ...incomplete } = INVITE_BODY;
  assert.equal((await createInvite(env, incomplete)).status, 400);
});

test("join: mints a working member token and decrements usesLeft", async () => {
  const env = makeEnv();
  const { invite } = await (await createInvite(env)).json();
  const res = await join(env, {
    invite,
    author: "David",
    authorEmail: "d@spear.ai",
  });
  assert.equal(res.status, 200);
  const { token, member } = await res.json();
  assert.match(token, /^mlk_/);
  assert.equal(member.space, "team-a");
  assert.equal(member.branch, "main");
  assert.equal(member.author, "David");

  const resolved = await resolveMember(
    new Request("https://gw.test/mcp", {
      headers: { authorization: `Bearer ${token}` },
    }),
    env,
  );
  assert.equal(resolved.space, "team-a");

  const record = JSON.parse(
    await env.ROUTING.get(`invite:${await sha256Hex(invite)}`),
  );
  assert.equal(record.usesLeft, INVITE_MAX_USES - 1);
});

test("join: unknown, expired, and exhausted invites all fail with the same generic 400", async () => {
  const env = makeEnv();
  const who = { author: "Eve", authorEmail: "e@x.io" };

  const unknown = await join(env, { invite: "wfi_nope", ...who });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error, "invalid or expired invite");

  const { invite } = await (await createInvite(env)).json();
  const key = `invite:${await sha256Hex(invite)}`;

  const live = JSON.parse(await env.ROUTING.get(key));
  await env.ROUTING.put(key, JSON.stringify({ ...live, expiresAt: Date.now() - 1 }));
  const expired = await join(env, { invite, ...who });
  assert.equal(expired.status, 400);
  assert.equal((await expired.json()).error, "invalid or expired invite");

  await env.ROUTING.put(key, JSON.stringify({ ...live, usesLeft: 0 }));
  const exhausted = await join(env, { invite, ...who });
  assert.equal(exhausted.status, 400);
  assert.equal((await exhausted.json()).error, "invalid or expired invite");
});

test("join: missing author/email is a distinct 400 (caller bug, not invite probing)", async () => {
  const env = makeEnv();
  const { invite } = await (await createInvite(env)).json();
  const res = await join(env, { invite, author: "NoEmail" });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /missing/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && npm test 2>&1 | grep -A2 invites`
Expected: FAIL — `Cannot find module '../dist/gateway/src/invites.js'` (build error surfaces as compile failure first; that counts).

- [ ] **Step 3: Implement `gateway/src/invites.ts`**

```ts
/**
 * Team invite codes: the operator mints one `wfi_` code per team
 * (POST /admin/invites); each dev exchanges it for their own personal
 * member token (public POST /join). Same hashed-secret KV pattern as
 * member tokens — a leaked KV dump reveals no usable codes.
 */
import type { Env } from "./env.js";
import { b64url } from "./github-auth.js";
import { mintMember, sha256Hex, type SpaceMember } from "./tenancy.js";

export const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const INVITE_MAX_USES = 25;

export interface Invite {
  space: string;
  owner: string;
  repo: string;
  installationId: number;
  branch: string;
  expiresAt: number; // epoch ms
  usesLeft: number;
}

function newInviteCode(): string {
  return "wfi_" + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

const REQUIRED = ["space", "owner", "repo", "installationId"] as const;

/** POST /admin/invites — mint one team invite. Raw code returned exactly
 *  once. Revocation is a manual KV delete at pilot scale. */
export async function handleAdminCreateInvite(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  let body: Partial<Invite>;
  try {
    body = (await req.json()) as Partial<Invite>;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  for (const key of REQUIRED) {
    if (body[key] === undefined || body[key] === "") {
      return Response.json({ error: `missing ${key}` }, { status: 400 });
    }
  }
  const invite: Invite = {
    space: body.space!,
    owner: body.owner!,
    repo: body.repo!,
    installationId: body.installationId!,
    branch: body.branch ?? "main",
    expiresAt: Date.now() + INVITE_TTL_MS,
    usesLeft: INVITE_MAX_USES,
  };
  const code = newInviteCode();
  await env.ROUTING.put(
    `invite:${await sha256Hex(code)}`,
    JSON.stringify(invite),
  );
  return Response.json({
    invite: code,
    expiresAt: invite.expiresAt,
    usesLeft: invite.usesLeft,
  });
}

/** One generic rejection for every invite-side failure — no probing oracle. */
function rejectInvite(): Response {
  return Response.json({ error: "invalid or expired invite" }, { status: 400 });
}

/** POST /join — exchange a live invite for a fresh personal member token. */
export async function handleJoin(req: Request, env: Env): Promise<Response> {
  let body: { invite?: string; author?: string; authorEmail?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.invite) return rejectInvite();
  if (!body.author || !body.authorEmail) {
    return Response.json(
      { error: "missing author or authorEmail" },
      { status: 400 },
    );
  }
  const key = `invite:${await sha256Hex(body.invite)}`;
  const raw = await env.ROUTING.get(key);
  if (!raw) return rejectInvite();
  const invite = JSON.parse(raw) as Invite;
  if (invite.expiresAt < Date.now() || invite.usesLeft <= 0) {
    return rejectInvite();
  }
  // ponytail: KV read-modify-write — concurrent joins can over-admit by ~1;
  // move to a DO/atomic counter if invites ever guard anything scarce.
  await env.ROUTING.put(
    key,
    JSON.stringify({ ...invite, usesLeft: invite.usesLeft - 1 }),
  );
  const member: SpaceMember = {
    space: invite.space,
    installationId: invite.installationId,
    owner: invite.owner,
    repo: invite.repo,
    branch: invite.branch,
    author: body.author,
    authorEmail: body.authorEmail,
  };
  const token = await mintMember(env, member);
  // Operator ledger line: the hash IS the revoke handle. Never the raw token.
  console.log(
    `join: space=${invite.space} author=${JSON.stringify(body.author)} tokenHash=${await sha256Hex(token)}`,
  );
  return Response.json({ token, member });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd gateway && npm test`
Expected: PASS, including all 5 new invite tests and every pre-existing test.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/invites.ts gateway/test/invites.test.mjs gateway/dist
git commit -m "feat(gateway): invite codes — admin mint + public /join self-minting"
```

---

### Task 3: Route `/admin/invites` and `/join`

**Files:**
- Modify: `gateway/src/router.ts:2-6` (imports) and `gateway/src/router.ts:78-80` (routes, after `/admin/product-repos`)
- Test: `gateway/test/router.test.mjs` (append)

**Interfaces:**
- Consumes: `handleAdminCreateInvite`, `handleJoin` from `./invites.js` (Task 2).
- Produces: live URLs `POST /admin/invites`, `POST /join` — Task 4's CLI calls `/join`; the playbook curls `/admin/invites`.

- [ ] **Step 1: Write the failing test**

Append to `gateway/test/router.test.mjs`:

```js
test("routes POST /admin/invites and POST /join", async () => {
  const env = makeEnv();
  const inviteRes = await handleRequest(
    new Request("https://gw.test/admin/invites", {
      method: "POST",
      headers: {
        "x-admin-secret": "test-admin-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        space: "team-a",
        owner: "acme",
        repo: "team-a-memory",
        installationId: 777,
      }),
    }),
    env,
  );
  assert.equal(inviteRes.status, 200);
  const { invite } = await inviteRes.json();

  const joinRes = await handleRequest(
    new Request("https://gw.test/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        invite,
        author: "David",
        authorEmail: "d@spear.ai",
      }),
    }),
    env,
  );
  assert.equal(joinRes.status, 200);
  assert.match((await joinRes.json()).token, /^mlk_/);
});
```

(Reuse the file's existing `makeEnv`/`handleRequest` imports; add any missing ones to its import block.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd gateway && npm test 2>&1 | grep -B1 -A3 "routes POST /admin/invites"`
Expected: FAIL — `/admin/invites` returns the router's 404.

- [ ] **Step 3: Wire the routes**

In `gateway/src/router.ts`, add to imports:

```ts
import { handleAdminCreateInvite, handleJoin } from "./invites.js";
```

After the `/admin/product-repos` block (line ~80):

```ts
  if (url.pathname === "/admin/invites" && req.method === "POST") {
    return handleAdminCreateInvite(req, env);
  }

  if (url.pathname === "/join" && req.method === "POST") {
    return handleJoin(req, env);
  }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd gateway && npm test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add gateway/src/router.ts gateway/test/router.test.mjs gateway/dist
git commit -m "feat(gateway): route /admin/invites and /join"
```

---

### Task 4: CLI — `wayform init --remote --invite wfi_…`

**Files:**
- Modify: `src/init-remote.ts:122-155` (flag parsing + identity block in `runInitRemote`; add `joinGateway` export above it)
- Test: `test/init-remote.test.mjs` (append)

**Interfaces:**
- Consumes: `POST /join` JSON contract from Task 2: request `{invite, author, authorEmail}` → 200 `{token, member}`.
- Produces: `export async function joinGateway(gatewayUrl: string, invite: string, author: string, email: string, fetchImpl?: typeof fetch): Promise<string>` (returns the `mlk_` token). `--invite` accepted wherever `--token` was.

- [ ] **Step 1: Write the failing test**

Append to `test/init-remote.test.mjs` (it already imports from `../dist/init-remote.js`; add `joinGateway` to that import):

```js
test("joinGateway exchanges an invite for a token via POST /join", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({ token: "mlk_fresh", member: { space: "team-a" } }),
      { status: 200 },
    );
  };
  const token = await joinGateway(
    "https://gw.test",
    "wfi_abc",
    "David",
    "d@spear.ai",
    fetchImpl,
  );
  assert.equal(token, "mlk_fresh");
  assert.equal(captured.url, "https://gw.test/join");
  assert.deepEqual(captured.body, {
    invite: "wfi_abc",
    author: "David",
    authorEmail: "d@spear.ai",
  });
});

test("joinGateway surfaces the gateway's error body", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: "invalid or expired invite" }), {
      status: 400,
    });
  await assert.rejects(
    () => joinGateway("https://gw.test", "wfi_bad", "A", "a@x.io", fetchImpl),
    /invite join failed \(400\)/,
  );
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test 2>&1 | grep -A2 joinGateway`
Expected: FAIL — `joinGateway` is not exported (compile error).

- [ ] **Step 3: Implement**

In `src/init-remote.ts`, add above `runInitRemote`:

```ts
/**
 * Exchange a team invite for this member's own personal token via the
 * gateway's public /join. The token is minted server-side and returned
 * exactly once — it exists nowhere but this process until init writes it
 * to the 0600 secret files.
 */
export async function joinGateway(
  gatewayUrl: string,
  invite: string,
  author: string,
  email: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`${gatewayUrl}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invite, author, authorEmail: email }),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`invite join failed (${res.status}): ${detail}`);
  }
  const { token } = (await res.json()) as { token: string };
  return token;
}
```

In `runInitRemote`, replace lines 130-136 (`const gatewayUrl ...` through the error `process.exit`) with:

```ts
  const gatewayUrl = (flag(args, "gateway") ?? "").replace(/\/+$/, "");
  let token = flag(args, "token") ?? "";
  const inviteCode = flag(args, "invite") ?? "";
  if (!gatewayUrl || (!token && !inviteCode)) {
    console.error(
      "wayform init --remote requires --gateway <url> and --token <mlk_...> or --invite <wfi_...>",
    );
    process.exit(1);
  }
```

Then, immediately AFTER the identity block resolves `author` and `email` (after current line ~154, before `const project = ...`), insert:

```ts
  if (!token) {
    token = await joinGateway(gatewayUrl, inviteCode, author, email);
    console.log("  joined via invite — minted your personal member token");
  }
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS (176 pre-existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/init-remote.ts test/init-remote.test.mjs dist
git commit -m "feat(cli): init --remote --invite self-mints via /join"
```

---

### Task 5: `space create` mints + prints the team invite

**Files:**
- Modify: `src/space-create.ts:200-226` (add `createTeamInvite` beside `mintMemberToken`) and `src/space-create.ts:311-318` (handoff print)
- Test: `test/space-create.test.mjs` (append)

**Interfaces:**
- Consumes: `POST /admin/invites` contract from Task 2: `{space, owner, repo, installationId}` + `x-admin-secret` header → 200 `{invite, expiresAt, usesLeft}`.
- Produces: `export async function createTeamInvite(gatewayUrl: string, adminSecret: string, body: {space: string; installationId: number; owner: string; repo: string}, fetchImpl?: typeof fetch): Promise<string>` (returns the `wfi_` code). Handoff output now contains `--invite`, not the leader's token.

- [ ] **Step 1: Write the failing test**

Append to `test/space-create.test.mjs` (add `createTeamInvite` to its `../dist/space-create.js` import):

```js
test("createTeamInvite posts to /admin/invites and returns the code", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = {
      url: String(url),
      secret: init.headers["x-admin-secret"],
      body: JSON.parse(init.body),
    };
    return new Response(
      JSON.stringify({ invite: "wfi_team", expiresAt: 1, usesLeft: 25 }),
      { status: 200 },
    );
  };
  const code = await createTeamInvite(
    "https://gw.test",
    "sekret",
    { space: "team-a", installationId: 777, owner: "acme", repo: "team-a-memory" },
    fetchImpl,
  );
  assert.equal(code, "wfi_team");
  assert.equal(captured.url, "https://gw.test/admin/invites");
  assert.equal(captured.secret, "sekret");
  assert.equal(captured.body.space, "team-a");
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm test 2>&1 | grep -A2 createTeamInvite`
Expected: FAIL — `createTeamInvite` not exported (compile error).

- [ ] **Step 3: Implement**

In `src/space-create.ts`, add below `mintMemberToken`:

```ts
export async function createTeamInvite(
  gatewayUrl: string,
  adminSecret: string,
  body: {
    space: string;
    installationId: number;
    owner: string;
    repo: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`${gatewayUrl}/admin/invites`, {
    method: "POST",
    headers: {
      "x-admin-secret": adminSecret,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`invite mint failed (${res.status}): ${detail}`);
  }
  const { invite } = (await res.json()) as { invite: string };
  return invite;
}
```

In `runSpaceCreate`, replace the final handoff block (from `d.log("");` after `mintMemberToken` through the last `d.log`) with:

```ts
  const invite = await createTeamInvite(
    gatewayUrl,
    adminSecret,
    {
      space: parsed.space,
      installationId,
      owner: parsed.owner,
      repo: parsed.repo,
    },
    d.fetchImpl,
  );

  d.log("");
  d.log(`Space "${parsed.space}" created.`);
  d.log(`Your token (shown once): ${minted.token}`);
  d.log("");
  d.log("Hand this ONE line to each teammate — each mints their own token");
  d.log("(invite expires in 14 days / 25 uses; send via email or a Slack");
  d.log("code block, never iMessage — it mangles the dashes):");
  d.log(
    `  wayform init --remote --gateway ${gatewayUrl} --invite ${invite}`,
  );
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm test`
Expected: PASS. If an existing `runSpaceCreate` end-to-end test asserts the old `--token` handoff line, update that assertion to expect `--invite wfi_team` and add a `/admin/invites` response to its fetch stub.

- [ ] **Step 5: Commit**

```bash
git add src/space-create.ts test/space-create.test.mjs dist
git commit -m "feat(cli): space create hands teammates an invite, not the leader's token"
```

---

### Task 6: Playbook + deploy + live verification

**Files:**
- Modify: `docs/onboarding/pilot-onboarding.local.md` (untracked/gitignored — edit, do NOT commit)

**Interfaces:**
- Consumes: everything above, deployed.

- [ ] **Step 1: Update the playbook**

In Checklist A, add after the token-mint step: "OR mint one team invite (14d/25 uses) and skip per-member mints:"

```
curl -X POST $GATEWAY/admin/invites -H "x-admin-secret: $ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"space":"<slug>","owner":"<owner>","repo":"<repo>","installationId":<id>}'
```

Collapse Checklist B step 1 to: "dev runs `wayform init --remote --gateway <url> --invite wfi_…` (one line, email/Slack code block only)". Note in the token-ledger section: `/join` mints are logged by the gateway as `join: space=… author=… tokenHash=…` — pull rows from Workers logs (`npx wrangler tail` or dashboard).

- [ ] **Step 2: Deploy the gateway**

Run: `cd gateway && npx wrangler deploy`
Expected: new version id printed, no errors.

- [ ] **Step 3: Live smoke test**

```bash
# mint a real invite against the dogfood space (values from the playbook quick-ref)
curl -sX POST $GATEWAY/admin/invites -H "x-admin-secret: $ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"space":"<dogfood-space>","owner":"<owner>","repo":"<repo>","installationId":<id>}'
# join with it
curl -sX POST $GATEWAY/join -H "content-type: application/json" \
  -d '{"invite":"<wfi_from_above>","author":"Smoke Test","authorEmail":"smoke@test.local"}'
```

Expected: `/join` returns `{token: "mlk_…", member: {...}}`; a second look at Workers logs shows the `join:` ledger line. Then revoke the smoke-test member (delete its `member:<hash>` KV key using the tokenHash from the log line) and delete the test invite's KV key.

- [ ] **Step 4: Commit nothing here; open the PR**

```bash
git push -u origin feat/invite-code-join
gh pr create --title "feat: invite-code /join — devs self-mint member tokens" --body "..."
```

---

## Self-review notes

- Spec coverage: invite record (T2), /admin/invites (T2/T3), /join incl. generic 400 + decrement-before-mint + log line (T2), CLI --invite with git-config identity (T4 — identity resolution already precedes the join call), space create handoff (T5), playbook/ledger (T6), tests per behavior (T2–T5), cold-onboard rehearsal stays a manual follow-up outside this plan.
- The spec's "--name/--email override" maps to init-remote's EXISTING `--author`/`--email` flags — no new flags needed; author is resolved before `joinGateway` runs.
- Type check: `mintMember(env, member) → Promise<string>` used identically in T1 and T2; `Invite` fields match between mint and join; `joinGateway` returns the bare token string.
