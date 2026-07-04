import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
const PUSH_ATTEMPTS = 3;
const PUSH_RETRY_DELAY_MS = 25;
/**
 * Thin wrapper over the git plumbing the store needs: clone-if-absent, pull,
 * single-file commit with explicit authorship, and push with a rebase-retry.
 * It owns NO markdown, path, or projection logic — those live in the store and
 * frontmatter modules. Serialization of concurrent git operations is the
 * caller's responsibility (ContextStore holds the per-clone mutex).
 */
export class GitRepo {
    cfg;
    git;
    constructor(cfg) {
        this.cfg = cfg;
        this.git = simpleGit();
    }
    /** Clone the shared repo if absent, then pin the commit-author identity. */
    async ensure() {
        const { repoPath, repoUrl, author, authorEmail } = this.cfg;
        if (!existsSync(path.join(repoPath, ".git"))) {
            await fs.mkdir(path.dirname(repoPath), { recursive: true });
            await simpleGit().clone(repoUrl, repoPath);
        }
        this.git = simpleGit(repoPath);
        await this.reconcileOrigin(repoUrl);
        await this.git.addConfig("user.name", author);
        await this.git.addConfig("user.email", authorEmail);
    }
    async reconcileOrigin(repoUrl) {
        // Reconcile origin to the configured repoUrl every run: declared config is
        // the source of truth, so a mis-pointed clone (e.g. a shared path from an
        // older layout) or a rotated token self-corrects here instead of silently
        // pushing to the wrong remote. A manually-created .git may not have origin
        // yet, so add it instead of throwing during MCP startup.
        const remotes = await this.git.getRemotes(true);
        if (remotes.some((r) => r.name === "origin")) {
            await this.git.remote(["set-url", "origin", repoUrl]);
        }
        else {
            await this.git.addRemote("origin", repoUrl);
        }
    }
    async currentBranch() {
        return (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim() || "main";
    }
    /** Rebase-pull the latest. Silent on failure (empty remote/no upstream/offline). */
    async pull() {
        try {
            const branch = await this.currentBranch();
            await this.git.pull("origin", branch, ["--rebase"]);
        }
        catch {
            // Empty remote, no upstream yet, or offline: local reads/writes still work.
        }
    }
    /**
     * Stage and commit exactly one file under a specific author. The explicit
     * pathspec keeps a concurrent write's staged file out of this commit.
     */
    async commitFile(relFile, message, authorName, authorEmail) {
        await this.git.add(relFile);
        await this.git.commit(message, relFile, {
            "--author": `${authorName} <${authorEmail}>`,
        });
    }
    /**
     * Push, or if rejected (non-fast-forward/offline) rebase on latest and retry
     * once. Per-author files make the rebase clean. Throws an honest error if it
     * still can't reach the remote, so the caller can tell the user it's local-only.
     */
    async push() {
        if (!this.cfg.autoPush)
            return;
        const branch = await this.currentBranch();
        let lastError;
        for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
            try {
                if (attempt > 0) {
                    await delay(PUSH_RETRY_DELAY_MS * 2 ** (attempt - 1));
                }
                await this.git.push(["-u", "origin", branch]);
                return;
            }
            catch (err) {
                lastError = err;
            }
            try {
                await this.git.pull("origin", branch, ["--rebase"]);
            }
            catch (err) {
                lastError = err;
            }
        }
        throw new Error(`Recorded locally, NOT shared yet — push failed, will retry on the ` +
            `next read/write: ${redactSecrets(String(lastError.message ?? lastError))}`);
    }
    /**
     * Best-effort push of anything committed locally but not yet on the remote.
     * Called from a read so a write whose push failed earlier still reaches
     * collaborators. Silent on failure — it stays local and retries next read.
     */
    async selfHealPush() {
        if (!this.cfg.autoPush)
            return;
        try {
            await this.push();
        }
        catch {
            // Still offline / unauthorized: entry remains local, retried next read.
        }
    }
    /** Untracked files under a pathspec, relative to repo root. */
    async untrackedFiles(pathspec) {
        const raw = await this.git.raw([
            "ls-files",
            "--others",
            "--exclude-standard",
            "--",
            pathspec,
        ]);
        return raw
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
    }
    /**
     * Return the committer date of the commit that first introduced each file.
     * The read path uses this as git-integrated order, avoiding wall-clock skew
     * in entry frontmatter from different machines.
     */
    async firstCommitDates(pathspec) {
        const raw = await this.git.raw([
            "log",
            "--diff-filter=A",
            "--name-only",
            "--format=__ML_COMMIT__%cI",
            "--",
            pathspec,
        ]);
        const out = new Map();
        let currentDate = "";
        for (const rawLine of raw.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line)
                continue;
            if (line.startsWith("__ML_COMMIT__")) {
                currentDate = line.slice("__ML_COMMIT__".length);
            }
            else if (currentDate && !out.has(line)) {
                out.set(line, currentDate);
            }
        }
        return out;
    }
}
function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function redactSecrets(message) {
    return message.replace(/(https?:\/\/)([^@\s/]+)@/g, "$1***@");
}
//# sourceMappingURL=git-repo.js.map