import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { Config } from "./config.js";

/**
 * Thin wrapper over the git plumbing the store needs: clone-if-absent, pull,
 * single-file commit with explicit authorship, and push with a rebase-retry.
 * It owns NO markdown, path, or projection logic — those live in the store and
 * frontmatter modules. Serialization of concurrent git operations is the
 * caller's responsibility (ContextStore holds the per-clone mutex).
 */
export class GitRepo {
  private git: SimpleGit;

  constructor(private cfg: Config) {
    this.git = simpleGit();
  }

  /** Clone the shared repo if absent, then pin the commit-author identity. */
  async ensure(): Promise<void> {
    const { repoPath, repoUrl, author, authorEmail } = this.cfg;

    if (!existsSync(path.join(repoPath, ".git"))) {
      await fs.mkdir(path.dirname(repoPath), { recursive: true });
      await simpleGit().clone(repoUrl, repoPath);
    }

    this.git = simpleGit(repoPath);
    await this.git.addConfig("user.name", author);
    await this.git.addConfig("user.email", authorEmail);
  }

  private async currentBranch(): Promise<string> {
    return (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim() || "main";
  }

  /** Rebase-pull the latest. Silent on failure (empty remote/no upstream/offline). */
  async pull(): Promise<void> {
    try {
      const branch = await this.currentBranch();
      await this.git.pull("origin", branch, ["--rebase"]);
    } catch {
      // Empty remote, no upstream yet, or offline: local reads/writes still work.
    }
  }

  /**
   * Stage and commit exactly one file under a specific author. The explicit
   * pathspec keeps a concurrent write's staged file out of this commit.
   */
  async commitFile(
    relFile: string,
    message: string,
    authorName: string,
    authorEmail: string,
  ): Promise<void> {
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
  async push(): Promise<void> {
    if (!this.cfg.autoPush) return;
    const branch = await this.currentBranch();
    try {
      await this.git.push(["-u", "origin", branch]);
    } catch {
      try {
        await this.git.pull("origin", branch, ["--rebase"]);
        await this.git.push(["-u", "origin", branch]);
      } catch (err) {
        throw new Error(
          `Recorded locally, NOT shared yet — push failed, will retry on the ` +
            `next read/write: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Best-effort push of anything committed locally but not yet on the remote.
   * Called from a read so a write whose push failed earlier still reaches
   * collaborators. Silent on failure — it stays local and retries next read.
   */
  async selfHealPush(): Promise<void> {
    if (!this.cfg.autoPush) return;
    try {
      await this.push();
    } catch {
      // Still offline / unauthorized: entry remains local, retried next read.
    }
  }
}
