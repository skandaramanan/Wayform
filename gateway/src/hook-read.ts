import type { Env, HandlerCtx } from "./env.js";
import { resolveMember } from "./tenancy.js";
import { readEntriesCached } from "./github-store.js";
import { hookCacheKey } from "./mcp.js";
import { indexDeps } from "./deps.js";
import { renderBriefing } from "./retrieval.js";
import { projectContext } from "../../src/context-format.js";
import { composeSessionStartText } from "../../src/session-prompt.js";
import { slug } from "../../src/slug.js";
import { DEFAULT_BUDGET_TOKENS } from "../../src/token-budget.js";

/** Seconds a rendered projection may be served stale to keep the per-turn
 *  hook round-trip at one edge hit (~50-150ms) instead of chained GitHub
 *  calls (~200-600ms). Writes through the gateway invalidate immediately. */
const CACHE_TTL_SECONDS = 300;

/**
 * GET /hook/read?project=<name>[&budget=<n>] — the session-start hook's
 * entire remote path: returns ready-to-inject plain text (preamble +
 * projection), or an empty 200 body when the project has no entries so thin
 * client shims can fail-open on empty. Cached per space+project.
 */
export async function handleHookRead(
  req: Request,
  env: Env,
  ctx?: HandlerCtx,
): Promise<Response> {
  const member = await resolveMember(req, env, ctx);
  if (!member) return new Response("unauthorized", { status: 401 });

  const url = new URL(req.url);
  const project = url.searchParams.get("project")?.trim() ?? "";
  if (!project) return new Response("missing project", { status: 400 });

  const asText = (body: string) =>
    new Response(body, {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });

  const cacheKey = hookCacheKey(member.space, project);
  const cached = await env.ROUTING.get(cacheKey);
  if (cached !== null) return asText(cached);

  const budgetParam = Number(url.searchParams.get("budget"));
  const budget =
    Number.isFinite(budgetParam) && budgetParam > 0
      ? budgetParam
      : DEFAULT_BUDGET_TOKENS;

  // Prefer the index briefing (canon + open questions + recent decisions +
  // topic manifest). Fail-open to the Phase A recency dump when the index is
  // unconfigured, empty, or throws — a broken index must never break a session.
  // composeSessionStartText prefixes the tool-invocation playbook so mid-session
  // MCP pulls stay forced even after the selective briefing is injected.
  let text = "";
  try {
    const deps = indexDeps(env);
    if (deps) {
      // Briefing-shaped read: canon + questions + recent decisions + an entity
      // manifest, none of which touch a vector. SELECT * decoded the whole
      // project's embeddings on every session open for nothing.
      const listed = await deps.db.listDocsNoEmbeddings(
        member.space,
        slug(project),
      );
      // A fact a member flagged wrong/stale (net-negative memory_feedback)
      // must stop riding along in every session. retrieve() only soft-demotes,
      // which suits search — the agent asked. The briefing is unrequested, so
      // a flagged fact is dropped here; it stays searchable.
      let flagged = new Map<string, number>();
      try {
        flagged = await deps.db.feedbackPenalties(member.space);
      } catch {
        // fail-open: feedback must never break the session read
      }
      const docs = listed.filter((d) => !flagged.has(d.id));
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const conflicts: {
        oldFactId: string;
        oldBody: string;
        reason: string;
      }[] = [];
      try {
        const logs = await deps.db.recentConflictLogs(
          member.space,
          slug(project),
          since,
          10,
        );
        for (const log of logs) {
          const old =
            (await deps.db.getDoc(member.space, log.oldFactId)) ??
            ({ body: log.oldFactId } as { body: string });
          conflicts.push({
            oldFactId: log.oldFactId,
            oldBody: old.body,
            reason: log.reason,
          });
        }
      } catch {
        // fail-open
      }
      const briefing = renderBriefing(
        project,
        docs,
        budget,
        new Date(),
        conflicts,
      );
      if (briefing)
        text = composeSessionStartText(project, briefing, {
          supersedes: true,
        });
    }
  } catch {
    // fall through to the recency dump
  }

  if (text === "") {
    const { entries, total } = await readEntriesCached(
      env,
      member,
      project,
      budget,
      env.githubFetch ?? fetch,
    );
    text =
      total === 0
        ? ""
        : composeSessionStartText(
            project,
            projectContext(project, entries, total),
            { supersedes: true },
          );
  }

  await env.ROUTING.put(cacheKey, text, { expirationTtl: CACHE_TTL_SECONDS });
  return asText(text);
}
