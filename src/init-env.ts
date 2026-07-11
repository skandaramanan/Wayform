import { execFileSync } from "node:child_process";
import fs from "node:fs";

/**
 * Write a secret-bearing file (identity env / token-carrying MCP config) with
 * owner-only perms (0600). writeFileSync only applies `mode` on CREATE, so an
 * older file left at the umask default (0644, world-readable) would keep loose
 * perms on a rewrite — the explicit chmod retro-tightens it. Best-effort on
 * filesystems without POSIX perms (Windows/NTFS): the chmod no-ops there, which
 * is fine since the multi-UID threat model is a POSIX host.
 */
export function writeSecretFile(file: string, contents: string): void {
  fs.writeFileSync(file, contents, { mode: 0o600 });
  hardenSecretFile(file);
}

/** Tighten an existing secret file to 0600 without rewriting its contents. */
export function hardenSecretFile(file: string): void {
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best-effort: no POSIX perms (Windows) or file vanished — nothing to do.
  }
}

/** Contents of the per-user, gitignored .memorylayer-hook.env file. */
export function buildHookEnv(v: {
  author: string;
  email: string;
  repoUrl: string;
  project: string;
}): string {
  return [
    "# Wayform per-user hook config — gitignored. Do NOT commit.",
    "# Written by `wayform init`. Your identity + context-repo access.",
    `CONTEXT_REPO_URL=${v.repoUrl}`,
    `MEMORYLAYER_AUTHOR=${v.author}`,
    `MEMORYLAYER_AUTHOR_EMAIL=${v.email}`,
    `MEMORYLAYER_PROJECT=${v.project}`,
    "",
  ].join("\n");
}

/** Contents of `.memorylayer-hook.env` for a HOSTED (gateway) member — gitignored. */
export function buildRemoteHookEnv(v: {
  gatewayUrl: string;
  token: string;
  project: string;
  author: string;
  email: string;
}): string {
  return [
    "# Wayform per-user hook config — gitignored. Do NOT commit.",
    "# Written by `wayform init --remote`. Hosted (gateway) member — no local clone.",
    `MEMORYLAYER_GATEWAY_URL=${v.gatewayUrl}`,
    `MEMORYLAYER_GATEWAY_TOKEN=${v.token}`,
    `MEMORYLAYER_PROJECT=${v.project}`,
    `MEMORYLAYER_AUTHOR=${v.author}`,
    `MEMORYLAYER_AUTHOR_EMAIL=${v.email}`,
    "",
  ].join("\n");
}

/** Read a git config value for a prompt default; "" if git/key is absent. */
export function gitConfigDefault(key: "user.name" | "user.email"): string {
  try {
    return execFileSync("git", ["config", "--get", key], {
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

/** Append each missing entry to .gitignore content exactly once. */
export function ensureGitignore(existing: string, entries: string[]): string {
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  let out =
    existing.endsWith("\n") || existing === "" ? existing : existing + "\n";
  for (const entry of entries) {
    if (!lines.includes(entry)) out += `${entry}\n`;
  }
  return out;
}
