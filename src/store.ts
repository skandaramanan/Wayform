import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { GitRepo } from "./git-repo.js";
import {
  serializeEntry,
  parseEntry,
  type WriteEntry,
  type ParsedEntry,
} from "./frontmatter.js";

// Re-exported so existing importers (index.ts, context-format.ts, tests) keep a
// single stable surface even though the entry types now live in frontmatter.ts.
export type { EntryType, WriteEntry, ParsedEntry } from "./frontmatter.js";

/** Most recent entries a read returns; caps context bloat as the store grows. */
const DEFAULT_READ_LIMIT = 30;
/** Length of the random id suffix appended to an entry's timestamped filename. */
const ID_LENGTH = 8;
/** Max length of the commit-subject summary derived from a payload's first line. */
const COMMIT_SUBJECT_MAX = 72;

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
 * Git-backed context store. Git is the consistency layer (append-only log,
 * immutable commits, per-write attribution). This class owns orchestration and
 * path/identity logic; git plumbing lives in GitRepo and the entry markdown
 * format in frontmatter.ts. Each write is its own file under
 * context/<project>/<author>/, so concurrent writers never touch the same file.
 */
export class ContextStore {
  private repo: GitRepo;
  // Serializes every git-touching operation for this clone. Two concurrent
  // write()s (or a read racing a write) would otherwise collide on
  // .git/index.lock, since each git command is a separate child process.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private cfg: Config) {
    this.repo = new GitRepo(cfg);
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Clone the shared repo if absent and pin the commit-author identity. */
  async ensure(): Promise<void> {
    await this.repo.ensure();
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

  private async writeImpl(
    project: string,
    entry: WriteEntry,
  ): Promise<ParsedEntry> {
    await this.repo.pull();

    const timestamp = new Date().toISOString();
    const id = randomUUID().slice(0, ID_LENGTH);
    const authorEmail = this.emailFor(entry.author);
    const relDir = path.join(this.projectDir(project), slug(entry.author));
    const relFile = path.join(relDir, `${fsSafeTimestamp(timestamp)}-${id}.md`);
    const absFile = path.join(this.cfg.repoPath, relFile);

    const contents = serializeEntry(
      { author: entry.author, type: entry.type, timestamp, id, project },
      entry.payload,
    );

    await fs.mkdir(path.dirname(absFile), { recursive: true });
    await fs.writeFile(absFile, contents, "utf8");

    await this.repo.commitFile(
      relFile,
      `${entry.type}(${slug(project)}): ${firstLine(entry.payload)}`,
      entry.author,
      authorEmail,
    );
    await this.repo.push();

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
    limit = DEFAULT_READ_LIMIT,
  ): Promise<{ entries: ParsedEntry[]; total: number }> {
    return this.serialize(() => this.readImpl(project, limit));
  }

  private async readImpl(
    project: string,
    limit: number,
  ): Promise<{ entries: ParsedEntry[]; total: number }> {
    await this.repo.pull();
    await this.repo.selfHealPush();

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
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0].slice(0, COMMIT_SUBJECT_MAX);
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
