import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { DEFAULT_BUDGET_TOKENS } from "./token-budget.js";
function required(name) {
    const v = process.env[name];
    if (!v || v.trim() === "") {
        throw new Error(`Missing required env var ${name}. See README for MemoryLayer configuration.`);
    }
    return v.trim();
}
/**
 * The ONLY env keys `loadHookEnv` will set from the file. This is a security
 * allowlist, not just tidiness: `.memorylayer-hook.env` lives in a project repo
 * and can be attacker-controlled (a malicious repo could commit one despite the
 * gitignore). Since the hooks fire on opening any wired project and then spawn
 * `git`/`node` subprocesses, an unrestricted loader would let a crafted file
 * inject process-hijacking vars (NODE_OPTIONS, PATH, GIT_*, LD_PRELOAD, …) and
 * reach code execution. We only ever set MemoryLayer's own config keys.
 */
const HOOK_ENV_ALLOWLIST = new Set([
    "CONTEXT_REPO_URL",
    "CONTEXT_REPO_PATH",
    "MEMORYLAYER_AUTHOR",
    "MEMORYLAYER_AUTHOR_EMAIL",
    "MEMORYLAYER_PROJECT",
    "MEMORYLAYER_AUTO_PUSH",
    "MEMORYLAYER_HOOK_CLIENT",
    "MEMORYLAYER_READ_BUDGET_TOKENS",
    "MEMORYLAYER_GATEWAY_URL",
    "MEMORYLAYER_GATEWAY_TOKEN",
]);
/**
 * Load `.memorylayer-hook.env` (KEY=VALUE lines) from `cwd` into process.env,
 * for allowlisted keys NOT already set. This replaces the old bash launcher's
 * `set -a; . file` so the `memorylayer` command is self-contained. Called once
 * at the CLI entry point (cli.ts) so every subcommand sees it, while `loadConfig`
 * stays pure (env-only) and a directly-spawned `dist/hook.js` still fail-opens
 * with no config. Only keys in HOOK_ENV_ALLOWLIST are honored — everything else
 * (NODE_OPTIONS, PATH, …) is ignored, so an attacker-controlled file in a cloned
 * repo cannot hijack the git/node subprocesses the hooks spawn. Silent no-op if
 * the file is absent or unreadable — never throws.
 */
export function loadHookEnv(cwd = process.cwd()) {
    const file = path.join(cwd, ".memorylayer-hook.env");
    let text;
    try {
        text = fs.readFileSync(file, "utf8");
    }
    catch {
        return; // absent/unreadable — nothing to load.
    }
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#"))
            continue;
        const eq = line.indexOf("=");
        if (eq <= 0)
            continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (!HOOK_ENV_ALLOWLIST.has(key))
            continue; // ignore unknown/dangerous keys
        if (process.env[key] === undefined)
            process.env[key] = value;
    }
}
/**
 * Normalize a git remote URL to a stable identity: host+path only, lowercased,
 * credentials/token dropped, no trailing `.git` or slashes. So the same repo via
 * token-embedded HTTPS, bare HTTPS, or SSH maps to ONE identity — and a rotated
 * token never changes it (nor leaks into a derived directory name).
 */
export function normalizeRepoUrl(url) {
    let s = url.trim();
    const scp = /^[^/@]+@([^:/]+):(.+)$/.exec(s); // git@host:org/repo(.git)
    if (scp) {
        s = `${scp[1]}/${scp[2]}`;
    }
    else {
        try {
            const u = new URL(s);
            s = `${u.host}${u.pathname}`; // u.host excludes userinfo → token dropped
        }
        catch {
            // Not a parseable URL (e.g. a bare test token); fall through with s as-is.
        }
    }
    return s
        .toLowerCase()
        .replace(/\.git$/, "")
        .replace(/^\/+|\/+$/g, "");
}
/**
 * Filesystem-safe, collision-proof directory key for a repo's local clone:
 * `<repo-name-slug>-<hash8>`. The readable prefix aids humans browsing the
 * clones dir; the hash of the normalized URL guarantees uniqueness even when two
 * repo names slugify identically.
 */
export function cloneKey(repoUrl) {
    const normalized = normalizeRepoUrl(repoUrl);
    const hash = crypto
        .createHash("sha256")
        .update(normalized)
        .digest("hex")
        .slice(0, 8);
    const lastSeg = normalized.split("/").pop() || "repo";
    const slug = lastSeg.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
    return `${slug}-${hash}`;
}
/**
 * Base directory for MemoryLayer's local state, XDG-compliant. Clones live in
 * the DATA bucket (not cache): a clone can transiently hold unpushed commits
 * (the offline / selfHealPush path), so it must survive cache cleaners.
 * Resolution: MEMORYLAYER_HOME > $XDG_DATA_HOME/memorylayer > ~/.local/share/memorylayer.
 */
function dataHome() {
    const explicit = process.env.MEMORYLAYER_HOME?.trim();
    if (explicit)
        return explicit;
    const xdg = process.env.XDG_DATA_HOME?.trim();
    if (xdg)
        return path.join(xdg, "memorylayer");
    return path.join(os.homedir(), ".local", "share", "memorylayer");
}
/**
 * Default project/space name for the hooks when MEMORYLAYER_PROJECT is unset:
 * the current repo's directory name (the same default `init` writes). A repo
 * that has a valid CONTEXT_REPO_URL but a missing project env therefore lands in
 * its OWN namespace instead of silently colliding in another project's — the
 * previous hardcoded literal "memorylayer" quietly merged such a repo's entries
 * into the dogfood project's namespace. Slugging happens downstream in the
 * store; this returns the raw basename, and "unknown" only for a rootless cwd.
 */
export function defaultProject(cwd = process.cwd()) {
    return path.basename(cwd) || "unknown";
}
export function loadConfig() {
    const author = required("MEMORYLAYER_AUTHOR");
    const repoUrl = required("CONTEXT_REPO_URL");
    const repoPath = process.env.CONTEXT_REPO_PATH?.trim() ||
        path.join(dataHome(), "clones", cloneKey(repoUrl));
    const rawBudget = Number(process.env.MEMORYLAYER_READ_BUDGET_TOKENS);
    const readBudgetTokens = Number.isFinite(rawBudget) && rawBudget > 0
        ? rawBudget
        : DEFAULT_BUDGET_TOKENS;
    return {
        repoUrl,
        repoPath,
        author,
        authorEmail: process.env.MEMORYLAYER_AUTHOR_EMAIL?.trim() ||
            `${author.replace(/\s+/g, ".").toLowerCase()}@memorylayer.local`,
        autoPush: (process.env.MEMORYLAYER_AUTO_PUSH?.trim() || "true") !== "false",
        readBudgetTokens,
        gatewayUrl: process.env.MEMORYLAYER_GATEWAY_URL?.trim().replace(/\/+$/, "") ||
            undefined,
        gatewayToken: process.env.MEMORYLAYER_GATEWAY_TOKEN?.trim() || undefined,
    };
}
//# sourceMappingURL=config.js.map