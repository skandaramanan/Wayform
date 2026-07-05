/**
 * Minimal KV surface the gateway uses. Structural match for a Workers
 * KVNamespace binding, but defined locally so handlers stay testable under
 * node:test with an in-memory fake and no Workers type dependency.
 */
export interface KVStore {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void>;
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
