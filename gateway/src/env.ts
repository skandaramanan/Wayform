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

/** workers-oauth-provider's KV surface (get-with-type + list). */
export interface OauthKvStore {
  get(key: string, opts?: { type?: string } | string): Promise<unknown>;
  put(
    key: string,
    value: string,
    opts?: { expirationTtl?: number },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    keys: { name: string }[];
    list_complete: boolean;
    cursor?: string;
  }>;
}

import type { D1Like, IndexDb } from "./index-db.js";
import type { Embedder } from "./retrieval.js";

/** Minimal Workers AI surface: embeddings and text generation. */
export interface AiBinding {
  run(model: string, input: { text: string[] }): Promise<{ data: number[][] }>;
  run(
    model: string,
    input: { prompt: string; max_tokens?: number },
  ): Promise<{ response: string }>;
}

export interface Env {
  ROUTING: KVStore;
  /** OAuth grants/clients. Same Cloudflare namespace as ROUTING is fine. */
  OAUTH_KV: OauthKvStore;
  /** Injected by workers-oauth-provider on each request. */
  OAUTH_PROVIDER?: import("@cloudflare/workers-oauth-provider").OAuthHelpers;
  GITHUB_APP_ID: string;
  /** PKCS#8 PEM. GitHub downloads PKCS#1 — convert before `wrangler secret put`. */
  GITHUB_APP_PRIVATE_KEY: string;
  /** GitHub App user-to-server OAuth client id (Iv1.…), not the numeric App ID. */
  GITHUB_CLIENT_ID?: string;
  /** GitHub App OAuth client secret, used only on /callback code exchange. */
  GITHUB_CLIENT_SECRET?: string;
  /**
   * Test seam: GitHub identity the OAuth wrapper would put on ctx.props.
   * Production requests get props from workers-oauth-provider; handler tests
   * that call handleRequest directly set this instead of minting mlk_ tokens.
   */
  oauthProps?: { githubId: number; githubLogin?: string };
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
  /** Test seam: injected text-gen. Production leaves it unset (uses AI). */
  genText?: (prompt: string) => Promise<string>;
  /** Test seam: force the near-duplicate write gate on/off. Production
   *  leaves it unset (behavior comes from DUP_GATE_ENFORCE in supersede.ts). */
  dupGateEnforce?: boolean;
}

/** waitUntil plus OAuth grant props injected by workers-oauth-provider. */
export interface HandlerCtx {
  waitUntil(p: Promise<unknown>): void;
  props?: { githubId?: number; githubLogin?: string };
}
