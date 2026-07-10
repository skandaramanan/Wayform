import type { Env } from "./env.js";
import { resolveMember } from "./tenancy.js";
import { readEntries } from "./github-store.js";
import { hookCacheKey } from "./mcp.js";
import { indexDeps } from "./deps.js";
import { renderBriefing } from "./retrieval.js";
import { projectContext } from "../../src/context-format.js";
import { slug } from "../../src/slug.js";
import { DEFAULT_BUDGET_TOKENS } from "../../src/token-budget.js";

/** Seconds a rendered projection may be served stale to keep the per-turn
 *  hook round-trip at one edge hit (~50-150ms) instead of chained GitHub
 *  calls (~200-600ms). Writes through the gateway invalidate immediately. */
const CACHE_TTL_SECONDS = 60;

/**
 * GET /hook/read?project=<name>[&budget=<n>] — the session-start hook's
 * entire remote path: returns ready-to-inject plain text (preamble +
 * projection), or an empty 200 body when the project has no entries so thin
 * client shims can fail-open on empty. Cached per space+project.
 */
export async function handleHookRead(
  req: Request,
  env: Env,
): Promise<Response> {
  const member = await resolveMember(req, env);
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

  const preamble =
    `The following is shared planning memory (MemoryLayer) for project ` +
    `"${project}", loaded automatically at session start. Treat these recorded ` +
    `decisions and context as already-known; do not ask the user to re-explain ` +
    `them.\n\n`;

  // Prefer the index briefing (canon + open questions + recent decisions +
  // topic manifest). Fail-open to the Phase A recency dump when the index is
  // unconfigured, empty, or throws — a broken index must never break a session.
  let text = "";
  try {
    const deps = indexDeps(env);
    if (deps) {
      const docs = await deps.db.listDocs(member.space, slug(project));
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      let conflicts: { oldFactId: string; oldBody: string; reason: string }[] =
        [];
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
      if (briefing) text = preamble + briefing;
    }
  } catch {
    // fall through to the recency dump
  }

  if (text === "") {
    const { entries, total } = await readEntries(
      env,
      member,
      project,
      budget,
      env.githubFetch ?? fetch,
    );
    text =
      total === 0 ? "" : preamble + projectContext(project, entries, total);
  }

  await env.ROUTING.put(cacheKey, text, { expirationTtl: CACHE_TTL_SECONDS });
  return asText(text);
}
