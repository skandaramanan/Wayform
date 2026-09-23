/**
 * Phase E enforcement: judge a PROPOSED AGENT ACTION against live facts and ask
 * the human when it contradicts one.
 *
 * Zero new model code by design (spec decision 4): the action is phrased as the
 * NEW fact and handed to B2's existing judge, whose prompt already defines
 * "contradicts" as "both cannot be true". Only that verdict interrupts.
 *
 * FAIL-OPEN: every failure resolves to "allow". This sits on the hot path of
 * every edit — a guard that throws is worse than no guard.
 */
import { retrieve, type RetrieveDeps } from "./retrieval.js";
import { judgePair, SYNC_JUDGE_LIMIT } from "./supersede.js";
import type { GenText } from "./extract.js";
import type { Env, HandlerCtx } from "./env.js";
import { resolveMember } from "./tenancy.js";
import { indexDeps } from "./deps.js";
import { slug } from "../../src/slug.js";

/**
 * Deliberately far below DEFAULT_BUDGET_TOKENS: retrieve() fills to budget, and
 * every returned fact is a potential judge call the user waits on.
 */
export const GUARD_BUDGET_TOKENS = 400;

export interface GuardResult {
  decision: "ask" | "allow";
  reason: string;
  factIds: string[];
}

const ALLOW: GuardResult = { decision: "allow", reason: "", factIds: [] };

const READ_ONLY_CMDS = new Set(
  "ls cat head tail grep rg find wc echo printf pwd true which file stat du tree sort uniq cut jq diff cd basename dirname realpath readlink sed awk".split(
    " ",
  ),
);
const READ_ONLY_GIT = new Set(
  "log show diff status blame ls-files grep rev-parse describe shortlog ls-tree cat-file".split(
    " ",
  ),
);

/**
 * A shell command that only reads cannot contradict a decision, yet it was
 * judged like an edit: on 2026-09-23 plan-mode runs had `git log`, `grep` and
 * `ls` interrupted by unrelated "contradicts" verdicts, and a headless agent
 * cannot answer "ask", so it was simply blocked. Conservative: any redirect,
 * command substitution, in-place edit or non-read git subcommand still goes
 * to the judge.
 */
export function isReadOnlyShell(action: string): boolean {
  const m = /^Bash: ([\s\S]*)$/.exec(action);
  if (!m) return false;
  const cmd = m[1].replace(/\d?>\s*\/dev\/null|\d>&\d/g, "");
  if (/[>`]|\$\(/.test(cmd)) return false;
  return cmd
    .split(/&&|\|\||[;|\n]/)
    .map((seg) => seg.trim().split(/\s+/))
    .filter((w) => w[0])
    .every((w) => {
      if (w[0] === "git") return READ_ONLY_GIT.has(w[1] ?? "");
      if (!READ_ONLY_CMDS.has(w[0])) return false;
      if (w[0] === "sed") return !w.some((x) => x.startsWith("-i"));
      if (w[0] === "find")
        return !w.some((x) => /^-(delete|exec|execdir|ok)$/.test(x));
      return true;
    });
}

export async function checkAction(
  deps: RetrieveDeps & { gen: GenText | null },
  opts: { space: string; project: string; action: string },
): Promise<GuardResult> {
  if (isReadOnlyShell(opts.action)) return ALLOW;
  try {
    const { results } = await retrieve(deps, {
      space: opts.space,
      project: opts.project,
      query: opts.action,
      budgetTokens: GUARD_BUDGET_TOKENS,
      trigger: "hook_guard",
    });
    // In-flight plan checklists are searchable, not decisions to enforce.
    const facts = results.filter((r) => r.doc.kind !== "plan");
    if (facts.length === 0 || !deps.gen) return ALLOW;

    // Judged in parallel — the agent waits on this, and the calls are
    // independent — then read back in rank order so the strongest hit wins.
    const hits = facts.slice(0, SYNC_JUDGE_LIMIT);
    const gen = deps.gen;
    const verdicts = await Promise.all(
      hits.map((hit) =>
        judgePair(
          gen,
          { body: `The agent is about to: ${opts.action}`, kind: "decision" },
          { id: hit.doc.id, body: hit.doc.body, kind: hit.doc.kind },
        ).catch(() => null),
      ),
    );
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      const verdict = verdicts[i];
      // Only "contradicts" interrupts (spec decision 5): B2 already settled
      // that uncertainty must never act.
      if (verdict?.verdict === "contradicts") {
        return {
          decision: "ask",
          reason: `${hit.doc.body} — ${hit.doc.sourceAuthor}, ${hit.doc.sourceTs.slice(0, 10)}. ${verdict.reason}`,
          factIds: [hit.doc.id],
        };
      }
    }
    return ALLOW;
  } catch {
    return ALLOW;
  }
}

/**
 * POST /mcp/hook/guard  body { project, action } → { decision, reason, factIds }.
 * POST (not GET) because it carries free text, same as /hook/prompt.
 * Every non-auth failure returns 200 allow: the caller is a PreToolUse hook and
 * an error status would only be translated back into "allow" anyway.
 */
export async function handleHookGuard(
  req: Request,
  env: Env,
  ctx?: HandlerCtx,
): Promise<Response> {
  const member = await resolveMember(req, env, ctx);
  if (!member) return new Response("unauthorized", { status: 401 });

  const allow = () => Response.json(ALLOW);

  let body: { project?: unknown; action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return allow();
  }
  const project = typeof body.project === "string" ? body.project.trim() : "";
  const action = typeof body.action === "string" ? body.action.trim() : "";
  if (!project || !action) return allow();

  const deps = indexDeps(env);
  if (!deps) return allow();

  return Response.json(
    await checkAction(deps, {
      space: member.space,
      project: slug(project),
      action,
    }),
  );
}
