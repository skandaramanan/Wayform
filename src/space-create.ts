/**
 * `wayform space create` — operator helper: print the GitHub App install URL
 * and remind them to allowlist the customer. Does not mint tokens or create
 * their repo.
 */
import { DEFAULT_GATEWAY_URL } from "./oauth-login.js";

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};

export interface SpaceCreateArgs {
  owner?: string;
  appSlug: string;
  gatewayUrl: string;
}

export function parseSpaceCreateArgs(args: string[]): SpaceCreateArgs {
  const appSlug =
    flag(args, "app-slug") ??
    process.env.WAYFORM_GITHUB_APP_SLUG ??
    "memorylayer-gateway";
  return {
    owner: flag(args, "owner"),
    appSlug,
    gatewayUrl: (flag(args, "gateway") ?? DEFAULT_GATEWAY_URL).replace(
      /\/+$/,
      "",
    ),
  };
}

export async function runSpaceCreate(
  args: string[],
  deps: { log?: (msg: string) => void } = {},
): Promise<void> {
  const log = deps.log ?? ((m) => console.log(m));
  const parsed = parseSpaceCreateArgs(args);
  if (parsed.owner) {
    log(
      `Allowlist ${parsed.owner} (operator): curl -X POST ${parsed.gatewayUrl}/admin/allowlist -H "x-admin-secret: $ADMIN_SECRET" -H "content-type: application/json" -d '{"add":["${parsed.owner}"]}'`,
    );
  } else {
    log("Pass --owner <github-login-or-org> to print the allowlist command.");
  }
  log(
    `They install the App on their private memory repo: https://github.com/apps/${parsed.appSlug}`,
  );
  log(`MCP URL (send this, never a token): ${parsed.gatewayUrl}/mcp`);
}
