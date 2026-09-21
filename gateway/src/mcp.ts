import type { Env, HandlerCtx } from "./env.js";
import { resolveMember } from "./tenancy.js";
import { mcpInstructions } from "../../src/session-prompt.js";
import { TOOLS } from "./mcp-tools.js";
import {
  rateFact,
  readMemory,
  searchMemory,
  supersedeFacts,
  writeMemory,
  type Caller,
} from "./memory.js";
import {
  createPlan,
  editPlan,
  formatCreated,
  formatEdited,
  formatTransitioned,
  listProjectPlans,
  planCtx,
  readPlan,
  renderPlan,
  renderPlanList,
  transitionPlan,
} from "./plans.js";
import { planBrief } from "./plan-brief.js";
import { setPlanMirror } from "./plan-mirror.js";
import { inviteMember, revokeMember } from "./spaces.js";
import { listSessions, revokeSession } from "./sessions.js";

/**
 * Stateless MCP over Streamable HTTP: every request is one JSON-RPC message
 * answered with one JSON body (the spec's stateless-server mode — our tools
 * are single synchronous calls, so no SSE stream and no session state).
 *
 * This file is TRANSPORT ONLY (docs/PLAN.md 0.3): each tool parses its
 * arguments, calls a service (memory.ts, plans.ts, spaces.ts, sessions.ts)
 * and returns its text. A thrown Error becomes an isError tool result. Tool
 * schemas live in mcp-tools.ts. `write_context.author` is IGNORED — identity
 * comes from the bearer token, so a member cannot write as another.
 */

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

const PROTOCOL_VERSION = "2025-03-26";

type Args = Record<string, unknown>;
type Tool = (c: Caller, a: Args, req: Request) => Promise<string>;

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean)
    : [];
const posInt = (v: unknown): number | undefined =>
  typeof v === "number" && v > 0 ? Math.floor(v) : undefined;

function need(a: Args, key: string): string {
  const v = str(a[key]);
  if (!v) throw new Error(`missing required argument: ${key}`);
  return v;
}
/** `project` keeps the caller's spelling: it is shown back in results. */
function project(a: Args): string {
  if (typeof a.project !== "string" || !a.project)
    throw new Error("missing required argument: project");
  return a.project;
}

const HANDLERS: Record<string, Tool> = {
  read_context: async (c, a) =>
    (
      await readMemory(c, {
        project: project(a),
        query: str(a.query),
        budgetTokens: posInt(a.budget_tokens),
        trigger: "mcp_read",
      })
    ).text,
  search_memory: (c, a) =>
    searchMemory(c, {
      query: str(a.query),
      project: typeof a.project === "string" ? a.project : undefined,
      kinds: Array.isArray(a.kinds) ? strs(a.kinds) : undefined,
    }),
  write_context: (c, a) => {
    const p = project(a);
    return writeMemory(c, p, {
      type: a.type === "context" ? "context" : "decision",
      payload: typeof a.payload === "string" ? a.payload : "",
      supersedes: Array.isArray(a.supersedes)
        ? a.supersedes.filter((x): x is string => typeof x === "string")
        : [],
      facts: a.facts,
    });
  },
  memory_feedback: (c, a) => rateFact(c, str(a.fact_id), a.verdict),
  supersede_facts: (c, a) =>
    supersedeFacts(c, strs(a.fact_ids), str(a.replaced_by_entry)),

  plan_brief: (c, a) =>
    planBrief(c, { project: project(a), prompt: need(a, "prompt") }),

  create_plan: async (c, a) => {
    const p = project(a);
    return formatCreated(
      await createPlan(planCtx(c), p, {
        title: a.title,
        body: a.body,
        repo: a.repo,
        branch: a.branch,
        inherits: a.inherits,
      }),
    );
  },
  read_plan: async (c, a) => {
    const p = project(a);
    const pc = planCtx(c);
    const ref = str(a.plan);
    return ref
      ? renderPlan(await readPlan(pc, p, ref, posInt(a.version)))
      : renderPlanList(p, await listProjectPlans(pc, p));
  },
  edit_plan: async (c, a) => {
    const p = project(a);
    return formatEdited(
      await editPlan(planCtx(c), p, need(a, "plan"), {
        title: a.title,
        body: a.body,
      }),
    );
  },
  transition_plan: async (c, a) => {
    const p = project(a);
    return formatTransitioned(
      await transitionPlan(planCtx(c), p, need(a, "plan"), {
        to: a.to,
        agent: a.agent,
        commitSha: a.commit_sha,
        decisions: a.decisions,
        producedFactIds: a.produced_fact_ids,
        supersedes: a.supersedes,
        supersededBy: a.superseded_by,
      }),
    );
  },

  set_plan_mirror: (c, a) => {
    if (typeof a.enabled !== "boolean")
      throw new Error("enabled must be true or false");
    return setPlanMirror(c.env, c.member, project(a), a.enabled);
  },

  invite_member: (c, a) =>
    inviteMember(c.env, c.member, str(a.github_username)),
  revoke_member: (c, a) =>
    revokeMember(c.env, c.member, str(a.github_username)),
  list_sessions: async (c, _a, req) => {
    const out = await listSessions(c.env, c.member, req);
    if (out.isError) throw new Error(out.text);
    return out.text;
  },
  revoke_session: async (c, a, req) => {
    const out = await revokeSession(
      c.env,
      c.member,
      req,
      typeof a.session_id === "string" ? a.session_id : "",
    );
    if (out.isError) throw new Error(out.text);
    return out.text;
  },
};

function rpcResult(id: RpcMessage["id"], result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, result });
}

function rpcError(
  id: RpcMessage["id"],
  code: number,
  message: string,
): Response {
  return Response.json({
    jsonrpc: "2.0",
    id: id ?? null,
    error: { code, message },
  });
}

function toolText(text: string, isError = false): unknown {
  return isError
    ? { content: [{ type: "text", text }], isError: true }
    : { content: [{ type: "text", text }] };
}

export async function handleMcp(
  req: Request,
  env: Env,
  ctx?: HandlerCtx,
): Promise<Response> {
  const member = await resolveMember(req, env, ctx);
  if (!member) return new Response("unauthorized", { status: 401 });

  let msg: RpcMessage | RpcMessage[];
  try {
    msg = (await req.json()) as RpcMessage | RpcMessage[];
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  if (Array.isArray(msg))
    return rpcError(null, -32600, "batch requests not supported");

  switch (msg.method) {
    case "initialize":
      return rpcResult(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "memorylayer", version: "0.1.8" },
        instructions: mcpInstructions(member.space, { supersedes: true }),
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: TOOLS });
    case "tools/call":
      return rpcResult(msg.id, await toolsCall(msg, { env, member, ctx }, req));
    default:
      return rpcError(
        msg.id,
        -32601,
        `method not found: ${msg.method ?? "(none)"}`,
      );
  }
}

async function toolsCall(
  msg: RpcMessage,
  c: Caller,
  req: Request,
): Promise<unknown> {
  const name = msg.params?.name ?? "(none)";
  const args = msg.params?.arguments ?? {};
  const started = Date.now();
  let isError = false;
  let text: string;
  try {
    const tool = Object.hasOwn(HANDLERS, name) ? HANDLERS[name] : undefined;
    if (!tool) throw new Error(`unknown tool: ${name}`);
    text = await tool(c, args, req);
  } catch (err) {
    isError = true;
    text = (err as Error).message;
  }
  console.log(
    JSON.stringify({
      evt: "mcp_tool",
      tool: name,
      project: typeof args.project === "string" ? args.project : null,
      space: c.member.space,
      ms: Date.now() - started,
      isError,
    }),
  );
  return toolText(text, isError);
}
