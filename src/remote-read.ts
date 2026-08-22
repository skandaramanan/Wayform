/**
 * Remote-first read client (§2.2): the local plane calls the gateway's
 * retrieval service and falls back to the local clone when offline or
 * unconfigured. Every failure returns null — callers treat null as "use the
 * local path", never as an error. Bounded by a timeout so a slow gateway
 * cannot stall a session hook.
 */
import type { Config } from "./config.js";
import { oauthFetch } from "./oauth-session.js";

export interface RemoteReadResult {
  text: string;
  total: number;
  matched: number;
}

const REMOTE_TIMEOUT_MS = 4000;

type GatewayCfg = Pick<Config, "gatewayUrl">;

export type GatewayFetch = (
  gatewayUrl: string,
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function configured(
  cfg: GatewayCfg,
): cfg is GatewayCfg & { gatewayUrl: string } {
  return Boolean(cfg.gatewayUrl);
}

export async function remoteApiRead(
  cfg: GatewayCfg,
  opts: {
    project: string;
    query?: string;
    budgetTokens?: number;
    kinds?: string[];
    trigger?: string;
  },
  fetchImpl: GatewayFetch = oauthFetch,
): Promise<RemoteReadResult | null> {
  if (!configured(cfg)) return null;
  try {
    const url = new URL(`${cfg.gatewayUrl}/mcp/api/read`);
    url.searchParams.set("project", opts.project);
    if (opts.query) url.searchParams.set("query", opts.query);
    if (opts.budgetTokens)
      url.searchParams.set("budget", String(opts.budgetTokens));
    if (opts.kinds?.length) url.searchParams.set("kinds", opts.kinds.join(","));
    if (opts.trigger) url.searchParams.set("trigger", opts.trigger);
    const res = await fetchImpl(cfg.gatewayUrl, url.toString(), {
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<RemoteReadResult>;
    if (typeof body.text !== "string" || typeof body.total !== "number")
      return null;
    return {
      text: body.text,
      total: body.total,
      matched: typeof body.matched === "number" ? body.matched : 0,
    };
  } catch {
    return null;
  }
}

export async function remoteHookRead(
  cfg: GatewayCfg,
  project: string,
  budgetTokens: number,
  fetchImpl: GatewayFetch = oauthFetch,
): Promise<string | null> {
  if (!configured(cfg)) return null;
  try {
    const url = new URL(`${cfg.gatewayUrl}/mcp/hook/read`);
    url.searchParams.set("project", project);
    url.searchParams.set("budget", String(budgetTokens));
    const res = await fetchImpl(cfg.gatewayUrl, url.toString(), {
      signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** POST /mcp/hook/prompt — returns inject text or "" (nothing to inject) or null (gateway unusable). */
export async function remoteHookPrompt(
  cfg: GatewayCfg,
  project: string,
  prompt: string,
  budgetTokens: number,
  fetchImpl: GatewayFetch = oauthFetch,
): Promise<string | null> {
  if (!configured(cfg)) return null;
  try {
    const res = await fetchImpl(
      cfg.gatewayUrl,
      `${cfg.gatewayUrl}/mcp/hook/prompt`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ project, prompt, budget: budgetTokens }),
        signal: AbortSignal.timeout(REMOTE_TIMEOUT_MS),
      },
    );
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
