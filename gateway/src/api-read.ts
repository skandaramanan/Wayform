/**
 * GET /api/read — machine-readable read endpoint for the local plane's
 * remote-first reads (§2.2): the CLI's read_context / search_memory proxy
 * here with the member token and fall back to the local clone on any failure.
 * `query` present = retrieval pipeline; absent = recency read (unchanged
 * contract with the local read).
 */
import type { Env, HandlerCtx } from "./env.js";
import { resolveMember } from "./tenancy.js";
import { readMemory } from "./memory.js";
import { DEFAULT_BUDGET_TOKENS } from "../../src/token-budget.js";

export async function handleApiRead(
  req: Request,
  env: Env,
  ctx?: HandlerCtx,
): Promise<Response> {
  const member = await resolveMember(req, env, ctx);
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

  return Response.json(
    await readMemory(
      { env, member, ctx },
      { project, query, budgetTokens: budget, kinds, trigger },
    ),
  );
}
