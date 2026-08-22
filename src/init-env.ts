import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexHookTrust, mergeCodexTrustToml } from "./init-configs.js";

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

/** Contents of `.memorylayer-hook.env` for a HOSTED (gateway) member. */
export function buildRemoteHookEnv(v: {
  gatewayUrl: string;
  project: string;
  author: string;
  email: string;
}): string {
  return [
    "# Wayform per-user hook config. URL + identity only — no gateway token.",
    "# Written by `wayform init --remote`. Run `wayform login` once per machine.",
    `MEMORYLAYER_GATEWAY_URL=${v.gatewayUrl}`,
    `MEMORYLAYER_PROJECT=${v.project}`,
    `MEMORYLAYER_AUTHOR=${v.author}`,
    `MEMORYLAYER_AUTHOR_EMAIL=${v.email}`,
    "",
  ].join("\n");
}

/**
 * Trust our just-written Codex hooks in the user-global codex config.toml —
 * without this codex skips them silently (see codexHookTrust). Honors
 * CODEX_HOME like codex itself. LOUD on write failure, same as the rest of
 * init: an untrusted hook is exactly the half-written setup that must surface.
 */
export function trustCodexHooks(cwd: string, mergedHooksJson: unknown): void {
  let real = cwd;
  try {
    real = fs.realpathSync(cwd); // codex keys trust by canonical path
  } catch {
    // keep cwd as-is; realpath only fails if the dir just vanished
  }
  const entries = codexHookTrust(
    (mergedHooksJson ?? {}) as Record<string, unknown>,
    path.join(real, ".codex", "hooks.json"),
  );
  if (entries.length === 0) return;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const cfg = path.join(codexHome, "config.toml");
  const existing = fs.existsSync(cfg) ? fs.readFileSync(cfg, "utf8") : "";
  const next = mergeCodexTrustToml(existing, entries);
  if (next !== existing) {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(cfg, next);
    console.log(`  trusted Codex hooks in ${cfg}`);
  }
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
