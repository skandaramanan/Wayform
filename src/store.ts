import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { simpleGit, type SimpleGit } from "simple-git";
import type { Config } from "./config.js";

export type EntryType = "decision" | "context";

export interface WriteEntry {
  author: string;
  type: EntryType;
  payload: string;
}

export interface ParsedEntry {
  author: string;
  type: EntryType;
  timestamp: string;
  id: string;
  payload: string;
  file: string;
}

/**
 * Collapse arbitrary text to a filesystem-safe slug. Also the path-traversal
 * guard: stripping every non-alphanumeric run means "../../etc" -> "etc", so a
 * hostile project/author name can never escape the context/ directory.
 */
export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "unknown"
  );
}

function fsSafeTimestamp(iso: string): string {
  return iso.replace(/[:.]/g, "-");
}

/**
 * Git-backed context store. Git is the consistency layer: append-only log,
 * immutable commits, per-write attribution via commit authorship. Each write is
 * its own file under context/<project>/<author>/, so concurrent writers never
 * touch the same file and never produce a merge conflict.
 */
export class ContextStore {
  private git: SimpleGit;
  // Serializes every git-touching operation for this clone. Two concurrent
  // write()s (or a read racing a write) would otherwise collide on
  // .git/index.lock, since each git command is a separate child process.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private cfg: Config) {
    this.git = simpleGit();
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
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

  private projectDir(project: string): string {
    return path.join("context", slug(project));
  }

  /** Email used for a given author: the configured one for the owner, else derived. */
  private emailFor(author: string): string {
    return author === this.cfg.author
      ? this.cfg.authorEmail
      : `${slug(author)}@memorylayer.local`;
  }

  /** Append a decision/context entry as its own file, commit it, and push. */
  write(project: string, entry: WriteEntry): Promise<ParsedEntry> {
    return this.serialize(() => this.writeImpl(project, entry));
  }

  private async writeImpl(project: string, entry: WriteEntry): Promise<ParsedEntry> {
    await this.pull();

    const timestamp = new Date().toISOString();
    const id = randomUUID().slice(0, 8);
    const authorEmail = this.emailFor(entry.author);
    const relDir = path.join(this.projectDir(project), slug(entry.author));
    const relFile = path.join(relDir, `${fsSafeTimestamp(timestamp)}-${id}.md`);
    const absFile = path.join(this.cfg.repoPath, relFile);

    const contents =
      `---\n` +
      `author: ${entry.author}\n` +
      `type: ${entry.type}\n` +
      `timestamp: ${timestamp}\n` +
      `id: ${id}\n` +
      `project: ${project}\n` +
      `---\n\n` +
      `${entry.payload.trim()}\n`;

    await fs.mkdir(path.dirname(absFile), { recursive: true });
    await fs.writeFile(absFile, contents, "utf8");

    // Commit ONLY this file (explicit pathspec). Without it, a second concurrent
    // write()'s staged file could be swept into this commit under one author.
    await this.git.add(relFile);
    await this.git.commit(
      `${entry.type}(${slug(project)}): ${firstLine(entry.payload)}`,
      relFile,
      { "--author": `${entry.author} <${authorEmail}>` },
    );
    await this.push();

    return {
      author: entry.author,
      type: entry.type,
      timestamp,
      id,
      payload: entry.payload.trim(),
      file: relFile,
    };
  }

  /**
   * Pull latest, gather a project's entries in write order, and return the most
   * recent `limit` of them plus the total count. Capping keeps a read from
   * flooding the agent's context as the store grows (which would make agents
   * skip reads and break the "already there, unpasted" loop).
   *
   * Also self-heals: pushes any decision committed locally but not yet shared
   * (e.g. a prior write whose push failed while offline), so a stranded entry
   * reaches collaborators on the next read instead of never.
   */
  read(
    project: string,
    limit = 30,
  ): Promise<{ entries: ParsedEntry[]; total: number }> {
    return this.serialize(() => this.readImpl(project, limit));
  }

  private async readImpl(
    project: string,
    limit: number,
  ): Promise<{ entries: ParsedEntry[]; total: number }> {
    await this.pull();
    await this.selfHealPush();

    const absDir = path.join(this.cfg.repoPath, this.projectDir(project));
    if (!existsSync(absDir)) return { entries: [], total: 0 };

    const files = await collectMarkdown(absDir);
    const entries: ParsedEntry[] = [];
    for (const abs of files) {
      const raw = await fs.readFile(abs, "utf8");
      const parsed = parseEntry(raw, path.relative(this.cfg.repoPath, abs));
      if (parsed) entries.push(parsed);
    }

    entries.sort((a, b) =>
      a.timestamp === b.timestamp
        ? a.file.localeCompare(b.file)
        : a.timestamp.localeCompare(b.timestamp),
    );

    const total = entries.length;
    const capped =
      limit > 0 && total > limit ? entries.slice(total - limit) : entries;
    return { entries: capped, total };
  }

  private async currentBranch(): Promise<string> {
    return (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim() || "main";
  }

  private async pull(): Promise<void> {
    try {
      const branch = await this.currentBranch();
      await this.git.pull("origin", branch, ["--rebase"]);
    } catch {
      // Empty remote, no upstream yet, or offline: reads/writes still work
      // locally. The failure mode is documented rather than engineered around.
    }
  }

  private async push(): Promise<void> {
    if (!this.cfg.autoPush) return;
    const branch = await this.currentBranch();
    try {
      await this.git.push(["-u", "origin", branch]);
    } catch {
      // Non-fast-forward or offline: rebase on latest and retry once. Per-author
      // files mean the rebase is always clean.
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
   * Called from read() so a write whose push failed earlier still reaches
   * collaborators. Silent on failure — it stays local and retries next read.
   */
  private async selfHealPush(): Promise<void> {
    if (!this.cfg.autoPush) return;
    try {
      await this.push();
    } catch {
      // Still offline / unauthorized: entry remains local, retried next read.
    }
  }
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0].slice(0, 72);
}

async function collectMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await collectMarkdown(abs)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(abs);
    }
  }
  return out;
}

export function parseEntry(raw: string, file: string): ParsedEntry | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const front = Object.fromEntries(
    match[1]
      .split("\n")
      .map((line) => {
        const idx = line.indexOf(":");
        return idx === -1
          ? null
          : [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
      })
      .filter((x): x is [string, string] => x !== null),
  );

  if (!front.timestamp || !front.author) return null;
  return {
    author: front.author,
    type: (front.type as EntryType) || "context",
    timestamp: front.timestamp,
    id: front.id || "",
    payload: match[2].trim(),
    file,
  };
}
