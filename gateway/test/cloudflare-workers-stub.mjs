/** Node stand-in for `cloudflare:workers` so workers-oauth-provider loads under node:test. */
export class WorkerEntrypoint {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
