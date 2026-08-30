/**
 * Abuse protection at the Worker's single entry point.
 *
 * Why here and not in router.ts: `/oauth/register` (unauthenticated Dynamic
 * Client Registration) and `/oauth/token` are handled INSIDE
 * workers-oauth-provider and never reach our router. Wrapping worker.fetch is
 * the one place every request passes through, so one guard covers the
 * endpoints that most need it.
 *
 * Uses the Workers rate-limiting binding: no KV/D1 writes and no per-request
 * billable storage op, so the cost of guarding every request is zero on top of
 * the plan we already pay for.
 *
 * Trade-offs the binding documents and we accept: counters are
 * per-Cloudflare-location and eventually consistent, so this is abuse
 * protection, NOT accounting. An attacker spread across many colos gets a
 * higher effective ceiling. That is the right trade here — the alternative
 * that IS globally exact is a Durable Object, which would add a DO invocation
 * plus duration billing to literally every request to buy accuracy this
 * threat model does not need.
 * ponytail: per-colo counters; move to a DO-backed limiter only if abuse
 * actually arrives distributed enough to matter.
 *
 * FAIL-OPEN on a missing or throwing binding: an unavailable rate limiter must
 * never take the gateway's auth flow offline.
 */
import { errorPage } from "./page.js";

/** Structural match for the Workers `ratelimit` binding; local so tests can fake it. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface RateLimitEnv {
  /** Auth + admin surfaces: strict. */
  RL_AUTH?: RateLimiter;
  /** Authenticated MCP traffic: generous — agents are chatty by design. */
  RL_API?: RateLimiter;
}

export type Bucket = "auth" | "api";

/**
 * Which limit applies to a path, or null to skip.
 *
 * Deliberately NOT limited:
 *  - `/health`, so uptime checks never trip it.
 *  - `/webhook/github`, which is HMAC-verified and arrives from GitHub's own
 *    address range; dropping webhooks would silently stall indexing, a worse
 *    failure than the abuse it would prevent.
 */
export function bucketFor(pathname: string): Bucket | null {
  if (pathname === "/mcp" || pathname.startsWith("/mcp/")) return "api";
  if (
    pathname === "/authorize" ||
    pathname === "/callback" ||
    pathname === "/oauth/register" ||
    pathname === "/oauth/token" ||
    pathname.startsWith("/install/") ||
    // Admin routes are guarded only by a shared secret; without a limit here
    // that secret is brute-forceable at line rate.
    pathname.startsWith("/admin/")
  ) {
    return "auth";
  }
  return null;
}

/**
 * Per-caller key. Prefers a hash of the Authorization header so that a team
 * behind one NAT gets a budget per member rather than one shared budget; falls
 * back to client IP for the unauthenticated surfaces. The token itself is
 * never used as a key — keys can surface in diagnostics.
 */
export async function rateLimitKey(
  req: Request,
  bucket: Bucket,
): Promise<string> {
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
    return `${bucket}:t:${hex}`;
  }
  const ip =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-forwarded-for") ??
    "unknown";
  return `${bucket}:ip:${ip}`;
}

/** 429 shaped for whoever is asking: a page for browsers, JSON for clients. */
function tooManyRequests(req: Request): Response {
  const wantsHtml = (req.headers.get("accept") ?? "").includes("text/html");
  if (wantsHtml) {
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
  env: RateLimitEnv,
): Promise<Response | null> {
  try {
    const bucket = bucketFor(new URL(req.url).pathname);
    if (!bucket) return null;
    const limiter = bucket === "api" ? env.RL_API : env.RL_AUTH;
    // Unconfigured binding (local dev, or a plan without it) must not break auth.
    if (!limiter) return null;
    const { success } = await limiter.limit({
      key: await rateLimitKey(req, bucket),
    });
    return success ? null : tooManyRequests(req);
  } catch {
    // Fail open: a broken limiter is never a reason to refuse real traffic.
    return null;
  }
}
