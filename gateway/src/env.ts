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

import type { D1Like, IndexDb } from "./index-db.js";
import type { Embedder } from "./retrieval.js";

/** Minimal Workers AI surface used for embeddings. */
export interface AiBinding {
  run(model: string, input: { text: string[] }): Promise<{ data: number[][] }>;
}

export interface Env {
  ROUTING: KVStore;
  GITHUB_APP_ID: string;
  /** PKCS#8 PEM. GitHub downloads PKCS#1 — convert before `wrangler secret put`. */
  GITHUB_APP_PRIVATE_KEY: string;
  ADMIN_SECRET: string;
  /** D1 index database. Optional: absent = index plane disabled, recency reads only. */
  DB?: D1Like;
  /** Workers AI binding for embeddings. Optional: absent = BM25-only retrieval. */
  AI?: AiBinding;
  /** GitHub App webhook secret for POST /webhook/github signature checks. */
  WEBHOOK_SECRET?: string;
  /** Test seam: injected GitHub fetch. Production leaves it unset. */
  githubFetch?: typeof fetch;
  /** Test seams: injected index store / embedder. Production leaves unset. */
  indexDb?: IndexDb;
  embedder?: Embedder;
}
