/**
 * Abuse protection at the Worker's single entry point.
 *
 * Why here and not in router.ts: `/oauth/register` (unauthenticated Dynamic
 * Client Registration) and `/oauth/token` are handled INSIDE
 * workers-oauth-provider and never reach our router. Wrapping worker.fetch is
 * the one place every request passes through.
 *
 * Only UNAUTHENTICATED surfaces are limited. `/mcp` needs a valid OAuth token,
 * so abuse there is a compromised-member problem, and the fix for that is
 * revoke_session — not a ceiling that also throttles legitimate agents.
 *
 * Uses the Workers rate-limiting binding: no KV/D1 writes, so guarding every
 * request adds no storage ops. Counters are per-Cloudflare-location and
 * eventually consistent — abuse protection, not accounting.
 * ponytail: per-colo counters; move to a DO-backed limiter only if abuse
 * actually arrives distributed enough to matter.
 *
 * FAIL-OPEN on a missing or throwing binding: an unavailable rate limiter must
 * never take the gateway's auth flow offline.
 *
 * !! NOT CURRENTLY ENFORCING (verified live 2026-08-30). Deployed and bound
 * (`env.RL_AUTH (20 requests/60s)` in wrangler output), key is stable, and
 * limit() is called on every request — but it returned success:true for 100+
 * requests in seconds against a limit of 20/60s. Config matches the docs
 * exactly. Account/platform behavior, not a code defect; this code starts
 * working the moment the binding does. Do NOT treat these paths as rate
 * limited until a `ratelimit_block` line appears in Workers Logs.
 */
import { errorPage } from "./page.js";

/** Structural match for the Workers `ratelimit` binding; local so tests can fake it. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Deliberately NOT limited: `/health`, so uptime checks never trip it, and
 * `/webhook/github`, which is HMAC-verified and arrives from GitHub's own
 * range — dropping webhooks would silently stall indexing, a worse failure
 * than the abuse it would prevent.
 */
export function isLimited(pathname: string): boolean {
  return (
    pathname === "/authorize" ||
    pathname === "/callback" ||
    pathname === "/oauth/register" ||
    pathname === "/oauth/token" ||
    pathname.startsWith("/install/") ||
    // Guarded only by a shared secret; without a limit that secret is
    // brute-forceable at line rate.
    pathname.startsWith("/admin/")
  );
}

/**
 * Per-caller key. Prefers a hash of the Authorization header (admin routes
 * carry one) so one caller cannot spend another's budget; falls back to client
 * IP. The token itself is never used as a key — keys can surface in diagnostics.
 */
export async function rateLimitKey(req: Request): Promise<string> {
  const auth = req.headers.get("authorization");
  if (auth) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(auth),
    );
    const hex = [...new Uint8Array(digest)]
      .slice(0, 16)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `t:${hex}`;
  }
  return `ip:${
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for") ??
    "unknown"
  }`;
}

/** 429 shaped for whoever is asking: a page for browsers, JSON for clients. */
function tooManyRequests(req: Request): Response {
  if ((req.headers.get("accept") ?? "").includes("text/html")) {
    const res = errorPage({
      status: 429,
      title: "Too many attempts",
      message:
        "This browser has made too many sign-in attempts in a short window.",
      hint: "Wait a minute, then start the connection again from your editor.",
    });
    res.headers.set("retry-after", "60");
    return res;
  }
  return Response.json(
    { error: "rate_limited", error_description: "Too many requests." },
    { status: 429, headers: { "retry-after": "60" } },
  );
}

/**
 * Returns a 429 Response when the caller is over budget, or null to continue.
 * Never throws.
 */
export async function enforceRateLimit(
  req: Request,
  env: { RL_AUTH?: RateLimiter },
): Promise<Response | null> {
  try {
    if (!isLimited(new URL(req.url).pathname)) return null;
    // Unconfigured binding (local dev, or a plan without it) must not break auth.
    if (!env.RL_AUTH) return null;
    const key = await rateLimitKey(req);
    const { success } = await env.RL_AUTH.limit({ key });
    if (success) return null;
    // The only way to confirm this control is alive: verified 2026-08-30 that
    // a bound limiter can return success unconditionally, so absence of this
    // line under load means it is NOT enforcing.
    console.log(JSON.stringify({ evt: "ratelimit_block", key }));
    return tooManyRequests(req);
  } catch {
    // Fail open: a broken limiter is never a reason to refuse real traffic.
    return null;
  }
}
