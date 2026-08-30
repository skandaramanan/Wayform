import { createGatewayOAuthProvider } from "./oauth.js";
import { reconcileAll } from "./reindex.js";
import type { Env } from "./env.js";
import { enforceRateLimit } from "./rate-limit.js";

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

const oauth = createGatewayOAuthProvider();

export default {
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    // Before the OAuth provider, so it also covers /oauth/register and
    // /oauth/token — endpoints the provider serves internally and which our
    // router never sees. Returns null (continue) unless the caller is over budget.
    const limited = await enforceRateLimit(req, env);
    if (limited) return limited;
    return oauth.fetch(req, env, ctx);
  },
  /** Cron reconciler: catches dropped webhooks by sha drift (§2.1). */
  scheduled(_event: unknown, env: Env, ctx: Ctx): void {
    ctx.waitUntil(reconcileAll(env));
    ctx.waitUntil(oauth.purgeExpiredData(env));
  },
};
