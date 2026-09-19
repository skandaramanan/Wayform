/**
 * Plan mirror: a per-project, admin-set toggle that makes every member's
 * session-start hook write the in-flight plans into .wayform/plans/ in their
 * code repo. Plans only; memories never flow through here.
 */
import type { Env, HandlerCtx } from "./env.js";
import { resolveMember, type SpaceMember } from "./tenancy.js";
import type { Caller } from "./memory.js";
import { INDEXED_STATES } from "./plan-core.js";
import { listProjectPlans, planCtx, readPlan, renderPlan } from "./plans.js";
import { slug } from "../../src/slug.js";

const key = (space: string, project: string) =>
  `plan-mirror:${space}:${slug(project)}`;

export async function setPlanMirror(
  env: Env,
  member: SpaceMember,
  project: string,
  enabled: boolean,
): Promise<string> {
  if (member.role !== "admin")
    throw new Error("only a space admin can change the plan mirror");
  if (enabled) await env.ROUTING.put(key(member.space, project), "1");
  else await env.ROUTING.delete(key(member.space, project));
  return (
    `Plan mirror for "${project}" is now ${enabled ? "on" : "off"}. ` +
    `Teammates' hooks will ${enabled ? "write" : "remove"} .wayform/plans/ at their next session start.`
  );
}

export async function mirrorPlans(c: Caller, project: string) {
  const enabled =
    (await c.env.ROUTING.get(key(c.member.space, project))) === "1";
  if (!enabled) return { enabled, plans: [] };
  const pc = planCtx(c);
  // ponytail: listPlans caps at 50; raise the limit if a project has >50 plans
  const live = (await listProjectPlans(pc, project)).filter((m) =>
    INDEXED_STATES.has(m.state),
  );
  const plans = await Promise.all(
    live.map(async (m) => ({
      file: `${m.seq}-${slug(m.title)}.md`,
      markdown: renderPlan(await readPlan(pc, project, m.id)),
    })),
  );
  return { enabled, plans };
}

export async function handleApiPlans(req: Request, env: Env, ctx?: HandlerCtx) {
  const member = await resolveMember(req, env, ctx);
  if (!member) return new Response("unauthorized", { status: 401 });
  const project = new URL(req.url).searchParams.get("project")?.trim() ?? "";
  if (!project) return new Response("missing project", { status: 400 });
  return Response.json(await mirrorPlans({ env, member, ctx }, project));
}
