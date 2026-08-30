/** Ambient types so tsc can resolve workers-oauth-provider under `"types": []`. */
declare module "cloudflare:workers" {
  export class WorkerEntrypoint<Env = unknown, Props = unknown> {
    constructor(ctx: ExecutionContext, env: Env);
    ctx: ExecutionContext & { props?: Props };
    env: Env;
    fetch?(request: Request): Response | Promise<Response>;
  }
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

declare namespace Cloudflare {
  interface Env {}
  const compatibilityFlags: { global_fetch_strictly_public?: boolean };
}
