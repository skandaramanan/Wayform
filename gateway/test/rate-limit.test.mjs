import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isLimited,
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

test("limits cover the unauthenticated surfaces and skip what must not drop", () => {
  // Handled inside workers-oauth-provider — the router never sees these, which
  // is exactly why the guard lives at the Worker entry point.
  assert.equal(isLimited("/oauth/register"), true);
  assert.equal(isLimited("/oauth/token"), true);
  assert.equal(isLimited("/authorize"), true);
  assert.equal(isLimited("/callback"), true);
  assert.equal(isLimited("/install/select"), true);
  // /mcp needs a valid token: abuse there is revoke_session's job, and a
  // ceiling here would throttle legitimate agents instead.
  assert.equal(isLimited("/mcp"), false);
  // Admin used to be limited because a shared secret was all that guarded it.
  // It is OAuth-gated under /mcp now, so it follows the /mcp rule.
  assert.equal(isLimited("/mcp/admin/reindex"), false);
  // The pre-move path is gone entirely (the router 410s it).
  assert.equal(isLimited("/admin/reindex"), false);
  // Uptime checks and signed GitHub webhooks must never be throttled.
  assert.equal(isLimited("/health"), false);
  assert.equal(isLimited("/webhook/github"), false);
});

test("keys use a token hash when authenticated, never the raw token", async () => {
  const key = await rateLimitKey(
    req("/mcp/admin/reindex", {
      headers: { authorization: "Bearer super-secret-token" },
    }),
  );
  assert.match(key, /^t:[0-9a-f]{32}$/);
  assert.equal(key.includes("super-secret-token"), false);
});

test("keys fall back to client IP when unauthenticated", async () => {
  const key = await rateLimitKey(
    req("/authorize", { headers: { "cf-connecting-ip": "203.0.113.7" } }),
  );
  assert.equal(key, "ip:203.0.113.7");
});

test("over budget returns 429 with retry-after", async () => {
  const rl = limiter(false);
  const res = await enforceRateLimit(req("/authorize"), { RL_AUTH: rl });
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
    await enforceRateLimit(req("/authorize"), { RL_AUTH: limiter(true) }),
    null,
  );
});

test("unlimited paths never consult the limiter", async () => {
  const rl = limiter(false);
  assert.equal(await enforceRateLimit(req("/health"), { RL_AUTH: rl }), null);
  assert.equal(await enforceRateLimit(req("/mcp"), { RL_AUTH: rl }), null);
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
