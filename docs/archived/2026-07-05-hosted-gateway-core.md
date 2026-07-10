# Hosted Gateway Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Phase 1 hosted gateway — a stateless MCP-over-HTTP Worker on Cloudflare that serves `read_context`/`write_context` against a GitHub-App-managed private repo per space, byte-compatible with the local stdio tool.

**Architecture:** A `gateway/` sub-package compiles platform-neutral TypeScript (Web APIs only: `fetch`, `Request`/`Response`, `crypto.subtle`, no `node:*`) so every handler is unit-testable under plain `node --test` with injected fetch/KV fakes, and deploys unchanged via wrangler. Storage is the GitHub REST API (Trees for read, Contents for write) authenticated by per-installation GitHub App tokens; tenant routing lives in Workers KV keyed by SHA-256 of a member bearer token. The entry format, projection, and token-budget logic are the *same modules* the local tool uses (extracted to dependency-free files in Task 1), so the two planes can never drift.

**Tech Stack:** TypeScript (ESM, `tsc`), Cloudflare Workers + KV + Secrets, GitHub App (Contents: Read & write), `node:test`. Dev-only deps: `typescript`, `wrangler`. **Zero runtime dependencies** — MCP Streamable HTTP is hand-rolled stateless JSON-RPC (our two tools are single synchronous calls; the MCP spec explicitly permits plain-JSON responses for stateless servers).

## Global Constraints

- **Tool contract identical to the stdio server** (`src/index.ts`): same tool names, descriptions, and argument names (`project`, `budget_tokens`, `type`, `payload`, `author`).
- **Entry format byte-compatible:** all serialization/parsing goes through `src/frontmatter.ts` — never reimplemented.
- **Isolation by construction:** no authenticated API surface accepts `owner`/`repo`/`space`/`installationId` parameters; they come only from the token's KV record. The gateway ignores the `write_context.author` argument and uses the token's bound identity (authenticated identity beats client-declared identity).
- **Tokens are never stored:** KV holds only `member:<sha256hex(token)>` → record. Minted tokens are shown once.
- **Workers free-plan limit: 50 subrequests/request** → `MAX_ENTRY_FETCH = 40` most-recent entry files per read.
- **Secrets** (App private key, App ID, admin secret) live only in Worker secrets — never in code, `wrangler.toml`, or git.
- **Gateway dev/test requires Node >= 20** (global `fetch` + WebCrypto). The shipped `dist/` of the main package is unaffected.
- Green bar after every task: `npm test && npm run lint && npm run format:check` at repo root, **plus** `cd gateway && npm test` from Task 2 on.
- Commit after every task.

## File Structure

- `src/slug.ts` (new) — `slug()` + `fsSafeTimestamp()` extracted from `store.ts` (dependency-free; shared traversal guard).
- `src/token-budget.ts` (modified) — gains `packToBudget()` (moved from `store.ts`).
- `src/context-format.ts` (modified) — type import from `frontmatter.js` instead of `store.js` (drops the transitive `node:*` graph).
- `src/store.ts` (modified) — imports the extracted helpers; behavior unchanged.
- `gateway/package.json`, `gateway/tsconfig.json`, `gateway/wrangler.toml` (new) — sub-package scaffold.
- `gateway/src/env.ts` — `Env` + minimal `KVStore` interface (keeps tests free of Workers types).
- `gateway/src/worker.ts` — Workers entry (`export default { fetch }`).
- `gateway/src/router.ts` — path routing only.
- `gateway/src/github-auth.ts` — App JWT (RS256 via WebCrypto) + cached installation tokens.
- `gateway/src/tenancy.ts` — token mint/resolve + admin member endpoint.
- `gateway/src/github-store.ts` — `readEntries`/`writeEntry` against the GitHub API.
- `gateway/src/mcp.ts` — stateless JSON-RPC MCP endpoint.
- `gateway/src/hook-read.ts` — `GET /hook/read` plain-text projection + KV cache.
- `gateway/test/helpers.mjs`, `gateway/test/*.test.mjs` — FakeKV, test keypair, mock GitHub fetch.
- `gateway/README.md` — deploy + onboarding runbook.

**Out of scope (follow-up plans):** client shims / `memorylayer init --remote` (Plan B); `memorylayer space create` onboarding CLI + CI wiring for the gateway package (Plan C). This plan ends with a deployed, curl-smoke-tested gateway that a stock MCP HTTP client can use.

---

### Task 1: Extract the shared pure core (main package)

Make `frontmatter.ts`, `context-format.ts`, `token-budget.ts`, and a new `slug.ts` a dependency-free island the gateway can compile in, without changing local behavior.

**Files:**
- Create: `src/slug.ts`
- Modify: `src/store.ts`, `src/token-budget.ts`, `src/context-format.ts`
- Test: `test/shared-core.test.mjs` (new)

**Interfaces:**
- Consumes: existing `slug`/`packToBudget` logic in `store.ts`.
- Produces: `slug(s: string): string` and `fsSafeTimestamp(iso: string): string` from `src/slug.ts`; `packToBudget(entries: ParsedEntry[], budgetTokens: number): ParsedEntry[]` exported from `src/token-budget.ts`. `src/store.ts` re-exports `slug` so existing importers/tests are untouched.

- [ ] **Step 1: Write the failing test**

Create `test/shared-core.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { slug, fsSafeTimestamp } from "../dist/slug.js";
import { packToBudget } from "../dist/token-budget.js";
import { slug as storeSlug } from "../dist/store.js";

test("slug module: traversal guard and store re-export stay identical", () => {
  assert.equal(slug("../../etc"), "etc");
  assert.equal(slug("My Project!"), "my-project");
  assert.equal(slug(""), "unknown");
  assert.equal(storeSlug, slug); // same function object, one source of truth
});

test("fsSafeTimestamp strips colons and dots", () => {
  assert.equal(
    fsSafeTimestamp("2026-07-05T06:11:22.854Z"),
    "2026-07-05T06-11-22-854Z",
  );
});

function entry(payload, file) {
  return { author: "a", type: "context", timestamp: "t", id: "i", payload, file };
}

test("packToBudget keeps newest entries within budget, oldest dropped first", () => {
  const entries = [entry("x".repeat(400), "1"), entry("y".repeat(400), "2"), entry("z".repeat(400), "3")];
  // each entry ~100 tokens + 12 overhead; budget 240 fits two
  const out = packToBudget(entries, 240);
  assert.deepEqual(out.map((e) => e.file), ["2", "3"]);
});

test("packToBudget always keeps at least the most recent entry", () => {
  const out = packToBudget([entry("x".repeat(4000), "big")], 10);
  assert.equal(out.length, 1);
});

test("packToBudget budget <= 0 means unlimited", () => {
  const entries = [entry("a", "1"), entry("b", "2")];
  assert.equal(packToBudget(entries, 0).length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/shared-core.test.mjs`
Expected: FAIL — `Cannot find module '../dist/slug.js'`.

- [ ] **Step 3: Create `src/slug.ts`**

```ts
/**
 * Collapse arbitrary text to a filesystem-safe slug. Also the path-traversal
 * guard: stripping every non-alphanumeric run means "../../etc" -> "etc", so a
 * hostile project/author name can never escape the context/ directory.
 *
 * Lives in its own dependency-free module so the hosted gateway (Web APIs
 * only, no node:*) shares the exact same guard as the local store.
 */
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

/** ISO timestamp -> filename-safe form (colons/dots to dashes). */
export function fsSafeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}
```

- [ ] **Step 4: Move `packToBudget` into `src/token-budget.ts`**

Append to `src/token-budget.ts`:

```ts
import type { ParsedEntry } from "./frontmatter.js";

/**
 * Select the most recent entries that fit `budgetTokens`, walking newest to
 * oldest. Always keeps at least the single most recent entry — an oversized
 * entry beats an empty read. `budgetTokens <= 0` means unlimited (returns
 * every entry), preserving the old count-cap's `limit <= 0` escape hatch.
 */
export function packToBudget(
  entries: ParsedEntry[],
  budgetTokens: number,
): ParsedEntry[] {
  if (budgetTokens <= 0 || entries.length === 0) return entries;

  const selected: ParsedEntry[] = [];
  let used = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const cost = estimateTokens(entries[i].payload) + ENTRY_OVERHEAD_TOKENS;
    if (selected.length > 0 && used + cost > budgetTokens) break;
    selected.push(entries[i]);
    used += cost;
  }
  return selected.reverse();
}
```

- [ ] **Step 5: Rewire `src/store.ts`**

In `src/store.ts`:
1. Delete the local `slug` function (lines defining `export function slug`) and the local `fsSafeTimestamp` and `packToBudget` functions.
2. Add imports and a re-export near the top (after the existing imports):

```ts
import { slug, fsSafeTimestamp } from "./slug.js";
// Re-exported so existing importers (init, metrics, tests) keep working.
export { slug } from "./slug.js";
```

3. Extend the token-budget import to include the moved function:

```ts
import {
  estimateTokens,
  DEFAULT_BUDGET_TOKENS,
  ENTRY_OVERHEAD_TOKENS,
  packToBudget,
} from "./token-budget.js";
```

(`estimateTokens`/`ENTRY_OVERHEAD_TOKENS` remain imported only if still referenced; if `packToBudget` was their last user in `store.ts`, drop them from the import.)

- [ ] **Step 6: Point `src/context-format.ts` at the pure type source**

Change line 1 of `src/context-format.ts` from:

```ts
import type { ParsedEntry } from "./store.js";
```

to:

```ts
import type { ParsedEntry } from "./frontmatter.js";
```

- [ ] **Step 7: Run tests to verify everything passes**

Run: `npm test && npm run lint && npm run format:check`
Expected: all green — the full existing suite (106 tests) plus the new `shared-core` tests. Any failure here means an importer of `slug`/`packToBudget` was missed; fix before proceeding.

- [ ] **Step 8: Commit**

```bash
git add src/slug.ts src/token-budget.ts src/context-format.ts src/store.ts test/shared-core.test.mjs
git commit -m "refactor: extract dependency-free shared core (slug, packToBudget) for gateway reuse

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Gateway scaffold — sub-package, router, health endpoint

**Files:**
- Create: `gateway/package.json`, `gateway/tsconfig.json`, `gateway/.gitignore`, `gateway/src/env.ts`, `gateway/src/router.ts`, `gateway/src/worker.ts`
- Test: `gateway/test/router.test.mjs`, `gateway/test/helpers.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks yet (Task 1 modules join the compile in Task 5).
- Produces: `handleRequest(req: Request, env: Env): Promise<Response>` (router.ts); `Env { ROUTING: KVStore; GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: string; ADMIN_SECRET: string; githubFetch?: typeof fetch }` and `KVStore { get; put; delete }` (env.ts); `FakeKV` and `makeEnv()` test helpers.

- [ ] **Step 1: Write the failing test**

Create `gateway/test/helpers.mjs`:

```js
/** In-memory KVStore implementing exactly the surface gateway code uses. */
export class FakeKV {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value, _opts) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
}

/** A 2048-bit RSA test keypair, PKCS#8 PEM + public key for verification. */
async function genKeypair() {
  const kp = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const b64 = Buffer.from(der).toString("base64").replace(/(.{64})/g, "$1\n");
  return {
    pem: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
    publicKey: kp.publicKey,
  };
}

export const TEST_KEYPAIR = await genKeypair();

/** Env with a FakeKV and the test keypair; pass a mock fetch for GitHub calls. */
export function makeEnv(githubFetch) {
  return {
    ROUTING: new FakeKV(),
    GITHUB_APP_ID: "12345",
    GITHUB_APP_PRIVATE_KEY: TEST_KEYPAIR.pem,
    ADMIN_SECRET: "test-admin-secret",
    githubFetch,
  };
}

/** Mock fetch: records calls, answers by first matching URL substring. */
export function ghFetch(calls, routes) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [pattern, respond] of routes) {
      if (String(url).includes(pattern)) return respond(String(url), init);
    }
    return new Response(JSON.stringify({ message: "no mock route" }), { status: 404 });
  };
}
```

Create `gateway/test/router.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import { makeEnv } from "./helpers.mjs";

test("GET /health returns ok json", async () => {
  const res = await handleRequest(new Request("https://gw.test/health"), makeEnv());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("unknown path returns 404", async () => {
  const res = await handleRequest(new Request("https://gw.test/nope"), makeEnv());
  assert.equal(res.status, 404);
});
```

- [ ] **Step 2: Create the sub-package config**

`gateway/package.json`:

```json
{
  "name": "memorylayer-gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "npm run build && node --test test/",
    "deploy": "npm run build && wrangler deploy"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "wrangler": "^4.0.0"
  }
}
```

`gateway/tsconfig.json` (rootDir `..` so imports of `../src/*` compile into a mirrored layout — `dist/gateway/src/*` next to `dist/src/*` — and relative import paths hold in both source and output):

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "lib": ["es2022", "dom"],
    "types": [],
    "rootDir": "..",
    "outDir": "dist",
    "strict": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": [
    "src/**/*.ts",
    "../src/slug.ts",
    "../src/frontmatter.ts",
    "../src/context-format.ts",
    "../src/token-budget.ts"
  ]
}
```

`gateway/.gitignore`:

```
dist/
node_modules/
.wrangler/
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd gateway && npm install && npm test`
Expected: FAIL — `Cannot find module '../dist/gateway/src/router.js'`.

- [ ] **Step 4: Implement env, router, worker entry**

`gateway/src/env.ts`:

```ts
/**
 * Minimal KV surface the gateway uses. Structural match for a Workers
 * KVNamespace binding, but defined locally so handlers stay testable under
 * node:test with an in-memory fake and no Workers type dependency.
 */
export interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Env {
  ROUTING: KVStore;
  GITHUB_APP_ID: string;
  /** PKCS#8 PEM. GitHub downloads PKCS#1 — convert before `wrangler secret put`. */
  GITHUB_APP_PRIVATE_KEY: string;
  ADMIN_SECRET: string;
  /** Test seam: injected GitHub fetch. Production leaves it unset. */
  githubFetch?: typeof fetch;
}
```

`gateway/src/router.ts`:

```ts
import type { Env } from "./env.js";

/** Path routing only — each route's logic lives in its own module. */
export async function handleRequest(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);

  if (url.pathname === "/health" && req.method === "GET") {
    return Response.json({ ok: true });
  }

  return new Response("not found", { status: 404 });
}
```

`gateway/src/worker.ts`:

```ts
import { handleRequest } from "./router.js";
import type { Env } from "./env.js";

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handleRequest(req, env);
  },
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd gateway && npm test`
Expected: PASS (2 tests).

- [ ] **Step 6: Root green bar, then commit**

Run at repo root: `npm test && npm run lint && npm run format:check`
Expected: green (gateway is a separate compile; root untouched).

```bash
git add gateway/package.json gateway/tsconfig.json gateway/.gitignore gateway/src gateway/test
git commit -m "feat(gateway): scaffold Workers sub-package with testable router

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: GitHub App auth — RS256 JWT + cached installation tokens

**Files:**
- Create: `gateway/src/github-auth.ts`
- Test: `gateway/test/github-auth.test.mjs`

**Interfaces:**
- Consumes: `Env`, `KVStore` (env.ts).
- Produces: `b64url(data: ArrayBuffer | Uint8Array | string): string`; `appJwt(appId: string, privateKeyPem: string, nowSec?: number): Promise<string>`; `installationToken(env: Env, installationId: number, fetchImpl?: typeof fetch): Promise<string>` — KV-cached 45 min under `ghtok:<installationId>` (App tokens live 60).

- [ ] **Step 1: Write the failing test**

Create `gateway/test/github-auth.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { appJwt, installationToken, b64url } from "../dist/gateway/src/github-auth.js";
import { makeEnv, ghFetch, TEST_KEYPAIR } from "./helpers.mjs";

function decodeSegment(seg) {
  return JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());
}

test("appJwt produces a verifiable RS256 JWT with iss/iat/exp", async () => {
  const now = 1_800_000_000;
  const jwt = await appJwt("12345", TEST_KEYPAIR.pem, now);
  const [h, p, s] = jwt.split(".");
  assert.deepEqual(decodeSegment(h), { alg: "RS256", typ: "JWT" });
  assert.deepEqual(decodeSegment(p), { iat: now - 60, exp: now + 600, iss: "12345" });
  const sig = Uint8Array.from(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    TEST_KEYPAIR.publicKey,
    sig,
    new TextEncoder().encode(`${h}.${p}`),
  );
  assert.equal(ok, true);
});

test("b64url is unpadded and url-safe", () => {
  assert.equal(b64url("ab?~"), Buffer.from("ab?~").toString("base64url"));
});

test("installationToken exchanges JWT once, then serves from KV cache", async () => {
  const calls = [];
  const fetchImpl = ghFetch(calls, [
    [
      "/app/installations/777/access_tokens",
      () => Response.json({ token: "ghs_test_token" }, { status: 201 }),
    ],
  ]);
  const env = makeEnv(fetchImpl);
  assert.equal(await installationToken(env, 777, fetchImpl), "ghs_test_token");
  assert.equal(await installationToken(env, 777, fetchImpl), "ghs_test_token");
  assert.equal(calls.length, 1); // second hit came from KV
  assert.match(calls[0].init.headers.authorization, /^Bearer eyJ/);
  assert.equal(calls[0].init.method, "POST");
});

test("installationToken throws on non-2xx", async () => {
  const fetchImpl = ghFetch([], [["/access_tokens", () => new Response("nope", { status: 401 })]]);
  await assert.rejects(() => installationToken(makeEnv(fetchImpl), 1, fetchImpl), /401/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npm test`
Expected: FAIL — `Cannot find module '../dist/gateway/src/github-auth.js'`.

- [ ] **Step 3: Implement `gateway/src/github-auth.ts`**

```ts
import type { Env } from "./env.js";

const enc = new TextEncoder();

/** Base64url (unpadded) over a string or bytes. */
export function b64url(data: ArrayBuffer | Uint8Array | string): string {
  const bytes =
    typeof data === "string"
      ? enc.encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * GitHub App JWT: RS256, 10-minute lifetime, iat backdated 60s for clock
 * drift (both per GitHub's App auth docs). Requires a PKCS#8 PEM — GitHub's
 * downloaded key is PKCS#1; the deploy runbook converts it via openssl.
 */
export async function appJwt(
  appId: string,
  privateKeyPem: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): Promise<string> {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64url(
    JSON.stringify({ iat: nowSec - 60, exp: nowSec + 600, iss: appId }),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(privateKeyPem),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    enc.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(sig)}`;
}

/**
 * Mint (or serve cached) a per-installation access token — the ONLY GitHub
 * credential the storage layer ever sees, scoped by GitHub itself to the one
 * repo the App is installed on. Cached 45 min (tokens live 60).
 */
export async function installationToken(
  env: Env,
  installationId: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const cacheKey = `ghtok:${installationId}`;
  const cached = await env.ROUTING.get(cacheKey);
  if (cached) return cached;

  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
  const res = await fetchImpl(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "user-agent": "memorylayer-gateway",
      },
    },
  );
  if (!res.ok) {
    throw new Error(`installation token exchange failed: ${res.status}`);
  }
  const body = (await res.json()) as { token: string };
  await env.ROUTING.put(cacheKey, body.token, { expirationTtl: 45 * 60 });
  return body.token;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add gateway/src/github-auth.ts gateway/test/github-auth.test.mjs
git commit -m "feat(gateway): GitHub App JWT + cached per-installation tokens

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Tenancy — member tokens, KV records, admin endpoint

**Files:**
- Create: `gateway/src/tenancy.ts`
- Modify: `gateway/src/router.ts`
- Test: `gateway/test/tenancy.test.mjs`

**Interfaces:**
- Consumes: `Env`/`KVStore` (env.ts), `b64url` (github-auth.ts).
- Produces: `interface SpaceMember { space: string; installationId: number; owner: string; repo: string; branch: string; author: string; authorEmail: string }`; `sha256Hex(s: string): Promise<string>`; `newToken(): string` (`mlk_`-prefixed, 32 random bytes); `resolveMember(req: Request, env: Env): Promise<SpaceMember | null>`; `handleAdminAddMember(req: Request, env: Env): Promise<Response>` routed at `POST /admin/members`.

- [ ] **Step 1: Write the failing test**

Create `gateway/test/tenancy.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import { resolveMember, newToken } from "../dist/gateway/src/tenancy.js";
import { makeEnv } from "./helpers.mjs";

const MEMBER = {
  space: "team-a",
  installationId: 777,
  owner: "acme",
  repo: "team-a-memory",
  author: "Ada",
  authorEmail: "ada@acme.io",
};

async function addMember(env, body = MEMBER, secret = "test-admin-secret") {
  return handleRequest(
    new Request("https://gw.test/admin/members", {
      method: "POST",
      headers: { "x-admin-secret": secret, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

test("admin mint: returns a token once; token resolves to the member; branch defaults to main", async () => {
  const env = makeEnv();
  const res = await addMember(env);
  assert.equal(res.status, 200);
  const { token, member } = await res.json();
  assert.match(token, /^mlk_/);
  assert.equal(member.branch, "main");

  const resolved = await resolveMember(
    new Request("https://gw.test/mcp", { headers: { authorization: `Bearer ${token}` } }),
    env,
  );
  assert.equal(resolved.space, "team-a");
  assert.equal(resolved.author, "Ada");

  // the raw token never lands in KV — only its hash key exists
  for (const key of env.ROUTING.map.keys()) {
    assert.ok(!key.includes(token), "raw token must not appear in any KV key");
  }
});

test("admin mint rejects a wrong secret and missing fields", async () => {
  const env = makeEnv();
  assert.equal((await addMember(env, MEMBER, "wrong")).status, 403);
  const { space: _drop, ...incomplete } = MEMBER;
  assert.equal((await addMember(env, incomplete)).status, 400);
});

test("resolveMember: absent/garbage/unknown bearer all resolve to null", async () => {
  const env = makeEnv();
  const mk = (headers) => new Request("https://gw.test/mcp", { headers });
  assert.equal(await resolveMember(mk({}), env), null);
  assert.equal(await resolveMember(mk({ authorization: "Basic abc" }), env), null);
  assert.equal(await resolveMember(mk({ authorization: `Bearer ${newToken()}` }), env), null);
});

test("two members in different spaces resolve to their own records", async () => {
  const env = makeEnv();
  const a = await (await addMember(env)).json();
  const b = await (
    await addMember(env, { ...MEMBER, space: "team-b", owner: "acme", repo: "team-b-memory", installationId: 888, author: "Bo" })
  ).json();
  const resolve = async (tok) =>
    resolveMember(new Request("https://gw.test/mcp", { headers: { authorization: `Bearer ${tok}` } }), env);
  assert.equal((await resolve(a.token)).repo, "team-a-memory");
  assert.equal((await resolve(b.token)).repo, "team-b-memory");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npm test`
Expected: FAIL — `Cannot find module '../dist/gateway/src/tenancy.js'`.

- [ ] **Step 3: Implement `gateway/src/tenancy.ts`**

```ts
import type { Env } from "./env.js";
import { b64url } from "./github-auth.js";

/**
 * One KV record per member token. `owner`/`repo`/`installationId` bind the
 * token to exactly one space's repo — tool calls carry no space parameters,
 * so a routing bug cannot cross tenants: the credential itself can't.
 */
export interface SpaceMember {
  space: string;
  installationId: number;
  owner: string;
  repo: string;
  branch: string;
  author: string;
  authorEmail: string;
}

export async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 32 random bytes, url-safe, prefixed so tokens are grep-able in configs. */
export function newToken(): string {
  return "mlk_" + b64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** Bearer token -> member record, or null. KV stores only the token's hash. */
export async function resolveMember(req: Request, env: Env): Promise<SpaceMember | null> {
  const auth = req.headers.get("authorization") ?? "";
  const match = auth.match(/^Bearer (.+)$/i);
  if (!match) return null;
  const record = await env.ROUTING.get(`member:${await sha256Hex(match[1])}`);
  return record ? (JSON.parse(record) as SpaceMember) : null;
}

const REQUIRED: (keyof SpaceMember)[] = [
  "space",
  "installationId",
  "owner",
  "repo",
  "author",
  "authorEmail",
];

/**
 * POST /admin/members — mint a member token for a space. Pilot-scale
 * provisioning: guarded by the ADMIN_SECRET Worker secret; the CLI onboarding
 * flow (Plan C) wraps this endpoint. Returns the raw token exactly once.
 */
export async function handleAdminAddMember(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("x-admin-secret") !== env.ADMIN_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  let body: Partial<SpaceMember>;
  try {
    body = (await req.json()) as Partial<SpaceMember>;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  for (const key of REQUIRED) {
    if (body[key] === undefined || body[key] === "") {
      return Response.json({ error: `missing ${key}` }, { status: 400 });
    }
  }
  const member: SpaceMember = { branch: "main", ...(body as SpaceMember) };
  const token = newToken();
  await env.ROUTING.put(`member:${await sha256Hex(token)}`, JSON.stringify(member));
  return Response.json({ token, member });
}
```

- [ ] **Step 4: Route it**

In `gateway/src/router.ts`, add the import and route:

```ts
import { handleAdminAddMember } from "./tenancy.js";
```

and inside `handleRequest`, after the `/health` block:

```ts
  if (url.pathname === "/admin/members" && req.method === "POST") {
    return handleAdminAddMember(req, env);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd gateway && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/tenancy.ts gateway/src/router.ts gateway/test/tenancy.test.mjs
git commit -m "feat(gateway): tenant member tokens (hash-only KV) + admin mint endpoint

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: GitHub storage plane — `readEntries` / `writeEntry`

**Files:**
- Create: `gateway/src/github-store.ts`
- Test: `gateway/test/github-store.test.mjs`

**Interfaces:**
- Consumes: `serializeEntry`/`parseEntry`/`ParsedEntry`/`EntryType` (`../../src/frontmatter.js`), `packToBudget`/`DEFAULT_BUDGET_TOKENS` (`../../src/token-budget.js`), `slug`/`fsSafeTimestamp` (`../../src/slug.js`), `installationToken` (github-auth.ts), `SpaceMember` (tenancy.ts).
- Produces: `writeEntry(env, member, project: string, entry: { type: EntryType; payload: string }, fetchImpl?): Promise<ParsedEntry>`; `readEntries(env, member, project: string, budgetTokens?: number, fetchImpl?): Promise<{ entries: ParsedEntry[]; total: number }>`; `MAX_ENTRY_FETCH = 40`.

- [ ] **Step 1: Write the failing test**

Create `gateway/test/github-store.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeEntry, readEntries, MAX_ENTRY_FETCH } from "../dist/gateway/src/github-store.js";
import { parseEntry } from "../dist/src/frontmatter.js";
import { makeEnv, ghFetch } from "./helpers.mjs";

const MEMBER = {
  space: "team-a",
  installationId: 777,
  owner: "acme",
  repo: "team-a-memory",
  branch: "main",
  author: "Ada",
  authorEmail: "ada@acme.io",
};

const TOKEN_ROUTE = [
  "/app/installations/777/access_tokens",
  () => Response.json({ token: "ghs_x" }, { status: 201 }),
];

function entryMd(ts, author, payload) {
  return `---\nauthor: ${author}\ntype: context\ntimestamp: ${ts}\nid: abcd1234\nproject: roadmap\n---\n\n${payload}\n`;
}

test("writeEntry PUTs a byte-compatible entry to the member repo", async () => {
  const calls = [];
  const fetchImpl = ghFetch(calls, [
    TOKEN_ROUTE,
    ["/contents/", (url, init) => Response.json({ ok: true }, { status: 201 })],
  ]);
  const out = await writeEntry(makeEnv(fetchImpl), MEMBER, "Road Map!", {
    type: "decision",
    payload: "We decided X because Y.\nSecond line.",
  });

  const put = calls.find((c) => c.init.method === "PUT");
  assert.match(put.url, /^https:\/\/api\.github\.com\/repos\/acme\/team-a-memory\/contents\/context\/road-map\/ada\//);
  const body = JSON.parse(put.init.body);
  assert.equal(body.branch, "main");
  assert.equal(body.message.startsWith("decision(road-map): We decided X because Y."), true);
  assert.deepEqual(body.author, { name: "Ada", email: "ada@acme.io" });

  // THE interop guarantee: content round-trips through the local parser
  const content = Buffer.from(body.content, "base64").toString("utf8");
  const parsed = parseEntry(content, out.file);
  assert.equal(parsed.author, "Ada");
  assert.equal(parsed.type, "decision");
  assert.equal(parsed.payload, "We decided X because Y.\nSecond line.");
  assert.equal(parsed.timestamp, out.timestamp);
});

test("readEntries: tree + raw fetch, sorted by timestamp, budget-packed, total preserved", async () => {
  const tree = {
    tree: [
      { path: "context/roadmap/ada/2026-07-01T10-00-00-000Z-aaaaaaaa.md", type: "blob" },
      { path: "context/roadmap/bo/2026-07-02T10-00-00-000Z-bbbbbbbb.md", type: "blob" },
      { path: "context/other-project/ada/2026-07-03T10-00-00-000Z-cccccccc.md", type: "blob" },
      { path: "context/roadmap/ada/not-markdown.txt", type: "blob" },
    ],
  };
  const fetchImpl = ghFetch([], [
    TOKEN_ROUTE,
    ["/git/trees/main?recursive=1", () => Response.json(tree)],
    ["2026-07-01T10-00-00-000Z-aaaaaaaa.md", () => new Response(entryMd("2026-07-01T10:00:00.000Z", "Ada", "first"))],
    ["2026-07-02T10-00-00-000Z-bbbbbbbb.md", () => new Response(entryMd("2026-07-02T10:00:00.000Z", "Bo", "second"))],
  ]);
  const { entries, total } = await readEntries(makeEnv(fetchImpl), MEMBER, "roadmap");
  assert.equal(total, 2); // other-project and .txt excluded
  assert.deepEqual(entries.map((e) => e.payload), ["first", "second"]);
});

test("readEntries caps blob fetches at MAX_ENTRY_FETCH newest files, total stays full", async () => {
  const files = [];
  const routes = [TOKEN_ROUTE, ["/git/trees/", null]];
  const blobRoutes = [];
  for (let i = 0; i < 60; i++) {
    const day = String(i + 1).padStart(2, "0");
    const p = `context/roadmap/ada/2026-06-${day}T00-00-00-000Z-${String(i).padStart(8, "0")}.md`;
    files.push({ path: p, type: "blob" });
    blobRoutes.push([p, () => new Response(entryMd(`2026-06-${day}T00:00:00.000Z`, "Ada", `e${i}`))]);
  }
  const calls = [];
  const fetchImpl = ghFetch(calls, [
    TOKEN_ROUTE,
    ["/git/trees/", () => Response.json({ tree: files })],
    ...blobRoutes,
  ]);
  const { entries, total } = await readEntries(makeEnv(fetchImpl), MEMBER, "roadmap", 0);
  assert.equal(total, 60);
  assert.equal(entries.length, MAX_ENTRY_FETCH); // newest 40 fetched (budget 0 = unlimited packing)
  assert.equal(entries[entries.length - 1].payload, "e59");
  const blobCalls = calls.filter((c) => c.url.includes(".md"));
  assert.equal(blobCalls.length, MAX_ENTRY_FETCH);
});

test("readEntries returns empty on 404/409 tree (empty repo or missing branch)", async () => {
  const fetchImpl = ghFetch([], [TOKEN_ROUTE, ["/git/trees/", () => new Response("", { status: 409 })]]);
  assert.deepEqual(await readEntries(makeEnv(fetchImpl), MEMBER, "roadmap"), { entries: [], total: 0 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npm test`
Expected: FAIL — `Cannot find module '../dist/gateway/src/github-store.js'`.

- [ ] **Step 3: Implement `gateway/src/github-store.ts`**

```ts
import {
  serializeEntry,
  parseEntry,
  type ParsedEntry,
  type EntryType,
} from "../../src/frontmatter.js";
import { packToBudget, DEFAULT_BUDGET_TOKENS } from "../../src/token-budget.js";
import { slug, fsSafeTimestamp } from "../../src/slug.js";
import { installationToken } from "./github-auth.js";
import type { Env } from "./env.js";
import type { SpaceMember } from "./tenancy.js";

const GH = "https://api.github.com";
/** Workers free plan allows 50 subrequests/request: 1 token + 1 tree + N blobs. */
export const MAX_ENTRY_FETCH = 40;
const COMMIT_SUBJECT_MAX = 72;

function ghHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "memorylayer-gateway",
    "x-github-api-version": "2022-11-28",
  };
}

function b64encodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/**
 * Append one entry as its own file via the Contents API (single call = blob +
 * tree + commit + ref update). Same path scheme and serialized bytes as the
 * local store, so local clones of the space repo read gateway entries and
 * vice versa. Timestamp is gateway server time — hosted writes are immune to
 * client clock skew by construction.
 */
export async function writeEntry(
  env: Env,
  member: SpaceMember,
  project: string,
  entry: { type: EntryType; payload: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ParsedEntry> {
  const token = await installationToken(env, member.installationId, fetchImpl);
  const timestamp = new Date().toISOString();
  const id = crypto.randomUUID().slice(0, 8);
  const file = `context/${slug(project)}/${slug(member.author)}/${fsSafeTimestamp(timestamp)}-${id}.md`;
  const contents = serializeEntry(
    { author: member.author, type: entry.type, timestamp, id, project },
    entry.payload,
  );
  const subject = entry.payload.trim().split("\n")[0].slice(0, COMMIT_SUBJECT_MAX);

  const res = await fetchImpl(`${GH}/repos/${member.owner}/${member.repo}/contents/${file}`, {
    method: "PUT",
    headers: ghHeaders(token),
    body: JSON.stringify({
      message: `${entry.type}(${slug(project)}): ${subject}`,
      branch: member.branch,
      content: b64encodeUtf8(contents),
      committer: { name: member.author, email: member.authorEmail },
      author: { name: member.author, email: member.authorEmail },
    }),
  });
  if (!res.ok) {
    throw new Error(`write failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return {
    author: member.author,
    type: entry.type,
    timestamp,
    id,
    payload: entry.payload.trim(),
    file,
  };
}

/**
 * List the project's entries via one recursive Trees call, fetch only the
 * MAX_ENTRY_FETCH newest files (filenames start with the fs-safe ISO
 * timestamp, so lexicographic basename order IS recency order), and pack to
 * the token budget. `total` reflects every entry in the tree, matching the
 * local read contract. Ordering falls back to frontmatter timestamps —
 * gateway-written entries carry server-clock timestamps, so hosted spaces are
 * skew-free; mixed local writes use the same fallback the local comparator has.
 */
export async function readEntries(
  env: Env,
  member: SpaceMember,
  project: string,
  budgetTokens: number = DEFAULT_BUDGET_TOKENS,
  fetchImpl: typeof fetch = fetch,
): Promise<{ entries: ParsedEntry[]; total: number }> {
  const token = await installationToken(env, member.installationId, fetchImpl);
  const prefix = `context/${slug(project)}/`;

  const treeRes = await fetchImpl(
    `${GH}/repos/${member.owner}/${member.repo}/git/trees/${member.branch}?recursive=1`,
    { headers: ghHeaders(token) },
  );
  if (treeRes.status === 404 || treeRes.status === 409) return { entries: [], total: 0 };
  if (!treeRes.ok) throw new Error(`tree read failed: ${treeRes.status}`);
  const tree = (await treeRes.json()) as { tree: { path: string; type: string }[] };

  const paths = tree.tree
    .filter((t) => t.type === "blob" && t.path.startsWith(prefix) && t.path.endsWith(".md"))
    .map((t) => t.path)
    .sort((a, b) => basename(a).localeCompare(basename(b)));

  const total = paths.length;
  const recent = paths.slice(-MAX_ENTRY_FETCH);

  const entries: ParsedEntry[] = [];
  for (const p of recent) {
    const res = await fetchImpl(
      `${GH}/repos/${member.owner}/${member.repo}/contents/${p}?ref=${member.branch}`,
      { headers: { ...ghHeaders(token), accept: "application/vnd.github.raw+json" } },
    );
    if (!res.ok) continue; // fail-open per entry, matching the local parser's tolerance
    const parsed = parseEntry(await res.text(), p);
    if (parsed) entries.push(parsed);
  }

  entries.sort((a, b) =>
    a.timestamp === b.timestamp
      ? a.file.localeCompare(b.file)
      : a.timestamp.localeCompare(b.timestamp),
  );
  return { entries: packToBudget(entries, budgetTokens), total };
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gateway && npm test`
Expected: PASS (including the byte-compat round-trip through `dist/src/frontmatter.js`).

- [ ] **Step 5: Commit**

```bash
git add gateway/src/github-store.ts gateway/test/github-store.test.mjs
git commit -m "feat(gateway): GitHub API storage plane, byte-compatible with local store

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: MCP endpoint — stateless Streamable HTTP JSON-RPC

**Files:**
- Create: `gateway/src/mcp.ts`
- Modify: `gateway/src/router.ts`
- Test: `gateway/test/mcp.test.mjs`

**Interfaces:**
- Consumes: `resolveMember` (tenancy.ts), `readEntries`/`writeEntry` (github-store.ts), `projectContext` (`../../src/context-format.js`), `slug` (`../../src/slug.js`), `DEFAULT_BUDGET_TOKENS` (`../../src/token-budget.js`).
- Produces: `handleMcp(req: Request, env: Env): Promise<Response>` routed at `POST /mcp` (`GET /mcp` → 405: stateless server, no SSE stream). Also exports `hookCacheKey(space: string, project: string): string` shared with Task 7's cache invalidation.

- [ ] **Step 1: Write the failing test**

Create `gateway/test/mcp.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import { makeEnv, ghFetch } from "./helpers.mjs";

const MEMBER_A = { space: "team-a", installationId: 777, owner: "acme", repo: "team-a-memory", author: "Ada", authorEmail: "ada@acme.io" };
const MEMBER_B = { space: "team-b", installationId: 888, owner: "acme", repo: "team-b-memory", author: "Bo", authorEmail: "bo@acme.io" };

async function setup(routes) {
  const calls = [];
  const env = makeEnv(ghFetch(calls, routes));
  const tokens = {};
  for (const m of [MEMBER_A, MEMBER_B]) {
    const res = await handleRequest(
      new Request("https://gw.test/admin/members", {
        method: "POST",
        headers: { "x-admin-secret": "test-admin-secret" },
        body: JSON.stringify(m),
      }),
      env,
    );
    tokens[m.space] = (await res.json()).token;
  }
  return { env, calls, tokens };
}

function rpc(token, body) {
  return new Request("https://gw.test/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const TOKEN_ROUTES = [
  ["/app/installations/777/access_tokens", () => Response.json({ token: "ghs_a" }, { status: 201 })],
  ["/app/installations/888/access_tokens", () => Response.json({ token: "ghs_b" }, { status: 201 })],
];

test("unauthenticated POST /mcp is 401; GET /mcp is 405", async () => {
  const { env } = await setup(TOKEN_ROUTES);
  const post = await handleRequest(new Request("https://gw.test/mcp", { method: "POST", body: "{}" }), env);
  assert.equal(post.status, 401);
  const get = await handleRequest(new Request("https://gw.test/mcp"), env);
  assert.equal(get.status, 405);
});

test("initialize and tools/list expose the stdio-identical contract", async () => {
  const { env, tokens } = await setup(TOKEN_ROUTES);
  const init = await handleRequest(rpc(tokens["team-a"], { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }), env);
  const initBody = await init.json();
  assert.equal(initBody.result.serverInfo.name, "memorylayer");
  assert.ok(initBody.result.capabilities.tools);

  const list = await handleRequest(rpc(tokens["team-a"], { jsonrpc: "2.0", id: 2, method: "tools/list" }), env);
  const names = (await list.json()).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["read_context", "write_context"]);
});

test("tools/call write_context writes to the member repo and reports like stdio", async () => {
  const { env, tokens, calls } = await setup([
    ...TOKEN_ROUTES,
    ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
  ]);
  const res = await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "write_context", arguments: { project: "roadmap", type: "decision", payload: "We decided X because Y.", author: "Mallory" } },
    }),
    env,
  );
  const body = await res.json();
  assert.equal(body.result.isError, undefined);
  assert.match(body.result.content[0].text, /^Recorded decision in 'roadmap' as Ada at /);
  // author argument is IGNORED: authenticated identity wins over client-declared
  const put = calls.find((c) => c.init.method === "PUT");
  assert.match(put.url, /team-a-memory/);
  assert.match(Buffer.from(JSON.parse(put.init.body).content, "base64").toString(), /author: Ada/);
});

test("tools/call read_context renders the shared projection", async () => {
  const md = "---\nauthor: Ada\ntype: decision\ntimestamp: 2026-07-01T00:00:00.000Z\nid: x1\nproject: roadmap\n---\n\nships";
  const { env, tokens } = await setup([
    ...TOKEN_ROUTES,
    ["/git/trees/", () => Response.json({ tree: [{ path: "context/roadmap/ada/2026-07-01T00-00-00-000Z-x1.md", type: "blob" }] })],
    ["x1.md", () => new Response(md)],
  ]);
  const res = await handleRequest(
    rpc(tokens["team-a"], { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "read_context", arguments: { project: "roadmap" } } }),
    env,
  );
  const text = (await res.json()).result.content[0].text;
  assert.match(text, /# Shared context: roadmap/);
  assert.match(text, /decision — Ada — 2026-07-01T00:00:00\.000Z/);
});

test("ISOLATION: team-a token only ever touches team-a's repo", async () => {
  const { env, tokens, calls } = await setup([
    ...TOKEN_ROUTES,
    ["/git/trees/", () => Response.json({ tree: [] })],
    ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
  ]);
  await handleRequest(rpc(tokens["team-a"], { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "read_context", arguments: { project: "roadmap" } } }), env);
  await handleRequest(rpc(tokens["team-a"], { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "write_context", arguments: { project: "roadmap", type: "context", payload: "p" } } }), env);
  const repoCalls = calls.filter((c) => c.url.includes("/repos/"));
  assert.ok(repoCalls.length >= 2);
  for (const c of repoCalls) {
    assert.match(c.url, /\/repos\/acme\/team-a-memory\//);
    assert.doesNotMatch(c.url, /team-b-memory/);
  }
});

test("storage failure surfaces as an MCP tool error, not a crash", async () => {
  const { env, tokens } = await setup([
    ...TOKEN_ROUTES,
    ["/contents/", () => new Response("boom", { status: 500 })],
  ]);
  const res = await handleRequest(
    rpc(tokens["team-a"], { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "write_context", arguments: { project: "r", type: "context", payload: "p" } } }),
    env,
  );
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /write failed: 500/);
});

test("unknown method -> -32601; parse error -> -32700; batch -> -32600", async () => {
  const { env, tokens } = await setup(TOKEN_ROUTES);
  const unknown = await handleRequest(rpc(tokens["team-a"], { jsonrpc: "2.0", id: 8, method: "resources/list" }), env);
  assert.equal((await unknown.json()).error.code, -32601);
  const bad = await handleRequest(
    new Request("https://gw.test/mcp", { method: "POST", headers: { authorization: `Bearer ${tokens["team-a"]}` }, body: "{nope" }),
    env,
  );
  assert.equal((await bad.json()).error.code, -32700);
  const batch = await handleRequest(rpc(tokens["team-a"], [{ jsonrpc: "2.0", id: 9, method: "ping" }]), env);
  assert.equal((await batch.json()).error.code, -32600);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npm test`
Expected: FAIL — router has no `/mcp` route yet (`404` instead of `401`/`405`).

- [ ] **Step 3: Implement `gateway/src/mcp.ts`**

```ts
import type { Env } from "./env.js";
import { resolveMember, type SpaceMember } from "./tenancy.js";
import { readEntries, writeEntry } from "./github-store.js";
import { projectContext } from "../../src/context-format.js";
import { slug } from "../../src/slug.js";
import { DEFAULT_BUDGET_TOKENS } from "../../src/token-budget.js";
import type { EntryType } from "../../src/frontmatter.js";

/**
 * Stateless MCP over Streamable HTTP: every request is one JSON-RPC message
 * answered with one JSON body (the spec's stateless-server mode — our two
 * tools are single synchronous calls, so no SSE stream and no session state).
 * Tool names, descriptions, and argument names mirror src/index.ts exactly;
 * the one deliberate divergence is that `write_context.author` is IGNORED —
 * identity comes from the bearer token, so a member cannot write as another.
 */

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

const PROTOCOL_VERSION = "2025-03-26";

const TOOLS = [
  {
    name: "read_context",
    title: "Read shared planning context",
    description:
      "Pull the latest shared planning context for a project and return the current projected state (all recorded decisions and context, in write order). Call this at the START of a planning turn so decisions written by collaborators are already present without anyone pasting them.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "The shared project/space name, e.g. 'business-one'.",
        },
        budget_tokens: {
          type: "integer",
          exclusiveMinimum: 0,
          description:
            "Override the default read token budget for this call (larger = more history, smaller = tighter context).",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "write_context",
    title: "Write a shared planning decision",
    description:
      "Append a DELIBERATE decision or established context to the shared project space and commit it, so collaborators' sessions see it. Write decisions ('we decided X because Y') and durable context — NOT a firehose of every reasoning step. When the user says 'record this', 'remember this', 'save this decision' (or runs the /remember command), treat it as an EXPLICIT instruction to call this tool right away.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "The shared project/space name, e.g. 'business-one'.",
        },
        type: {
          type: "string",
          enum: ["decision", "context"],
          default: "decision",
          description: "'decision' for a settled call, 'context' for durable background.",
        },
        payload: {
          type: "string",
          description:
            "The decision or context, stated plainly. For decisions, include the 'because' — the reasoning that settles it.",
        },
        author: {
          type: "string",
          description:
            "Ignored on the hosted gateway: attribution always comes from the authenticated member token.",
        },
      },
      required: ["project", "payload"],
    },
  },
];

/** Cache key for /hook/read's per-space projection cache (Task 7 reads it). */
export function hookCacheKey(space: string, project: string): string {
  return `hookread:${space}:${slug(project)}`;
}

function rpcResult(id: RpcMessage["id"], result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(id: RpcMessage["id"], code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function toolText(text: string, isError = false): unknown {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

export async function handleMcp(req: Request, env: Env): Promise<Response> {
  const member = await resolveMember(req, env);
  if (!member) return new Response("unauthorized", { status: 401 });

  let msg: RpcMessage | RpcMessage[];
  try {
    msg = (await req.json()) as RpcMessage | RpcMessage[];
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  if (Array.isArray(msg)) return rpcError(null, -32600, "batch requests not supported");

  switch (msg.method) {
    case "initialize":
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "memorylayer", version: "0.1.0" },
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: TOOLS });
    case "tools/call":
      return toolsCall(msg, member, env);
    default:
      return rpcError(msg.id, -32601, `method not found: ${msg.method ?? "(none)"}`);
  }
}

async function toolsCall(msg: RpcMessage, member: SpaceMember, env: Env): Promise<Response> {
  const fetchImpl = env.githubFetch ?? fetch;
  const args = msg.params?.arguments ?? {};
  const project = typeof args.project === "string" ? args.project : "";
  if (!project) return rpcResult(msg.id, toolText("missing required argument: project", true));

  try {
    switch (msg.params?.name) {
      case "read_context": {
        const budget =
          typeof args.budget_tokens === "number" ? args.budget_tokens : DEFAULT_BUDGET_TOKENS;
        const { entries, total } = await readEntries(env, member, project, budget, fetchImpl);
        return rpcResult(msg.id, toolText(projectContext(project, entries, total)));
      }
      case "write_context": {
        const type: EntryType = args.type === "context" ? "context" : "decision";
        const payload = typeof args.payload === "string" ? args.payload : "";
        if (!payload) return rpcResult(msg.id, toolText("missing required argument: payload", true));
        const entry = await writeEntry(env, member, project, { type, payload }, fetchImpl);
        await env.ROUTING.delete(hookCacheKey(member.space, project));
        return rpcResult(
          msg.id,
          toolText(
            `Recorded ${entry.type} in '${project}' as ${entry.author} at ${entry.timestamp} (${entry.file}).`,
          ),
        );
      }
      default:
        return rpcResult(msg.id, toolText(`unknown tool: ${msg.params?.name ?? "(none)"}`, true));
    }
  } catch (err) {
    return rpcResult(msg.id, toolText((err as Error).message, true));
  }
}
```

- [ ] **Step 4: Route it**

In `gateway/src/router.ts`, add:

```ts
import { handleMcp } from "./mcp.js";
```

and inside `handleRequest`, after the `/admin/members` block:

```ts
  if (url.pathname === "/mcp") {
    if (req.method === "POST") return handleMcp(req, env);
    return new Response("stateless server: POST one JSON-RPC message", { status: 405 });
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd gateway && npm test`
Expected: PASS — including the isolation test.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/mcp.ts gateway/src/router.ts gateway/test/mcp.test.mjs
git commit -m "feat(gateway): stateless MCP-over-HTTP endpoint with stdio-identical tool contract

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Hook read endpoint + per-space KV cache

**Files:**
- Create: `gateway/src/hook-read.ts`
- Modify: `gateway/src/router.ts`
- Test: `gateway/test/hook-read.test.mjs`

**Interfaces:**
- Consumes: `resolveMember` (tenancy.ts), `readEntries` (github-store.ts), `projectContext` (`../../src/context-format.js`), `hookCacheKey` (mcp.ts), `DEFAULT_BUDGET_TOKENS` (`../../src/token-budget.js`).
- Produces: `handleHookRead(req: Request, env: Env): Promise<Response>` routed at `GET /hook/read?project=<name>[&budget=<n>]` → `text/plain` ready-to-inject context (empty body when the project has no entries). Cached per space+project for 60s; invalidated by `write_context` (Task 6 already deletes the key).

- [ ] **Step 1: Write the failing test**

Create `gateway/test/hook-read.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import { makeEnv, ghFetch } from "./helpers.mjs";

const MEMBER = { space: "team-a", installationId: 777, owner: "acme", repo: "team-a-memory", author: "Ada", authorEmail: "ada@acme.io" };
const MD = "---\nauthor: Ada\ntype: decision\ntimestamp: 2026-07-01T00:00:00.000Z\nid: x1\nproject: roadmap\n---\n\nships";

async function setup(routes) {
  const calls = [];
  const env = makeEnv(ghFetch(calls, routes));
  const res = await handleRequest(
    new Request("https://gw.test/admin/members", {
      method: "POST",
      headers: { "x-admin-secret": "test-admin-secret" },
      body: JSON.stringify(MEMBER),
    }),
    env,
  );
  return { env, calls, token: (await res.json()).token };
}

const ROUTES = [
  ["/app/installations/777/access_tokens", () => Response.json({ token: "ghs_a" }, { status: 201 })],
  ["/git/trees/", () => Response.json({ tree: [{ path: "context/roadmap/ada/2026-07-01T00-00-00-000Z-x1.md", type: "blob" }] })],
  ["x1.md", () => new Response(MD)],
];

function get(token, qs = "project=roadmap") {
  return new Request(`https://gw.test/hook/read?${qs}`, { headers: { authorization: `Bearer ${token}` } });
}

test("hook read returns injectable plain text with the session-start preamble", async () => {
  const { env, token } = await setup(ROUTES);
  const res = await handleRequest(get(token), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  const text = await res.text();
  assert.match(text, /^The following is shared planning memory \(MemoryLayer\) for project "roadmap"/);
  assert.match(text, /# Shared context: roadmap/);
});

test("second read within TTL is served from KV (no GitHub traffic)", async () => {
  const { env, token, calls } = await setup(ROUTES);
  await handleRequest(get(token), env);
  const before = calls.length;
  await handleRequest(get(token), env);
  assert.equal(calls.length, before);
});

test("a write_context invalidates the cache so the next read is fresh", async () => {
  const { env, token, calls } = await setup([...ROUTES, ["/contents/", () => Response.json({ ok: true }, { status: 201 })]]);
  await handleRequest(get(token), env); // warm cache
  await handleRequest(
    new Request("https://gw.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "write_context", arguments: { project: "roadmap", type: "context", payload: "new" } } }),
    }),
    env,
  );
  const before = calls.length;
  await handleRequest(get(token), env);
  assert.ok(calls.length > before, "post-write read must hit GitHub again");
});

test("empty project -> 400; no entries -> empty 200 body; no auth -> 401", async () => {
  const { env, token } = await setup([
    ["/app/installations/777/access_tokens", () => Response.json({ token: "ghs_a" }, { status: 201 })],
    ["/git/trees/", () => Response.json({ tree: [] })],
  ]);
  assert.equal((await handleRequest(get(token, ""), env)).status, 400);
  const empty = await handleRequest(get(token), env);
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), "");
  assert.equal((await handleRequest(new Request("https://gw.test/hook/read?project=x"), env)).status, 401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gateway && npm test`
Expected: FAIL — `/hook/read` returns 404.

- [ ] **Step 3: Implement `gateway/src/hook-read.ts`**

```ts
import type { Env } from "./env.js";
import { resolveMember } from "./tenancy.js";
import { readEntries } from "./github-store.js";
import { hookCacheKey } from "./mcp.js";
import { projectContext } from "../../src/context-format.js";
import { DEFAULT_BUDGET_TOKENS } from "../../src/token-budget.js";

/** Seconds a rendered projection may be served stale to keep the per-turn
 *  hook round-trip at one edge hit (~50-150ms) instead of chained GitHub
 *  calls (~200-600ms). Writes through the gateway invalidate immediately. */
const CACHE_TTL_SECONDS = 60;

/**
 * GET /hook/read?project=<name>[&budget=<n>] — the session-start hook's
 * entire remote path: returns ready-to-inject plain text (preamble +
 * projection), or an empty 200 body when the project has no entries so thin
 * client shims can fail-open on empty. Cached per space+project.
 */
export async function handleHookRead(req: Request, env: Env): Promise<Response> {
  const member = await resolveMember(req, env);
  if (!member) return new Response("unauthorized", { status: 401 });

  const url = new URL(req.url);
  const project = url.searchParams.get("project")?.trim() ?? "";
  if (!project) return new Response("missing project", { status: 400 });

  const asText = (body: string) =>
    new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });

  const cacheKey = hookCacheKey(member.space, project);
  const cached = await env.ROUTING.get(cacheKey);
  if (cached !== null) return asText(cached);

  const budgetParam = Number(url.searchParams.get("budget"));
  const budget = Number.isFinite(budgetParam) && budgetParam !== 0 ? budgetParam : DEFAULT_BUDGET_TOKENS;
  const { entries, total } = await readEntries(
    env,
    member,
    project,
    budget,
    env.githubFetch ?? fetch,
  );

  const text =
    total === 0
      ? ""
      : `The following is shared planning memory (MemoryLayer) for project ` +
        `"${project}", loaded automatically at session start. Treat these recorded ` +
        `decisions and context as already-known; do not ask the user to re-explain ` +
        `them.\n\n${projectContext(project, entries, total)}`;

  await env.ROUTING.put(cacheKey, text, { expirationTtl: CACHE_TTL_SECONDS });
  return asText(text);
}
```

- [ ] **Step 4: Route it**

In `gateway/src/router.ts`, add:

```ts
import { handleHookRead } from "./hook-read.js";
```

and inside `handleRequest`, after the `/mcp` block:

```ts
  if (url.pathname === "/hook/read" && req.method === "GET") {
    return handleHookRead(req, env);
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd gateway && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add gateway/src/hook-read.ts gateway/src/router.ts gateway/test/hook-read.test.mjs
git commit -m "feat(gateway): cached plain-text hook read endpoint for thin client shims

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Deploy runbook, wrangler config, live smoke + interop check

**Files:**
- Create: `gateway/wrangler.toml`, `gateway/README.md`
- Modify: root `package.json` (add `test:gateway` script)

**Interfaces:**
- Consumes: everything above.
- Produces: a deployed Worker; a runbook a teammate can follow; a live-verified interop guarantee.

- [ ] **Step 1: Create `gateway/wrangler.toml`**

```toml
name = "memorylayer-gateway"
main = "dist/gateway/src/worker.js"
compatibility_date = "2026-06-01"

# Created in Step 3; paste the id wrangler prints.
[[kv_namespaces]]
binding = "ROUTING"
id = "REPLACE_WITH_KV_NAMESPACE_ID"
```

(The placeholder id is config-by-construction, not code: `wrangler kv namespace create` prints the real value in Step 3. Secrets are NOT in this file.)

- [ ] **Step 2: Add the root convenience script**

In root `package.json` `scripts`, add:

```json
    "test:gateway": "cd gateway && npm test",
```

- [ ] **Step 3: One-time Cloudflare + GitHub App provisioning (manual, documented)**

Run and record outputs:

```bash
cd gateway
npx wrangler login
npx wrangler kv namespace create ROUTING   # paste printed id into wrangler.toml
```

GitHub App (once, at https://github.com/settings/apps → New GitHub App):
- Name: `memorylayer-gateway` (any unique name works)
- Homepage URL: the repo URL; **Webhook: inactive** (no webhook URL needed)
- Permissions: **Repository permissions → Contents: Read and write.** Nothing else.
- "Where can this App be installed?" → Only on this account (pilot).
- After creation: note the **App ID**; generate + download a **private key**.

Convert the key (GitHub ships PKCS#1; WebCrypto needs PKCS#8):

```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt \
  -in memorylayer-gateway.*.private-key.pem -out app-pkcs8.pem
```

Install the App on the space repo (e.g. `MemoryLayer-Memory`) via the App's page → Install App → select **only** that repository. Note the **installation id** (the number in the URL: `/settings/installations/<id>`).

Set secrets and deploy:

```bash
npx wrangler secret put GITHUB_APP_ID          # the App ID
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < app-pkcs8.pem
npx wrangler secret put ADMIN_SECRET           # openssl rand -hex 32
npm run deploy
rm app-pkcs8.pem                               # never leave the key on disk unencrypted
```

- [ ] **Step 4: Live smoke test**

With `GW=https://memorylayer-gateway.<account>.workers.dev`:

```bash
curl -s $GW/health
# expect: {"ok":true}

curl -s -X POST $GW/admin/members \
  -H "x-admin-secret: $ADMIN_SECRET" -H "content-type: application/json" \
  -d '{"space":"memorylayer","installationId":<id>,"owner":"skandaramanan","repo":"MemoryLayer-Memory","author":"Skanda","authorEmail":"skandar1412@gmail.com"}'
# expect: {"token":"mlk_...","member":{...}}  — save the token as $TOK

curl -s -X POST $GW/mcp -H "authorization: Bearer $TOK" -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write_context","arguments":{"project":"gateway-smoke","type":"context","payload":"hosted gateway live smoke entry"}}}'
# expect: result.content[0].text starting "Recorded context in 'gateway-smoke' as Skanda at ..."

curl -s "$GW/hook/read?project=gateway-smoke" -H "authorization: Bearer $TOK"
# expect: preamble + "# Shared context: gateway-smoke" + the smoke entry

curl -s -X POST $GW/mcp -d '{}' -o /dev/null -w "%{http_code}\n"
# expect: 401  (live isolation floor: no token, no data)
```

**Interop check (the point of byte-compatibility):** on this machine, the local stdio tool reads the same repo — run `memorylayer` MCP `read_context` for project `gateway-smoke` (or `git -C ~/.local/share/memorylayer/clones/<memorylayer-clone> pull && ls context/gateway-smoke/skanda/`) and confirm the gateway-written entry appears with intact frontmatter. Then measure the budget claim:

```bash
time curl -s "$GW/hook/read?project=gateway-smoke" -H "authorization: Bearer $TOK" -o /dev/null   # cold
time curl -s "$GW/hook/read?project=gateway-smoke" -H "authorization: Bearer $TOK" -o /dev/null   # cached — expect well under ~300ms total
```

- [ ] **Step 5: Write `gateway/README.md`**

```markdown
# MemoryLayer Hosted Gateway

Stateless MCP-over-HTTP gateway on Cloudflare Workers. Same two tools as the
local stdio server (`read_context`, `write_context`), same on-disk entry
format, stored in a GitHub-App-managed private repo per space.

## Endpoints
- `POST /mcp` — MCP Streamable HTTP (stateless JSON): `Authorization: Bearer mlk_...`
- `GET /hook/read?project=<name>` — plain-text session-start context (60s per-space cache, invalidated on write)
- `POST /admin/members` — mint a member token (`x-admin-secret` header)
- `GET /health`

## Tenancy model
One private GitHub repo per space; the GitHub App is installed on exactly that
repo. A member token maps (via SHA-256 hash in KV) to one space record; every
GitHub call uses a per-installation token scoped to that one repo. No API
surface accepts a repo/space parameter — isolation is by construction.
`write_context.author` is ignored: attribution comes from the token.

## Interop
Entries written here are byte-identical to local-tool entries (shared
`src/frontmatter.ts`). A space repo can be used by hosted members and local
raw-git-token members simultaneously.

## Limits (Workers free plan)
- 50 subrequests/request → reads fetch at most the 40 newest entry files
  (`MAX_ENTRY_FETCH`); `total` still reports the full count.
- GitHub API: 5,000 req/hr **per installation** — per-space quota by design.

## Deploy
See Task 8 of docs/plans/2026-07-05-hosted-gateway-core.md (provisioning
runbook: KV namespace, GitHub App, PKCS#8 key conversion, secrets, smoke).

## Client config (any MCP HTTP client)
    { "url": "https://<worker>/mcp", "headers": { "Authorization": "Bearer mlk_..." } }
```

- [ ] **Step 6: Full green bar + commit**

Run: `npm test && npm run lint && npm run format:check && npm run test:gateway`
Expected: all green.

```bash
git add gateway/wrangler.toml gateway/README.md package.json
git commit -m "feat(gateway): wrangler config, deploy runbook, live smoke + interop check

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage** (roadmap Phase 1 vs tasks): 1.1 MCP over Streamable HTTP → Task 6. 1.2 store ops on GitHub REST/Trees API, projection layer unchanged → Tasks 1+5. 1.3 one-repo-per-space, per-installation tokens, mandatory isolation tests → Tasks 3+4+6 (unit) + Task 8 (live floor). 1.4 kill the raw git token for hosted members → Task 4 (member tokens; App holds git credentials). 1.5 Trees API + KV cache, hand off beyond → Tasks 5+7 (ETag conditional requests deliberately deferred to Plan B — the 60s cache already collapses the hot path). Session-start latency budget (this session's addition) → Task 7 cache + Task 8 timed smoke. *Gaps, intentionally deferred:* client shims/`init --remote` (Plan B); space-provisioning CLI wrapping `/admin/members` (Plan C); prompt-injection presentation stance (roadmap 0.2, applies to both planes, separate work).

**Placeholder scan:** the single `REPLACE_WITH_KV_NAMESPACE_ID` in `wrangler.toml` is a deploy-time value printed by `wrangler kv namespace create` (Step 3), not deferred design — everything else is complete code. ✓

**Type consistency:** `Env`/`KVStore` (T2) match usage in T3–T7; `SpaceMember` (T4) field set matches T5/T6 construction and `branch` defaulting; `writeEntry(env, member, project, entry, fetchImpl)` and `readEntries(env, member, project, budgetTokens, fetchImpl)` signatures match T6/T7 call sites; `hookCacheKey` exported from mcp.ts (T6) and imported by hook-read.ts (T7); `packToBudget`/`slug`/`fsSafeTimestamp` import paths (`../../src/*.js`) match the T2 tsconfig `rootDir`/`include` layout. ✓
