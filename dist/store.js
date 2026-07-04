import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GitRepo } from "./git-repo.js";
import { serializeEntry, parseEntry, } from "./frontmatter.js";
import { estimateTokens, DEFAULT_BUDGET_TOKENS, ENTRY_OVERHEAD_TOKENS, } from "./token-budget.js";
/** Length of the random id suffix appended to an entry's timestamped filename. */
const ID_LENGTH = 8;
/** Max length of the commit-subject summary derived from a payload's first line. */
const COMMIT_SUBJECT_MAX = 72;
/**
 * Collapse arbitrary text to a filesystem-safe slug. Also the path-traversal
 * guard: stripping every non-alphanumeric run means "../../etc" -> "etc", so a
 * hostile project/author name can never escape the context/ directory.
 */
export function slug(s) {
    return (s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "unknown");
}
function fsSafeTimestamp(iso) {
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
    cfg;
    repo;
    // Serializes every git-touching operation for this clone. Two concurrent
    // write()s (or a read racing a write) would otherwise collide on
    // .git/index.lock, since each git command is a separate child process.
    queue = Promise.resolve();
    constructor(cfg) {
        this.cfg = cfg;
        this.repo = new GitRepo(cfg);
    }
    serialize(fn) {
        const run = this.queue.then(fn, fn);
        this.queue = run.catch(() => undefined);
        return run;
    }
    /** Clone the shared repo if absent and pin the commit-author identity. */
    async ensure() {
        await this.repo.ensure();
    }
    projectDir(project) {
        return path.join("context", slug(project));
    }
    /** Email used for a given author: the configured one for the owner, else derived. */
    emailFor(author) {
        return author === this.cfg.author
            ? this.cfg.authorEmail
            : `${slug(author)}@memorylayer.local`;
    }
    /** Append a decision/context entry as its own file, commit it, and push. */
    write(project, entry) {
        return this.serialize(() => this.writeImpl(project, entry));
    }
    async writeImpl(project, entry) {
        await this.repo.pull();
        await this.reconcileOrphanedEntries();
        const timestamp = new Date().toISOString();
        const id = randomUUID().slice(0, ID_LENGTH);
        const authorEmail = this.emailFor(entry.author);
        const relDir = path.join(this.projectDir(project), slug(entry.author));
        const relFile = path.join(relDir, `${fsSafeTimestamp(timestamp)}-${id}.md`);
        const absFile = path.join(this.cfg.repoPath, relFile);
        const contents = serializeEntry({ author: entry.author, type: entry.type, timestamp, id, project }, entry.payload);
        await fs.mkdir(path.dirname(absFile), { recursive: true });
        await fs.writeFile(absFile, contents, "utf8");
        await this.repo.commitFile(relFile, `${entry.type}(${slug(project)}): ${firstLine(entry.payload)}`, entry.author, authorEmail);
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
     * Pull latest, gather a project's entries in write order, and return as
     * many of the most recent ones as fit `budgetTokens` plus the total count.
     * Packing to a token budget (rather than a fixed entry count) keeps a read
     * from flooding the agent's context as the store grows — long entries cost
     * more of the budget than short ones — which would otherwise make agents
     * skip reads and break the "already there, unpasted" loop.
     *
     * Also self-heals: pushes any decision committed locally but not yet shared
     * (e.g. a prior write whose push failed while offline), so a stranded entry
     * reaches collaborators on the next read instead of never.
     */
    read(project, budgetTokens = DEFAULT_BUDGET_TOKENS) {
        return this.serialize(() => this.readImpl(project, budgetTokens));
    }
    async readImpl(project, budgetTokens) {
        await this.repo.pull();
        await this.reconcileOrphanedEntries();
        await this.repo.selfHealPush();
        const absDir = path.join(this.cfg.repoPath, this.projectDir(project));
        if (!existsSync(absDir))
            return { entries: [], total: 0 };
        const files = await collectMarkdown(absDir);
        const entries = [];
        for (const abs of files) {
            const raw = await fs.readFile(abs, "utf8");
            const parsed = parseEntry(raw, path.relative(this.cfg.repoPath, abs));
            if (parsed)
                entries.push(parsed);
        }
        const commitDates = await this.repo.firstCommitDates(this.projectDir(project));
        entries.sort((a, b) => compareEntries(a, b, commitDates));
        return {
            entries: packToBudget(entries, budgetTokens),
            total: entries.length,
        };
    }
    async reconcileOrphanedEntries() {
        const files = (await this.repo.untrackedFiles("context")).filter((file) => file.endsWith(".md"));
        for (const relFile of files) {
            const absFile = path.join(this.cfg.repoPath, relFile);
            const raw = await fs.readFile(absFile, "utf8");
            const parsed = parseEntry(raw, relFile);
            if (!parsed)
                continue;
            const project = relFile.split("/")[1] || "unknown";
            await this.repo.commitFile(relFile, `${parsed.type}(${project}): ${firstLine(parsed.payload)}`, parsed.author, this.emailFor(parsed.author));
        }
    }
    /**
     * Commit and best-effort push the caller's metrics append log (written by
     * recordMetric). Runs inside the same per-clone git mutex as read/write so
     * metrics git never races entry git on .git/index.lock. Called ONLY after a
     * write — it carries every read metric appended since the last write in one
     * commit ("append local, flush on next write"). Best-effort: swallows errors
     * so a failed push never surfaces on the write path; unpushed lines ride the
     * next flush (or a read's selfHealPush). No-op if nothing was recorded.
     */
    flushMetrics() {
        return this.serialize(() => this.flushMetricsImpl());
    }
    async flushMetricsImpl() {
        const relFile = path.join("metrics", `${slug(this.cfg.author)}.jsonl`);
        const absFile = path.join(this.cfg.repoPath, relFile);
        if (!existsSync(absFile))
            return; // nothing recorded yet
        try {
            await this.repo.commitFile(relFile, `metrics: sync ${slug(this.cfg.author)}`, this.cfg.author, this.cfg.authorEmail);
            await this.repo.push();
        }
        catch {
            // Best-effort: unpushed metrics ride the next flush / read selfHealPush.
        }
    }
}
function firstLine(s) {
    return s.trim().split("\n")[0].slice(0, COMMIT_SUBJECT_MAX);
}
function compareEntries(a, b, commitDates) {
    const aOrder = commitDates.get(a.file) || a.timestamp;
    const bOrder = commitDates.get(b.file) || b.timestamp;
    return aOrder === bOrder
        ? a.file.localeCompare(b.file)
        : aOrder.localeCompare(bOrder);
}
/**
 * Select the most recent entries that fit `budgetTokens`, walking newest to
 * oldest. Always keeps at least the single most recent entry — an oversized
 * entry beats an empty read. `budgetTokens <= 0` means unlimited (returns
 * every entry), preserving the old count-cap's `limit <= 0` escape hatch.
 */
function packToBudget(entries, budgetTokens) {
    if (budgetTokens <= 0 || entries.length === 0)
        return entries;
    const selected = [];
    let used = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        const cost = estimateTokens(entries[i].payload) + ENTRY_OVERHEAD_TOKENS;
        if (selected.length > 0 && used + cost > budgetTokens)
            break;
        selected.push(entries[i]);
        used += cost;
    }
    return selected.reverse();
}
async function collectMarkdown(dir) {
    const out = [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
            out.push(...(await collectMarkdown(abs)));
        }
        else if (e.isFile() && e.name.endsWith(".md")) {
            out.push(abs);
        }
    }
    return out;
}
//# sourceMappingURL=store.js.map