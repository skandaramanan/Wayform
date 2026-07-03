import { execFileSync } from "node:child_process";
/** Contents of the per-user, gitignored .memorylayer-hook.env file. */
export function buildHookEnv(v) {
    return [
        "# MemoryLayer per-user hook config — gitignored. Do NOT commit.",
        "# Written by `memorylayer init`. Your identity + context-repo access.",
        `CONTEXT_REPO_URL=${v.repoUrl}`,
        `MEMORYLAYER_AUTHOR=${v.author}`,
        `MEMORYLAYER_AUTHOR_EMAIL=${v.email}`,
        `MEMORYLAYER_PROJECT=${v.project}`,
        "",
    ].join("\n");
}
/** Read a git config value for a prompt default; "" if git/key is absent. */
export function gitConfigDefault(key) {
    try {
        return execFileSync("git", ["config", "--get", key], {
            encoding: "utf8",
        }).trim();
    }
    catch {
        return "";
    }
}
/** Append each missing entry to .gitignore content exactly once. */
export function ensureGitignore(existing, entries) {
    const lines = existing.split(/\r?\n/).map((l) => l.trim());
    let out = existing.endsWith("\n") || existing === "" ? existing : existing + "\n";
    for (const entry of entries) {
        if (!lines.includes(entry))
            out += `${entry}\n`;
    }
    return out;
}
//# sourceMappingURL=init-env.js.map