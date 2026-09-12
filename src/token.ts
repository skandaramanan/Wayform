/**
 * `wayform token` — print the operator's bearer credential for the gateway.
 *
 * Operator routes (`/admin/*`) are gated on GitHub identity, not a shared
 * secret, so a hand-run curl needs the caller's own OAuth token. That token
 * lives in the OS keyring and there was previously no way to get at it without
 * a `security find-generic-password` incantation — which made the more secure
 * design the less usable one, and that is how shared secrets creep back.
 *
 * `--header` prints a ready-to-use `-H` argument value; bare prints the raw
 * token. Refreshes through the normal session path, so an expired token is
 * renewed rather than printed stale.
 */
import { loadConfig } from "./config.js";
import { getValidAccessToken } from "./oauth-session.js";
import { DEFAULT_GATEWAY_URL } from "./oauth-login.js";

export interface TokenDeps {
  log?: (msg: string) => void;
  getToken?: (gatewayUrl: string) => Promise<string>;
}

export function parseTokenArgs(args: string[]): { header: boolean } {
  return { header: args.includes("--header") };
}

export async function runToken(
  args: string[],
  deps: TokenDeps = {},
): Promise<void> {
  const log = deps.log ?? ((m: string) => console.log(m));
  const getToken = deps.getToken ?? ((url: string) => getValidAccessToken(url));

  // A logged-out member has no config to speak of, so fall back to the default
  // gateway rather than making `wayform token` fail for the wrong reason.
  let gatewayUrl: string;
  try {
    gatewayUrl = loadConfig().gatewayUrl ?? DEFAULT_GATEWAY_URL;
  } catch {
    gatewayUrl = DEFAULT_GATEWAY_URL;
  }

  const token = await getToken(gatewayUrl);
  const { header } = parseTokenArgs(args);
  log(header ? `authorization: Bearer ${token}` : token);
}
