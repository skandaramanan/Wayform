# Plan C — `wayform space create` Onboarding CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `wayform space create --space <name> --owner <owner> --repo <repo> --gateway <url>`, a single command that creates the space's GitHub repo, walks the operator through GitHub App installation, mints the first member token, and prints the ready-to-hand-off `wayform init --remote` command — replacing today's four-step manual/`curl` flow.

**Architecture:** One new gateway admin endpoint (`GET /admin/installations`) resolves a GitHub App installation ID for an owner, using the App JWT logic the gateway already has. One new CLI module (`src/space-create.ts`) orchestrates repo creation (gh-first, PAT fallback), polls that endpoint, then calls the existing `POST /admin/members`. A new CI job runs the gateway's test suite, which previously only ran locally.

**Tech Stack:** TypeScript, Node built-ins only (`node:child_process`, `node:readline/promises`) — no new dependencies. `node:test` for both packages. Cloudflare Workers (gateway) via existing `Env`/KV patterns.

## Global Constraints

- No new npm dependencies in either package — this plan uses only what's already installed (Node built-ins, `node:test`).
- `WAYFORM_ADMIN_SECRET` is read from an environment variable only, never a CLI flag (avoids shell-history/process-list exposure of the shared operator credential).
- Any GitHub PAT entered via the fallback prompt lives only in process memory for the one REST call that uses it — never written to disk.
- `--owner` and `--repo` are separate, explicit CLI inputs — never derived from `--space`.
- Post-mint handoff is print-only: the CLI never writes to the operator's local project or chains into `wayform init --remote`.
- CI wiring is test-only: no deploy job, no new GitHub repo secrets.
- Gateway's `engines.node` floor is `>=20` (root CLI package's floor is `>=18`) — the new CI job pins Node 20, independent of the root package's OS/Node matrix.
- Ambiguous installation matches (2+ installations for one owner) are a hard error with a manual fallback — no disambiguation UI (pilot-scale assumption, matches the existing `/admin/members` comment).

---

## Task 1: Gateway — `GET /admin/installations` endpoint

**Files:**
- Modify: `gateway/src/tenancy.ts` (add `handleAdminListInstallations`, import `appJwt`)
- Modify: `gateway/src/router.ts` (wire the new route)
- Test: `gateway/test/tenancy.test.mjs`

**Interfaces:**
- Consumes: `appJwt(appId, privateKeyPem)` from `gateway/src/github-auth.ts` (existing, returns `Promise<string>`); `Env` from `gateway/src/env.ts` (existing, has `githubFetch?: typeof fetch`).
- Produces: `handleAdminListInstallations(req: Request, env: Env): Promise<Response>`, exported from `gateway/src/tenancy.ts`. On success: `200 { installationId: number }`. Errors: `403` (bad/missing `x-admin-secret`), `400` (missing `owner` query param), `404` (no installation for that owner), `409 { error: string, installationIds: number[] }` (ambiguous), `502` (GitHub API call failed). Routed at `GET /admin/installations?owner=<owner>` in `router.ts`.

- [ ] **Step 1: Write the failing tests**

Add to `gateway/test/tenancy.test.mjs` (append after the existing tests; the file already imports `handleRequest` from `../dist/gateway/src/router.js` and `makeEnv`/`ghFetch` from `./helpers.mjs`):

```javascript
import { handleAdminListInstallations } from "../dist/gateway/src/tenancy.js";

function listInstallations(env, owner, secret = "test-admin-secret") {
  return handleRequest(
    new Request(
      `https://gw.test/admin/installations?owner=${encodeURIComponent(owner)}`,
    ),
    env,
  );
}

test("admin installations: 403 on wrong/missing secret", async () => {
  const env = makeEnv();
  const res = await listInstallations(env, "acme", "wrong");
  assert.equal(res.status, 403);
});

test("admin installations: 400 when owner query param is missing", async () => {
  const env = makeEnv();
  const res = await handleRequest(
    new Request("https://gw.test/admin/installations"),
    env,
  );
  assert.equal(res.status, 400);
});

test("admin installations: 200 with installationId on a single case-insensitive match", async () => {
  const fetchImpl = ghFetch([], [
    [
      "/app/installations?per_page=100",
      () =>
        Response.json([
          { id: 111, account: { login: "OtherOrg" } },
          { id: 222, account: { login: "Acme" } },
        ]),
    ],
  ]);
  const env = makeEnv(fetchImpl);
  const res = await listInstallations(env, "acme");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { installationId: 222 });
});

test("admin installations: 404 when no installation matches the owner", async () => {
  const fetchImpl = ghFetch([], [
    [
      "/app/installations?per_page=100",
      () => Response.json([{ id: 111, account: { login: "OtherOrg" } }]),
    ],
  ]);
  const env = makeEnv(fetchImpl);
  const res = await listInstallations(env, "acme");
  assert.equal(res.status, 404);
});

test("admin installations: 409 with all matching IDs when the owner is ambiguous", async () => {
  const fetchImpl = ghFetch([], [
    [
      "/app/installations?per_page=100",
      () =>
        Response.json([
          { id: 111, account: { login: "acme" } },
          { id: 222, account: { login: "acme" } },
        ]),
    ],
  ]);
  const env = makeEnv(fetchImpl);
  const res = await listInstallations(env, "acme");
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.deepEqual(body.installationIds.sort(), [111, 222]);
});

test("admin installations: 502 when GitHub's API call fails", async () => {
  const fetchImpl = ghFetch([], [
    ["/app/installations?per_page=100", () => new Response("nope", { status: 500 })],
  ]);
  const env = makeEnv(fetchImpl);
  const res = await listInstallations(env, "acme");
  assert.equal(res.status, 502);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd gateway && npm test 2>&1 | grep -i "admin installations"`
Expected: FAIL — `handleAdminListInstallations` is not exported / route 404s (the import itself will throw since the export doesn't exist yet).

- [ ] **Step 3: Implement `handleAdminListInstallations`**

In `gateway/src/tenancy.ts`, change the import line to include `appJwt`:

```typescript
import { b64url, appJwt } from "./github-auth.js";
```

Append this function at the end of the file:

```typescript
/**
 * GET /admin/installations?owner=<owner> — resolve a GitHub App
 * installation ID for an owner, so the CLI onboarding flow (Plan C) can
 * detect "the operator finished installing the App" without ever holding
 * GITHUB_APP_PRIVATE_KEY itself. Pilot-scale assumption: one installation
 * per account — two-plus matches is a 409, resolved manually.
 */
export async function handleAdminListInstallations(
  req: Request,
  env: Env,
): Promise<Response> {
  if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const owner = new URL(req.url).searchParams.get("owner");
  if (!owner) {
    return Response.json({ error: "missing owner" }, { status: 400 });
  }
  const fetchImpl = env.githubFetch ?? fetch;
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const res = await fetchImpl(
    "https://api.github.com/app/installations?per_page=100",
    {
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": "memorylayer-gateway",
      },
    },
  );
  if (!res.ok) {
    return Response.json(
      { error: `github installations list failed: ${res.status}` },
      { status: 502 },
    );
  }
  const installations = (await res.json()) as {
    id: number;
    account: { login: string };
  }[];
  const matches = installations.filter(
    (i) => i.account?.login?.toLowerCase() === owner.toLowerCase(),
  );
  if (matches.length === 0) {
    return Response.json(
      { error: `no installation found for owner "${owner}"` },
      { status: 404 },
    );
  }
  if (matches.length > 1) {
    return Response.json(
      {
        error: `multiple installations found for owner "${owner}"`,
        installationIds: matches.map((m) => m.id),
      },
      { status: 409 },
    );
  }
  return Response.json({ installationId: matches[0].id });
}
```

- [ ] **Step 4: Wire the route**

In `gateway/src/router.ts`, change the import line:

```typescript
import { handleAdminAddMember, handleAdminListInstallations } from "./tenancy.js";
```

Add the route inside `route()`, right after the existing `/admin/members` block:

```typescript
  if (url.pathname === "/admin/installations" && req.method === "GET") {
    return handleAdminListInstallations(req, env);
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd gateway && npm test 2>&1 | tail -20`
Expected: all tests pass, including the 6 new ones (`ℹ pass 109` — up from 103).

- [ ] **Step 6: Commit**

```bash
git add gateway/src/tenancy.ts gateway/src/router.ts gateway/test/tenancy.test.mjs
git commit -m "feat(gateway): add GET /admin/installations for Plan C install detection"
```

---

## Task 2: CLI — argument parsing and admin-secret resolution

**Files:**
- Create: `src/space-create.ts`
- Test: `test/space-create.test.mjs`

**Interfaces:**
- Produces: `parseSpaceCreateArgs(args: string[]): SpaceCreateArgs` where
  `SpaceCreateArgs = { space: string; owner: string; repo: string; isPublic: boolean; appSlug: string; author?: string; authorEmail?: string }`.
  Throws `Error` if `--space`, `--owner`, or `--repo` is missing, or if neither
  `--app-slug` nor `WAYFORM_GITHUB_APP_SLUG` is set.
  `resolveAdminSecret(): string` — reads `process.env.WAYFORM_ADMIN_SECRET`,
  throws `Error` if unset.

- [ ] **Step 1: Write the failing tests**

Create `test/space-create.test.mjs`:

```javascript
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSpaceCreateArgs,
  resolveAdminSecret,
} from "../dist/space-create.js";

test("parseSpaceCreateArgs reads required flags and defaults isPublic to false", () => {
  const parsed = parseSpaceCreateArgs([
    "--space",
    "team-a",
    "--owner",
    "acme",
    "--repo",
    "team-a-memory",
    "--app-slug",
    "wayform-memory",
  ]);
  assert.deepEqual(parsed, {
    space: "team-a",
    owner: "acme",
    repo: "team-a-memory",
    isPublic: false,
    appSlug: "wayform-memory",
    author: undefined,
    authorEmail: undefined,
  });
});

test("parseSpaceCreateArgs reads --public, --author, --author-email overrides", () => {
  const parsed = parseSpaceCreateArgs([
    "--space",
    "team-a",
    "--owner",
    "acme",
    "--repo",
    "team-a-memory",
    "--app-slug",
    "wayform-memory",
    "--public",
    "--author",
    "Ada",
    "--author-email",
    "ada@acme.io",
  ]);
  assert.equal(parsed.isPublic, true);
  assert.equal(parsed.author, "Ada");
  assert.equal(parsed.authorEmail, "ada@acme.io");
});

test("parseSpaceCreateArgs falls back to WAYFORM_GITHUB_APP_SLUG env var", () => {
  process.env.WAYFORM_GITHUB_APP_SLUG = "env-slug";
  try {
    const parsed = parseSpaceCreateArgs([
      "--space",
      "team-a",
      "--owner",
      "acme",
      "--repo",
      "team-a-memory",
    ]);
    assert.equal(parsed.appSlug, "env-slug");
  } finally {
    delete process.env.WAYFORM_GITHUB_APP_SLUG;
  }
});

test("parseSpaceCreateArgs throws when --space, --owner, or --repo is missing", () => {
  assert.throws(() => parseSpaceCreateArgs(["--owner", "acme", "--repo", "r"]));
  assert.throws(() => parseSpaceCreateArgs(["--space", "s", "--repo", "r"]));
  assert.throws(() => parseSpaceCreateArgs(["--space", "s", "--owner", "acme"]));
});

test("parseSpaceCreateArgs throws when no app slug is available", () => {
  delete process.env.WAYFORM_GITHUB_APP_SLUG;
  assert.throws(
    () =>
      parseSpaceCreateArgs([
        "--space",
        "s",
        "--owner",
        "acme",
        "--repo",
        "r",
      ]),
    /app-slug/,
  );
});

test("resolveAdminSecret reads WAYFORM_ADMIN_SECRET, throws when unset", () => {
  const prev = process.env.WAYFORM_ADMIN_SECRET;
  try {
    process.env.WAYFORM_ADMIN_SECRET = "shh";
    assert.equal(resolveAdminSecret(), "shh");
    delete process.env.WAYFORM_ADMIN_SECRET;
    assert.throws(() => resolveAdminSecret(), /WAYFORM_ADMIN_SECRET/);
  } finally {
    if (prev === undefined) delete process.env.WAYFORM_ADMIN_SECRET;
    else process.env.WAYFORM_ADMIN_SECRET = prev;
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build 2>&1 | tail -20`
Expected: FAIL — `src/space-create.ts` does not exist yet (build error), so `dist/space-create.js` is missing.

- [ ] **Step 3: Write the implementation**

Create `src/space-create.ts`:

```typescript
/**
 * `wayform space create` — Plan C: automates the operator flow for standing
 * up a new hosted space (repo creation, GitHub App install detection, member
 * token mint). Operator-only: requires WAYFORM_ADMIN_SECRET, the same shared
 * credential the manual `curl` flow against POST /admin/members already uses.
 */
const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const has = (args: string[], name: string): boolean =>
  args.includes(`--${name}`);

export interface SpaceCreateArgs {
  space: string;
  owner: string;
  repo: string;
  isPublic: boolean;
  appSlug: string;
  author?: string;
  authorEmail?: string;
}

export function parseSpaceCreateArgs(args: string[]): SpaceCreateArgs {
  const space = flag(args, "space");
  const owner = flag(args, "owner");
  const repo = flag(args, "repo");
  if (!space || !owner || !repo) {
    throw new Error(
      "wayform space create requires --space <name> --owner <owner> --repo <repo>",
    );
  }
  const appSlug = flag(args, "app-slug") ?? process.env.WAYFORM_GITHUB_APP_SLUG;
  if (!appSlug) {
    throw new Error(
      "wayform space create requires --app-slug <slug> or WAYFORM_GITHUB_APP_SLUG " +
        "(the GitHub App's slug, used to build the install URL)",
    );
  }
  return {
    space,
    owner,
    repo,
    isPublic: has(args, "public"),
    appSlug,
    author: flag(args, "author"),
    authorEmail: flag(args, "author-email"),
  };
}

export function resolveAdminSecret(): string {
  const secret = process.env.WAYFORM_ADMIN_SECRET;
  if (!secret) {
    throw new Error(
      "WAYFORM_ADMIN_SECRET is not set. `wayform space create` is an " +
        "operator-only command — export the gateway's ADMIN_SECRET before running it.",
    );
  }
  return secret;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/space-create.test.mjs`
Expected: PASS, all 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/space-create.ts test/space-create.test.mjs
git commit -m "feat(cli): add space-create arg parsing and admin-secret resolution"
```

---

## Task 3: CLI — repo creation (gh-first, PAT fallback)

**Files:**
- Modify: `src/space-create.ts`
- Test: `test/space-create.test.mjs`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: `type Runner = (cmd: string, args: string[]) => void`;
  `ghAuthenticated(run?: Runner): boolean`;
  `createRepoWithGh(owner: string, repo: string, isPublic: boolean, run?: Runner): void`;
  `createRepoWithPat(owner: string, repo: string, isPublic: boolean, pat: string, fetchImpl?: typeof fetch): Promise<void>` — throws `Error` on a non-ok response from both the org and user repo-creation endpoints.

- [ ] **Step 1: Write the failing tests**

Append to `test/space-create.test.mjs`:

```javascript
import {
  ghAuthenticated,
  createRepoWithGh,
  createRepoWithPat,
} from "../dist/space-create.js";

test("ghAuthenticated returns true when `gh auth status` succeeds", () => {
  assert.equal(
    ghAuthenticated(() => {}),
    true,
  );
});

test("ghAuthenticated returns false when the run throws (gh absent or unauthenticated)", () => {
  assert.equal(
    ghAuthenticated(() => {
      throw new Error("spawn gh ENOENT");
    }),
    false,
  );
});

test("createRepoWithGh shells out to `gh repo create` with --private by default", () => {
  let seen;
  createRepoWithGh("acme", "team-a-memory", false, (cmd, args) => {
    seen = { cmd, args };
  });
  assert.equal(seen.cmd, "gh");
  assert.deepEqual(seen.args, [
    "repo",
    "create",
    "acme/team-a-memory",
    "--private",
  ]);
});

test("createRepoWithGh passes --public when isPublic is true", () => {
  let seen;
  createRepoWithGh("acme", "team-a-memory", true, (cmd, args) => {
    seen = { cmd, args };
  });
  assert.deepEqual(seen.args.at(-1), "--public");
});

test("createRepoWithPat tries the org endpoint first and succeeds there", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    assert.equal(init.headers.authorization, "Bearer pat_x");
    return new Response("{}", { status: 201 });
  };
  await createRepoWithPat("acme", "team-a-memory", false, "pat_x", fetchImpl);
  assert.deepEqual(calls, ["https://api.github.com/orgs/acme/repos"]);
});

test("createRepoWithPat falls back to /user/repos when the org endpoint 404s", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/orgs/")) return new Response("nope", { status: 404 });
    return new Response("{}", { status: 201 });
  };
  await createRepoWithPat("skanda", "personal-space", false, "pat_x", fetchImpl);
  assert.deepEqual(calls, [
    "https://api.github.com/orgs/skanda/repos",
    "https://api.github.com/user/repos",
  ]);
});

test("createRepoWithPat throws with GitHub's error body when both endpoints fail", async () => {
  const fetchImpl = async (url) =>
    String(url).includes("/orgs/")
      ? new Response("nope", { status: 404 })
      : new Response("already exists", { status: 422 });
  await assert.rejects(
    () => createRepoWithPat("acme", "team-a-memory", false, "pat_x", fetchImpl),
    /422.*already exists/s,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build 2>&1 | tail -20`
Expected: FAIL — `ghAuthenticated`, `createRepoWithGh`, `createRepoWithPat` are not exported yet.

- [ ] **Step 3: Write the implementation**

Add to `src/space-create.ts` (below the existing imports area — add the `node:child_process` import at the top of the file alongside no other imports currently present):

```typescript
import { execFileSync } from "node:child_process";
```

Append:

```typescript
export type Runner = (cmd: string, args: string[]) => void;

const defaultRunner: Runner = (cmd, args) =>
  // Bounded + non-interactive, same posture as init-remote's registerClaudeCodeMcp:
  // a hanging or prompting child process must never freeze space create.
  void execFileSync(cmd, args, {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 15000,
  });

export function ghAuthenticated(run: Runner = defaultRunner): boolean {
  try {
    run("gh", ["auth", "status"]);
    return true;
  } catch {
    return false;
  }
}

export function createRepoWithGh(
  owner: string,
  repo: string,
  isPublic: boolean,
  run: Runner = defaultRunner,
): void {
  run("gh", [
    "repo",
    "create",
    `${owner}/${repo}`,
    isPublic ? "--public" : "--private",
  ]);
}

/**
 * Tries the org repo-creation endpoint first, falls back to /user/repos on a
 * 404 (the owner isn't an org this token can create under — the common case
 * when --owner is the token holder's own username).
 */
export async function createRepoWithPat(
  owner: string,
  repo: string,
  isPublic: boolean,
  pat: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const body = JSON.stringify({ name: repo, private: !isPublic });
  const headers = {
    authorization: `Bearer ${pat}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "wayform-cli",
  };
  let res = await fetchImpl(`https://api.github.com/orgs/${owner}/repos`, {
    method: "POST",
    headers,
    body,
  });
  if (res.status === 404) {
    res = await fetchImpl("https://api.github.com/user/repos", {
      method: "POST",
      headers,
      body,
    });
  }
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GitHub repo creation failed (${res.status}): ${detail}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/space-create.test.mjs`
Expected: PASS, all 12 tests green (6 from Task 2 + 6 new).

- [ ] **Step 5: Commit**

```bash
git add src/space-create.ts test/space-create.test.mjs
git commit -m "feat(cli): add gh-first/PAT-fallback repo creation for space create"
```

---

## Task 4: CLI — GitHub App install-detection polling

**Files:**
- Modify: `src/space-create.ts`
- Test: `test/space-create.test.mjs`

**Interfaces:**
- Consumes: nothing new from other tasks (calls the `GET /admin/installations` endpoint from Task 1 over HTTP — no direct code dependency).
- Produces: `interface PollOptions { intervalMs: number; timeoutMs: number }`;
  `pollInstallation(gatewayUrl: string, adminSecret: string, owner: string, fetchImpl?: typeof fetch, opts?: PollOptions, sleep?: (ms: number) => Promise<void>): Promise<number>` — resolves to `installationId`; throws on timeout or a `409` ambiguous response.

- [ ] **Step 1: Write the failing tests**

Append to `test/space-create.test.mjs`:

```javascript
import { pollInstallation } from "../dist/space-create.js";

test("pollInstallation returns installationId as soon as the gateway reports 200", async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(init.headers["x-admin-secret"], "secret");
    assert.equal(
      String(url),
      "https://gw.example.com/admin/installations?owner=acme",
    );
    return Response.json({ installationId: 42 });
  };
  const id = await pollInstallation(
    "https://gw.example.com",
    "secret",
    "acme",
    fetchImpl,
    { intervalMs: 10, timeoutMs: 1000 },
    async () => {},
  );
  assert.equal(id, 42);
  assert.equal(calls, 1);
});

test("pollInstallation retries on 404 (not installed yet) until it succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return calls < 3
      ? new Response("{}", { status: 404 })
      : Response.json({ installationId: 7 });
  };
  const sleeps = [];
  const id = await pollInstallation(
    "https://gw.example.com",
    "secret",
    "acme",
    fetchImpl,
    { intervalMs: 10, timeoutMs: 5000 },
    async (ms) => sleeps.push(ms),
  );
  assert.equal(id, 7);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [10, 10]);
});

test("pollInstallation throws immediately on 409 (ambiguous match)", async () => {
  const fetchImpl = async () =>
    Response.json(
      { error: "ambiguous", installationIds: [1, 2] },
      { status: 409 },
    );
  await assert.rejects(
    () =>
      pollInstallation(
        "https://gw.example.com",
        "secret",
        "acme",
        fetchImpl,
        { intervalMs: 10, timeoutMs: 5000 },
        async () => {},
      ),
    /1, 2/,
  );
});

test("pollInstallation throws with a manual-fallback message on timeout", async () => {
  const fetchImpl = async () => new Response("{}", { status: 404 });
  await assert.rejects(
    () =>
      pollInstallation(
        "https://gw.example.com",
        "secret",
        "acme",
        fetchImpl,
        { intervalMs: 1000, timeoutMs: 1 },
        async () => {},
      ),
    /Timed out.*admin\/members/s,
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build 2>&1 | tail -20`
Expected: FAIL — `pollInstallation` is not exported yet.

- [ ] **Step 3: Write the implementation**

Append to `src/space-create.ts`:

```typescript
export interface PollOptions {
  intervalMs: number;
  timeoutMs: number;
}

const DEFAULT_POLL: PollOptions = { intervalMs: 3000, timeoutMs: 120_000 };
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function pollInstallation(
  gatewayUrl: string,
  adminSecret: string,
  owner: string,
  fetchImpl: typeof fetch = fetch,
  opts: PollOptions = DEFAULT_POLL,
  sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<number> {
  const deadline = Date.now() + opts.timeoutMs;
  const url = `${gatewayUrl}/admin/installations?owner=${encodeURIComponent(owner)}`;
  const manualFallback =
    `curl -X POST ${gatewayUrl}/admin/members -H "x-admin-secret: <secret>" ` +
    `-H "content-type: application/json" -d '{"space":"...","installationId":<id>,` +
    `"owner":"${owner}","repo":"...","author":"...","authorEmail":"..."}'`;

  while (true) {
    const res = await fetchImpl(url, {
      headers: { "x-admin-secret": adminSecret },
    });
    if (res.status === 200) {
      const body = (await res.json()) as { installationId: number };
      return body.installationId;
    }
    if (res.status === 409) {
      const body = (await res.json()) as { installationIds: number[] };
      throw new Error(
        `Multiple GitHub App installations found for owner "${owner}" ` +
          `(${body.installationIds.join(", ")}). Resolve manually, then mint the ` +
          `token directly:\n  ${manualFallback}`,
      );
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for the GitHub App install on "${owner}". Install it, ` +
          `then mint the token manually:\n  ${manualFallback}`,
      );
    }
    await sleep(opts.intervalMs);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/space-create.test.mjs`
Expected: PASS, all 16 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/space-create.ts test/space-create.test.mjs
git commit -m "feat(cli): add GitHub App install-detection polling for space create"
```

---

## Task 5: CLI — token mint, handoff, orchestration, and `cli.ts` wiring

**Files:**
- Modify: `src/space-create.ts`
- Modify: `src/cli.ts`
- Test: `test/space-create.test.mjs`

**Interfaces:**
- Consumes: `gitConfigDefault(key: "user.name" | "user.email"): string` from `src/init-env.ts` (existing); `parseSpaceCreateArgs`, `resolveAdminSecret`, `ghAuthenticated`, `createRepoWithGh`, `createRepoWithPat`, `pollInstallation` (Tasks 2–4, same file).
- Produces: `interface MintedMember { token: string; member: { space: string; installationId: number; owner: string; repo: string; branch: string; author: string; authorEmail: string } }`;
  `mintMemberToken(gatewayUrl: string, adminSecret: string, body: {...}, fetchImpl?: typeof fetch): Promise<MintedMember>`;
  `interface SpaceCreateDeps { run: Runner; fetchImpl: typeof fetch; promptForPat: () => Promise<string>; sleep: (ms: number) => Promise<void>; log: (msg: string) => void; poll: PollOptions }`;
  `runSpaceCreate(args: string[], deps?: Partial<SpaceCreateDeps>): Promise<void>` — the full orchestration, wired into `wayform space create` in `src/cli.ts`.

- [ ] **Step 1: Write the failing tests**

Append to `test/space-create.test.mjs`:

```javascript
import { mintMemberToken, runSpaceCreate } from "../dist/space-create.js";

test("mintMemberToken posts to /admin/members and returns the parsed body", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), init };
    return Response.json({
      token: "mlk_x",
      member: { space: "team-a", installationId: 42 },
    });
  };
  const out = await mintMemberToken(
    "https://gw.example.com",
    "secret",
    {
      space: "team-a",
      installationId: 42,
      owner: "acme",
      repo: "team-a-memory",
      author: "Ada",
      authorEmail: "ada@acme.io",
    },
    fetchImpl,
  );
  assert.equal(out.token, "mlk_x");
  assert.equal(seen.url, "https://gw.example.com/admin/members");
  assert.equal(seen.init.headers["x-admin-secret"], "secret");
  assert.deepEqual(JSON.parse(seen.init.body), {
    space: "team-a",
    installationId: 42,
    owner: "acme",
    repo: "team-a-memory",
    author: "Ada",
    authorEmail: "ada@acme.io",
  });
});

test("mintMemberToken throws with GitHub's/gateway's error body on failure", async () => {
  const fetchImpl = async () => new Response("missing owner", { status: 400 });
  await assert.rejects(
    () =>
      mintMemberToken(
        "https://gw.example.com",
        "secret",
        {
          space: "s",
          installationId: 1,
          owner: "o",
          repo: "r",
          author: "a",
          authorEmail: "a@x.io",
        },
        fetchImpl,
      ),
    /400.*missing owner/s,
  );
});

test("runSpaceCreate: end-to-end happy path via gh, prints the handoff command", async () => {
  process.env.WAYFORM_ADMIN_SECRET = "secret";
  const runCalls = [];
  const fetchCalls = [];
  const logs = [];
  try {
    await runSpaceCreate(
      [
        "--space",
        "team-a",
        "--owner",
        "acme",
        "--repo",
        "team-a-memory",
        "--app-slug",
        "wayform-memory",
        "--gateway",
        "https://gw.example.com",
        "--author",
        "Ada",
        "--author-email",
        "ada@acme.io",
      ],
      {
        run: (cmd, args) => {
          runCalls.push({ cmd, args });
        },
        fetchImpl: async (url, init) => {
          fetchCalls.push(String(url));
          if (String(url).includes("/admin/installations")) {
            return Response.json({ installationId: 42 });
          }
          if (String(url).includes("/admin/members")) {
            return Response.json({
              token: "mlk_handoff",
              member: { space: "team-a" },
            });
          }
          throw new Error(`unexpected fetch: ${url}`);
        },
        sleep: async () => {},
        log: (msg) => logs.push(msg),
      },
    );
  } finally {
    delete process.env.WAYFORM_ADMIN_SECRET;
  }
  assert.deepEqual(runCalls[0], {
    cmd: "gh",
    args: ["auth", "status"],
  });
  assert.deepEqual(runCalls[1], {
    cmd: "gh",
    args: ["repo", "create", "acme/team-a-memory", "--private"],
  });
  assert.ok(fetchCalls.some((u) => u.includes("/admin/installations?owner=acme")));
  assert.ok(fetchCalls.some((u) => u.includes("/admin/members")));
  assert.ok(logs.some((l) => l.includes("mlk_handoff")));
  assert.ok(
    logs.some((l) =>
      l.includes(
        "wayform init --remote --gateway https://gw.example.com --token mlk_handoff",
      ),
    ),
  );
});

test("runSpaceCreate: falls back to the PAT prompt when gh is unavailable", async () => {
  process.env.WAYFORM_ADMIN_SECRET = "secret";
  const fetchCalls = [];
  try {
    await runSpaceCreate(
      [
        "--space",
        "team-a",
        "--owner",
        "acme",
        "--repo",
        "team-a-memory",
        "--app-slug",
        "wayform-memory",
        "--gateway",
        "https://gw.example.com",
        "--author",
        "Ada",
        "--author-email",
        "ada@acme.io",
      ],
      {
        run: () => {
          throw new Error("spawn gh ENOENT");
        },
        promptForPat: async () => "pat_x",
        fetchImpl: async (url, init) => {
          fetchCalls.push(String(url));
          if (String(url).includes("/orgs/")) return new Response("{}", { status: 201 });
          if (String(url).includes("/admin/installations")) {
            return Response.json({ installationId: 42 });
          }
          if (String(url).includes("/admin/members")) {
            return Response.json({ token: "mlk_y", member: {} });
          }
          throw new Error(`unexpected fetch: ${url}`);
        },
        sleep: async () => {},
        log: () => {},
      },
    );
  } finally {
    delete process.env.WAYFORM_ADMIN_SECRET;
  }
  assert.ok(fetchCalls.some((u) => u.includes("https://api.github.com/orgs/acme/repos")));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build 2>&1 | tail -20`
Expected: FAIL — `mintMemberToken` and `runSpaceCreate` are not exported yet.

- [ ] **Step 3: Write the implementation**

Add `readline`/`process` imports to the top of `src/space-create.ts` (alongside the existing `execFileSync` import):

```typescript
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { gitConfigDefault } from "./init-env.js";
```

Append:

```typescript
export interface MintedMember {
  token: string;
  member: {
    space: string;
    installationId: number;
    owner: string;
    repo: string;
    branch: string;
    author: string;
    authorEmail: string;
  };
}

export async function mintMemberToken(
  gatewayUrl: string,
  adminSecret: string,
  body: {
    space: string;
    installationId: number;
    owner: string;
    repo: string;
    author: string;
    authorEmail: string;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<MintedMember> {
  const res = await fetchImpl(`${gatewayUrl}/admin/members`, {
    method: "POST",
    headers: {
      "x-admin-secret": adminSecret,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`token mint failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as MintedMember;
}

export async function promptForPat(): Promise<string> {
  const rl = readline.createInterface({ input, output });
  const pat = await rl.question(
    "gh not found or not authenticated. Paste a GitHub PAT with repo-creation scope: ",
  );
  rl.close();
  return pat.trim();
}

export interface SpaceCreateDeps {
  run: Runner;
  fetchImpl: typeof fetch;
  promptForPat: () => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  poll: PollOptions;
}

const defaultDeps: SpaceCreateDeps = {
  run: defaultRunner,
  fetchImpl: fetch,
  promptForPat,
  sleep: defaultSleep,
  log: (msg) => console.log(msg),
  poll: DEFAULT_POLL,
};

export async function runSpaceCreate(
  args: string[],
  deps: Partial<SpaceCreateDeps> = {},
): Promise<void> {
  const d: SpaceCreateDeps = { ...defaultDeps, ...deps };
  const parsed = parseSpaceCreateArgs(args);
  const gatewayUrl = (flag(args, "gateway") ?? "").replace(/\/+$/, "");
  if (!gatewayUrl) {
    throw new Error("wayform space create requires --gateway <url>");
  }
  const adminSecret = resolveAdminSecret();
  const author = parsed.author ?? gitConfigDefault("user.name");
  const authorEmail = parsed.authorEmail ?? gitConfigDefault("user.email");

  d.log(`Creating repo ${parsed.owner}/${parsed.repo}...`);
  if (ghAuthenticated(d.run)) {
    createRepoWithGh(parsed.owner, parsed.repo, parsed.isPublic, d.run);
  } else {
    const pat = await d.promptForPat();
    await createRepoWithPat(
      parsed.owner,
      parsed.repo,
      parsed.isPublic,
      pat,
      d.fetchImpl,
    );
  }

  d.log(
    `Repo created. Install the GitHub App: https://github.com/apps/${parsed.appSlug}/installations/new`,
  );
  d.log("Waiting for the App to be installed...");
  const installationId = await pollInstallation(
    gatewayUrl,
    adminSecret,
    parsed.owner,
    d.fetchImpl,
    d.poll,
    d.sleep,
  );

  d.log(`Detected installation ${installationId}. Minting member token...`);
  const minted = await mintMemberToken(
    gatewayUrl,
    adminSecret,
    {
      space: parsed.space,
      installationId,
      owner: parsed.owner,
      repo: parsed.repo,
      author,
      authorEmail,
    },
    d.fetchImpl,
  );

  d.log("");
  d.log(`Space "${parsed.space}" created.`);
  d.log(`Token (shown once): ${minted.token}`);
  d.log("");
  d.log("Hand this to each teammate:");
  d.log(
    `  wayform init --remote --gateway ${gatewayUrl} --token ${minted.token}`,
  );
}
```

Now wire it into `src/cli.ts`. Add the import:

```typescript
import { runSpaceCreate } from "./space-create.js";
```

Add a `case "space":` branch above `case "doctor":`:

```typescript
    case "space":
      if (rest[0] === "create") {
        await runSpaceCreate(rest.slice(1));
        return;
      }
      console.error(
        `Unknown "space" subcommand "${rest[0]}". Use: wayform space create --space <name> --owner <owner> --repo <repo> --gateway <url>`,
      );
      process.exit(1);
      return;
```

Update the unknown-command message to mention `space`:

```typescript
      console.error(
        `Unknown command "${sub}". Use: wayform [hook|stop-review|init|doctor|space] …`,
      );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/space-create.test.mjs`
Expected: PASS, all 20 tests green.

- [ ] **Step 5: Run the full test suite**

Run: `npm test 2>&1 | tail -20`
Expected: PASS, all tests green (root package total up from 134 by the 20 new `space-create` tests).

- [ ] **Step 6: Manually verify the CLI wires up correctly**

Run:
```bash
node dist/cli.js space 2>&1; echo "exit: $?"
node dist/cli.js space create --help 2>&1 || true
node dist/cli.js unknown-command 2>&1 | grep -q "space" && echo "usage string updated"
```
Expected: `space` alone prints the "Unknown space subcommand" message and exits 1; the unknown-command message includes `space`.

- [ ] **Step 7: Commit**

```bash
git add src/space-create.ts src/cli.ts test/space-create.test.mjs
git commit -m "feat(cli): wire up wayform space create end to end"
```

---

## Task 6: CI wiring for the gateway package

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:** None (CI config only).

- [ ] **Step 1: Add the gateway job**

Modify `.github/workflows/ci.yml`. The current file is:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run format:check
      - run: npm test
```

Replace it with (adds a second, independent `gateway` job — the existing `test` job for the root CLI package is untouched):

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest]
        node: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run format:check
      - run: npm test

  gateway:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: gateway/package-lock.json
      - run: cd gateway && npm ci
      - run: npm run test:gateway
```

Node 20 matches the gateway's own `engines.node: ">=20"` floor (`gateway/package.json`); it doesn't need the root package's 18/20/22 × OS matrix since it's a single-target Cloudflare Worker, not an npm-distributed CLI. `npm run test:gateway` is the existing root script (`cd gateway && npm test`, which builds then runs `node --test`) — previously defined but never invoked by CI.

- [ ] **Step 2: Validate the YAML locally**

Run: `node -e "require('js-yaml') ? '' : ''" 2>/dev/null; python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml'))" && echo "YAML valid"`

If `python3`/`pyyaml` isn't available, instead run: `cat .github/workflows/ci.yml | node -e "let s=''; process.stdin.on('data',d=>s+=d); process.stdin.on('end',()=>{ if(!s.includes('gateway:')) throw new Error('missing gateway job'); console.log('basic structure check passed');})"`

Expected: no parse errors; `"basic structure check passed"` or `"YAML valid"` printed.

- [ ] **Step 3: Run the exact commands the new job runs, locally**

Run:
```bash
cd gateway && npm ci && npm run test:gateway 2>&1 | tail -5 || true
cd .. && npm run test:gateway 2>&1 | tail -10
```
Expected: PASS — same 109 tests (103 existing + 6 from Task 1) green, confirming the CI job's commands work outside of GitHub Actions too.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run the gateway package's test suite in CI"
```

---

## Self-Review Notes

- **Spec coverage:** §1 CLI command (Task 2), §2 flow steps 1–4 (Tasks 3, 4, 5), §3 gateway change (Task 1), §4 error handling (Tasks 3, 4 — repo-exists/gh-fallback/timeout/409 all covered by tests), §5 testing (every task ships its own tests), §6 CI wiring (Task 6). §7/§8 (out-of-scope, risks) require no tasks — confirmed nothing in them was accidentally implemented (no auto-deploy job, no disambiguation UI, no multi-auth plumbing beyond `resolveAdminSecret()`).
- **Placeholder scan:** no TBD/TODO; every step has runnable code and exact commands.
- **Type consistency:** `MintedMember`, `SpaceCreateArgs`, `PollOptions`, `SpaceCreateDeps`, `Runner` are each defined once (Tasks 2–5) and reused with identical shapes in every later step and test.
- **`--app-slug` deviates slightly from the spec's "defaults to a documented constant."** No real GitHub App slug value exists to hard-code without guessing at production configuration — Task 2 instead requires it via `--app-slug` or `WAYFORM_GITHUB_APP_SLUG`, failing loudly if neither is set. This preserves the spec's intent (no new gateway endpoint just to serve a public string) without embedding a placeholder value in code.
