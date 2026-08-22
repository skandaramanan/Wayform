import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SERVICE = "wayform-oauth";

function fileStorePath(): string {
  if (process.env.WAYFORM_KEYCHAIN_FILE?.trim()) {
    return process.env.WAYFORM_KEYCHAIN_FILE.trim();
  }
  const home = process.env.MEMORYLAYER_HOME?.trim();
  const dir = home
    ? path.join(home, "keychain")
    : path.join(os.homedir(), ".local", "share", "wayform");
  return path.join(dir, "oauth.json");
}

function readFileStore(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(fileStorePath(), "utf8")) as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}

function writeFileStore(map: Record<string, string>): void {
  const file = fileStorePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(map), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort on non-POSIX
  }
}

function useFileStore(): boolean {
  return (
    Boolean(process.env.WAYFORM_KEYCHAIN_FILE) || process.platform !== "darwin"
  );
}

export function keychainGet(account: string): string | null {
  if (useFileStore()) {
    return readFileStore()[account] ?? null;
  }
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", SERVICE, "-a", account, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    return null;
  }
}

export function keychainSet(account: string, secret: string): void {
  if (useFileStore()) {
    const map = readFileStore();
    map[account] = secret;
    writeFileStore(map);
    return;
  }
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-s", SERVICE, "-a", account],
      { stdio: "ignore" },
    );
  } catch {
    // nothing to delete
  }
  execFileSync(
    "security",
    ["add-generic-password", "-s", SERVICE, "-a", account, "-w", secret],
    { stdio: "ignore" },
  );
}

export function keychainDelete(account: string): void {
  if (useFileStore()) {
    const map = readFileStore();
    delete map[account];
    writeFileStore(map);
    return;
  }
  try {
    execFileSync(
      "security",
      ["delete-generic-password", "-s", SERVICE, "-a", account],
      { stdio: "ignore" },
    );
  } catch {
    // already gone
  }
}

export interface StoredOAuth {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_endpoint?: string;
}

export function gatewayAccount(gatewayUrl: string): string {
  return gatewayUrl.replace(/\/+$/, "");
}

export function loadStoredOAuth(gatewayUrl: string): StoredOAuth | null {
  const raw = keychainGet(gatewayAccount(gatewayUrl));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredOAuth;
  } catch {
    return null;
  }
}

export function saveStoredOAuth(gatewayUrl: string, tokens: StoredOAuth): void {
  keychainSet(gatewayAccount(gatewayUrl), JSON.stringify(tokens));
}

/** Put a short-lived access token into process.env for this process only. */
export function hydrateGatewayTokenFromKeychain(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.MEMORYLAYER_GATEWAY_TOKEN?.trim()) return;
  const url = env.MEMORYLAYER_GATEWAY_URL?.trim().replace(/\/+$/, "");
  if (!url) return;
  const stored = loadStoredOAuth(url);
  if (stored?.access_token) env.MEMORYLAYER_GATEWAY_TOKEN = stored.access_token;
}
