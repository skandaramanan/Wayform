import { handleRequest } from "./router.js";
import { reconcileAll } from "./reindex.js";
import type { Env } from "./env.js";

interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

export default {
  fetch(req: Request, env: Env, ctx?: Ctx): Promise<Response> {
    return handleRequest(req, env, ctx);
  },
  /** Cron reconciler: catches dropped webhooks by sha drift (§2.1). */
  scheduled(_event: unknown, env: Env, ctx: Ctx): void {
    ctx.waitUntil(reconcileAll(env));
  },
};
