import os from "node:os";
import path from "node:path";

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
