import os from "node:os";
import path from "node:path";
import fs from "node:fs";

/**
 * MemoryLayer v1 configuration, read from the environment.
 *
 * The "shared key" from the spec is realized as git access to the shared
 * context repo (a private repo URL with an embedded token, or SSH). We do not
 * build a separate auth layer: no accounts, git authorship is the attribution.
 */
export interface Config {
  /** URL of the shared context git repo (may embed a token for HTTPS auth). */
  repoUrl: string;
  /** Local path where the shared repo is cloned. */
  repoPath: string;
  /** Author name used for commit authorship (the attribution). */
  author: string;
  /** Author email for commit authorship. */
  authorEmail: string;
  /** Push after each write. Off is useful for local smoke tests without a remote. */
  autoPush: boolean;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required env var ${name}. See README for MemoryLayer configuration.`,
    );
  }
  return v.trim();
}

/**
 * Load `.memorylayer-hook.env` (KEY=VALUE lines) from `cwd` into process.env,
 * for keys NOT already set. This replaces the old bash launcher's `set -a; . file`
 * so the `memorylayer` command is self-contained. Called once at the CLI entry
 * point (cli.ts) so every subcommand sees it, while `loadConfig` stays pure
 * (env-only) and a directly-spawned `dist/hook.js` still fail-opens with no config.
 * Silent no-op if the file is absent or unreadable — never throws.
 */
export function loadHookEnv(cwd: string = process.cwd()): void {
  const file = path.join(cwd, ".memorylayer-hook.env");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return; // absent/unreadable — nothing to load.
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadConfig(): Config {
  const author = required("MEMORYLAYER_AUTHOR");
  const repoPath =
    process.env.CONTEXT_REPO_PATH?.trim() ||
    path.join(os.homedir(), ".memorylayer", "context-store");

  return {
    repoUrl: required("CONTEXT_REPO_URL"),
    repoPath,
    author,
    authorEmail:
      process.env.MEMORYLAYER_AUTHOR_EMAIL?.trim() ||
      `${author.replace(/\s+/g, ".").toLowerCase()}@memorylayer.local`,
    autoPush: (process.env.MEMORYLAYER_AUTO_PUSH?.trim() || "true") !== "false",
  };
}
