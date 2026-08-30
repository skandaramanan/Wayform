import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bucketFor,
  enforceRateLimit,
  rateLimitKey,
} from "../dist/gateway/src/rate-limit.js";

const limiter = (success) => ({
  calls: [],
  async limit(opts) {
    this.calls.push(opts.key);
    return { success };
  },
});

function req(path, init = {}) {
  return new Request(`https://gw.test${path}`, init);
}

test("buckets cover the abusable surfaces and skip the ones that must not drop", () => {
  // Handled inside workers-oauth-provider — the router never sees these, which
  // is exactly why the guard lives at the Worker entry point.
  assert.equal(bucketFor("/oauth/register"), "auth");
  assert.equal(bucketFor("/oauth/token"), "auth");
  assert.equal(bucketFor("/authorize"), "auth");
  assert.equal(bucketFor("/callback"), "auth");
  assert.equal(bucketFor("/install/select"), "auth");
  // Guarded only by a shared secret, so it must not be brute-forceable.
  assert.equal(bucketFor("/admin/reindex"), "auth");
  assert.equal(bucketFor("/mcp"), "api");
  assert.equal(bucketFor("/mcp/hook/read"), "api");
  // Uptime checks and signed GitHub webhooks must never be throttled.
  assert.equal(bucketFor("/health"), null);
  assert.equal(bucketFor("/webhook/github"), null);
});

test("keys use a token hash when authenticated, never the raw token", async () => {
  const key = await rateLimitKey(
    req("/mcp", { headers: { authorization: "Bearer super-secret-token" } }),
    "api",
  );
  assert.match(key, /^api:t:[0-9a-f]{32}$/);
  assert.equal(key.includes("super-secret-token"), false);
});

test("keys fall back to client IP when unauthenticated", async () => {
  const key = await rateLimitKey(
    req("/authorize", { headers: { "cf-connecting-ip": "203.0.113.7" } }),
    "auth",
  );
  assert.equal(key, "auth:ip:203.0.113.7");
});

test("two members behind one NAT get separate budgets", async () => {
  const headers = (t) => ({
    authorization: `Bearer ${t}`,
    "cf-connecting-ip": "198.51.100.1",
  });
  const a = await rateLimitKey(req("/mcp", { headers: headers("aaa") }), "api");
  const b = await rateLimitKey(req("/mcp", { headers: headers("bbb") }), "api");
  assert.notEqual(a, b);
});

test("over budget returns 429 with retry-after", async () => {
  const rl = limiter(false);
  const res = await enforceRateLimit(req("/mcp"), { RL_API: rl });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal((await res.json()).error, "rate_limited");
  assert.equal(rl.calls.length, 1);
});

test("a browser hitting the limit gets the styled page, not JSON", async () => {
  const res = await enforceRateLimit(
    req("/authorize", { headers: { accept: "text/html,*/*" } }),
    { RL_AUTH: limiter(false) },
  );
  assert.equal(res.status, 429);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const html = await res.text();
  assert.match(html, /Too many attempts/);
  assert.match(html, /prefers-color-scheme/);
});

test("under budget continues", async () => {
  assert.equal(
    await enforceRateLimit(req("/mcp"), { RL_API: limiter(true) }),
    null,
  );
});

test("unlimited paths never consult the limiter", async () => {
  const rl = limiter(false);
  assert.equal(
    await enforceRateLimit(req("/health"), { RL_AUTH: rl, RL_API: rl }),
    null,
  );
  assert.equal(rl.calls.length, 0);
});

test("a missing binding fails open", async () => {
  // Local dev and any environment without the binding must still serve auth.
  assert.equal(await enforceRateLimit(req("/authorize"), {}), null);
});

test("a throwing binding fails open rather than refusing real traffic", async () => {
  const res = await enforceRateLimit(req("/authorize"), {
    RL_AUTH: {
      async limit() {
        throw new Error("limiter unavailable");
      },
    },
  });
  assert.equal(res, null);
});

test("the guard runs at the Worker entry, before the OAuth provider", async () => {
  // Regression guard for placement, not logic: /oauth/register is served
  // inside workers-oauth-provider, so a limiter mounted in router.ts would
  // never see it. If this 429 stops arriving, the guard has been moved.
  const worker = (await import("../dist/gateway/src/worker.js")).default;
  const res = await worker.fetch(
    new Request("https://gw.test/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }),
    { RL_AUTH: limiter(false) },
    { waitUntil() {} },
  );
  assert.equal(res.status, 429);
});
