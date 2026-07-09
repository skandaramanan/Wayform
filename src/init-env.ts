import { execFileSync } from "node:child_process";

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
