/**
 * GET /api/read — machine-readable read endpoint for the local plane's
 * remote-first reads (§2.2): the CLI's read_context / search_memory proxy
 * here with the member token and fall back to the local clone on any failure.
 * `query` present = retrieval pipeline; absent = recency read (unchanged
 * contract with the local read).
 */
import type { Env } from "./env.js";
import { resolveMember } from "./tenancy.js";
import { readEntries } from "./github-store.js";
import { projectContext } from "../../src/context-format.js";
import { DEFAULT_BUDGET_TOKENS } from "../../src/token-budget.js";
import { slug } from "../../src/slug.js";
import { indexDeps } from "./deps.js";
import { retrieve, renderSearchResults } from "./retrieval.js";

export async function handleApiRead(req: Request, env: Env): Promise<Response> {
  const member = await resolveMember(req, env);
  if (!member) return new Response("unauthorized", { status: 401 });

  const url = new URL(req.url);
  const project = url.searchParams.get("project")?.trim() ?? "";
  if (!project) return new Response("missing project", { status: 400 });

  const budgetParam = Number(url.searchParams.get("budget"));
  const budget =
    Number.isFinite(budgetParam) && budgetParam > 0
      ? budgetParam
      : DEFAULT_BUDGET_TOKENS;
  const query = url.searchParams.get("query")?.trim() ?? "";
  const kindsParam = url.searchParams.get("kinds")?.trim();
  const kinds = kindsParam ? kindsParam.split(",").filter(Boolean) : undefined;
  const trigger = url.searchParams.get("trigger")?.trim() || "api_read";

  const deps = indexDeps(env);
  if (query && deps) {
    try {
      const { results, total } = await retrieve(deps, {
        space: member.space,
        project: slug(project),
        query,
        budgetTokens: budget,
        kinds,
        trigger,
      });
      return Response.json({
        text: renderSearchResults(project, query, results, total),
        total,
        matched: results.length,
      });
    } catch {
      // fail-open to the recency read below
    }
  }

  const { entries, total } = await readEntries(
    env,
    member,
    project,
    budget,
    env.githubFetch ?? fetch,
  );
  return Response.json({
    text: projectContext(project, entries, total),
    total,
    matched: entries.length,
  });
}
