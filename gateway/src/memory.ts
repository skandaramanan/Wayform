/**
 * Memory service (docs/PLAN.md Phase 0.3): the shared-memory operations every
 * transport calls — MCP tools (mcp.ts), the HTTP read API (api-read.ts), and
 * the desktop app later. Transports parse arguments and render; everything
 * that touches the ledger, the index or the caches lives here. A thrown Error
 * is a user-facing failure the transport reports as-is.
 */
import type { Env, HandlerCtx } from "./env.js";
import type { SpaceMember } from "./tenancy.js";
import {
  readEntriesCached,
  warmRecencyCache,
  writeEntry,
} from "./github-store.js";
import { projectContext } from "../../src/context-format.js";
import { slug } from "../../src/slug.js";
import { DEFAULT_BUDGET_TOKENS } from "../../src/token-budget.js";
import type { EntryType, ParsedEntry } from "../../src/frontmatter.js";
import { indexDeps } from "./deps.js";
import {
  retrieve,
  renderSearchResults,
  SEARCH_MAX_FACTS,
} from "./retrieval.js";
import { ingestEntries } from "./ingest.js";
import { clientFacts } from "./extract.js";
import {
  detectWriteConflicts,
  formatDuplicateResult,
  formatWriteResult,
  type WriteCheck,
} from "./supersede.js";

/** Who is calling, and the request's waitUntil when there is one. */
export interface Caller {
  env: Env;
  member: SpaceMember;
  ctx?: HandlerCtx;
}

export const fetchOf = (env: Env): typeof fetch => env.githubFetch ?? fetch;

/** Cache key for /hook/read's per-space projection cache. */
export function hookCacheKey(space: string, project: string): string {
  return `hookread:${space}:${slug(project)}`;
}

/** Run now, or after the response when the runtime gives us waitUntil. */
async function later(c: Caller, work: Promise<unknown>): Promise<void> {
  if (c.ctx) c.ctx.waitUntil(work);
  else await work;
}

/**
 * Cache discipline after any new ledger entry (write_context, plan ship): the
 * hook projection must rebuild; recency is warmed (not deleted) so the next
 * queryless read never pays a cold GitHub fan-out.
 */
export async function afterEntryWritten(
  c: Caller,
  project: string,
  entry: ParsedEntry,
): Promise<void> {
  try {
    await c.env.ROUTING.delete(hookCacheKey(c.member.space, project));
    const { refresh } = await warmRecencyCache(
      c.env,
      c.member,
      project,
      entry,
      fetchOf(c.env),
    );
    await later(c, refresh);
  } catch {
    // swallow: stale/missing cache heals via TTL or next warm
  }
}

/**
 * Query present → the retrieval pipeline over the whole indexed history;
 * absent (or the index failing) → the recency read. Fail-open by design.
 */
export async function readMemory(
  c: Caller,
  a: {
    project: string;
    query?: string;
    budgetTokens?: number;
    kinds?: string[];
    trigger: string;
  },
): Promise<{ text: string; total: number; matched: number }> {
  const budget =
    a.budgetTokens && a.budgetTokens > 0
      ? a.budgetTokens
      : DEFAULT_BUDGET_TOKENS;
  const query = a.query?.trim() ?? "";
  const deps = indexDeps(c.env);
  if (query && deps) {
    try {
      const { results, total } = await retrieve(deps, {
        space: c.member.space,
        project: slug(a.project),
        query,
        budgetTokens: budget,
        kinds: a.kinds,
        trigger: a.trigger,
      });
      return {
        text: renderSearchResults(a.project, query, results, total),
        total,
        matched: results.length,
      };
    } catch {
      // fail-open to the recency read below
    }
  }
  const { entries, total } = await readEntriesCached(
    c.env,
    c.member,
    a.project,
    budget,
    fetchOf(c.env),
  );
  return {
    text: projectContext(a.project, entries, total),
    total,
    matched: entries.length,
  };
}

export async function searchMemory(
  c: Caller,
  a: { query: string; project?: string; kinds?: string[] },
): Promise<string> {
  const query = a.query.trim();
  if (!query) throw new Error("missing required argument: query");
  const deps = indexDeps(c.env);
  if (!deps) throw new Error("memory search is not enabled on this gateway");
  const project = a.project || undefined;
  try {
    const { results, total } = await retrieve(deps, {
      space: c.member.space,
      project: project ? slug(project) : undefined,
      query,
      budgetTokens: DEFAULT_BUDGET_TOKENS,
      kinds: a.kinds,
      // Candidates for renderSearchResults, which groups them by entry.
      // Uncapped, a 4000-token budget of short facts returned ~68.
      maxResults: SEARCH_MAX_FACTS,
      trigger: "search_memory",
    });
    return renderSearchResults(project, query, results, total);
  } catch {
    // Degrade parity with read: a transient index/AI failure returns a useful
    // non-error result instead of isError (one hard failure teaches agents
    // the tool is unreliable and they stop calling it). With a project we can
    // serve the recency read; the whole-space form has no recency equivalent.
    if (project) {
      const { entries, total } = await readEntriesCached(
        c.env,
        c.member,
        project,
        DEFAULT_BUDGET_TOKENS,
        fetchOf(c.env),
      );
      return (
        `_Semantic search is temporarily unavailable — showing the most recent entries for "${project}" instead._\n\n` +
        projectContext(project, entries, total)
      );
    }
    return "Memory search is temporarily unavailable. Retry shortly, or call read_context with a project name for its recent entries.";
  }
}

export async function writeMemory(
  c: Caller,
  project: string,
  a: {
    type: EntryType;
    payload: string;
    supersedes: string[];
    facts: unknown;
  },
): Promise<string> {
  if (!a.payload) throw new Error("missing required argument: payload");
  const { env, member } = c;
  // Writer-split facts are validated here and persisted with the entry, so
  // this and every later re-index skips server-side extraction.
  const facts = clientFacts(a.facts, { type: a.type }) ?? undefined;
  const deps = indexDeps(env);
  // Conflict + duplicate check runs BEFORE the commit: it reads only the
  // index and the payload, so ordering it first costs nothing and lets an
  // enforced duplicate skip the commit entirely. Fail-open — any check
  // failure stores the write as if the check found nothing.
  let check: WriteCheck = { duplicate: null, conflicts: [] };
  if (deps) {
    try {
      check = await detectWriteConflicts(
        deps.db,
        deps.embed,
        deps.gen,
        member.space,
        project,
        a.payload,
        {
          skipIds: a.supersedes,
          kind: a.type,
          timeoutMs: 2000,
          // Explicit supersedes = deliberate replacement; never second-guess
          // it with the dup gate.
          dedupe: a.supersedes.length === 0,
          enforceDup: env.dupGateEnforce,
        },
      );
    } catch {
      // fail-open: store the write
    }
  }
  if (check.duplicate) return formatDuplicateResult(check.duplicate, project);

  const entry = await writeEntry(
    env,
    member,
    project,
    { type: a.type, payload: a.payload, facts },
    fetchOf(env),
  );
  await afterEntryWritten(c, project, entry);
  // Index ingest runs after the response: LLM fact extraction would add
  // ~1-3s to the write, and the ledger entry is already committed and served
  // by the recency read (design §0.2). Fail-open — the webhook/cron paths
  // re-derive from the ledger if this misses.
  await later(
    c,
    (async () => {
      try {
        if (deps)
          await ingestEntries(
            deps.db,
            deps.embed,
            deps.gen,
            member.space,
            project,
            [entry],
            // Old facts the pre-commit check already judged "relates" are not
            // worth a second paid verdict for the same entry.
            { authorSupersedes: a.supersedes, skipJudgeOld: check.relatedIds },
          );
      } catch {
        // fail-open
      }
    })(),
  );
  return formatWriteResult(entry, project, check.conflicts, a.supersedes);
}

export async function rateFact(
  c: Caller,
  factId: string,
  verdict: unknown,
): Promise<string> {
  if (!factId) throw new Error("missing required argument: fact_id");
  if (verdict !== "useful" && verdict !== "wrong" && verdict !== "stale")
    throw new Error("verdict must be one of: useful, wrong, stale");
  const deps = indexDeps(c.env);
  if (!deps) throw new Error("memory feedback is not enabled on this gateway");
  try {
    const target = await deps.db.getDoc(c.member.space, factId);
    await deps.db.recordFeedback({
      space: c.member.space,
      project: target?.project ?? "",
      factId,
      member: c.member.author,
      verdict,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    console.warn(
      `[feedback] record failed for ${factId}: ${(e as Error).message}`,
    );
    throw new Error("couldn't record feedback right now (it was not saved)");
  }
  return `Recorded '${verdict}' feedback on ${factId}. This will adjust its future ranking.`;
}

/** Author-confirmed supersession: these facts are replaced by that entry. */
export async function supersedeFacts(
  c: Caller,
  factIds: string[],
  byEntry: string,
): Promise<string> {
  if (factIds.length === 0 || !byEntry)
    throw new Error(
      "missing required arguments: fact_ids and replaced_by_entry",
    );
  const deps = indexDeps(c.env);
  if (!deps) throw new Error("supersession is not enabled on this gateway");
  const space = c.member.space;
  // The new entry is indexed a few seconds after write_context returns. If it
  // is not there yet, point at the entry itself: the cron's dangling-pointer
  // repair re-points it to the entry's fact.
  const live = (await deps.db.docsBySource(space, byEntry)).filter(
    (d) => !d.supersededBy,
  );
  const target = live[0]?.id ?? `${byEntry}#entry`;
  const done: string[] = [];
  const skipped: string[] = [];
  const projects = new Set<string>();
  for (const id of factIds.slice(0, 20)) {
    const old = await deps.db.getDoc(space, id);
    if (!old || old.sourceId === byEntry) {
      skipped.push(id);
      continue;
    }
    await deps.db.markSuperseded(space, id, target);
    await deps.db.logSupersession({
      space,
      project: old.project,
      newFactId: target,
      oldFactId: id,
      verdict: "replaces",
      autoLinked: true,
      reason: "author-supersedes",
      ts: new Date().toISOString(),
    });
    done.push(id);
    projects.add(old.project);
  }
  for (const p of projects) {
    await c.env.ROUTING.delete(hookCacheKey(space, p)).catch(() => {});
  }
  return (
    `Marked ${done.length} fact(s) as replaced by entry ${byEntry}.` +
    (skipped.length
      ? ` Skipped ${skipped.join(", ")} (not found, or part of that entry).`
      : "")
  );
}
