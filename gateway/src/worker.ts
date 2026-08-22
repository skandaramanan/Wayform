import { createGatewayOAuthProvider } from "./oauth.js";
import { reconcileAll } from "./reindex.js";
import type { Env } from "./env.js";

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

const oauth = createGatewayOAuthProvider();

export default {
  fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    return oauth.fetch(req, env, ctx);
  },
  /** Cron reconciler: catches dropped webhooks by sha drift (§2.1). */
  scheduled(_event: unknown, env: Env, ctx: Ctx): void {
    ctx.waitUntil(reconcileAll(env));
    ctx.waitUntil(oauth.purgeExpiredData(env));
  },
};
