import type { Env } from "./env.js";
import { resolveMember, type SpaceMember } from "./tenancy.js";
import { readEntries, writeEntry } from "./github-store.js";
import { projectContext } from "../../src/context-format.js";
import { slug } from "../../src/slug.js";
import { DEFAULT_BUDGET_TOKENS } from "../../src/token-budget.js";
import type { EntryType } from "../../src/frontmatter.js";

/**
 * Stateless MCP over Streamable HTTP: every request is one JSON-RPC message
 * answered with one JSON body (the spec's stateless-server mode — our two
 * tools are single synchronous calls, so no SSE stream and no session state).
 * Tool names, descriptions, and argument names mirror src/index.ts exactly;
 * the one deliberate divergence is that `write_context.author` is IGNORED —
 * identity comes from the bearer token, so a member cannot write as another.
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

const TOOLS = [
  {
    name: "read_context",
    title: "Read shared planning context",
    description:
      "Pull the latest shared planning context for a project and return the current projected state (all recorded decisions and context, in write order). Call this at the START of a planning turn so decisions written by collaborators are already present without anyone pasting them.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "The shared project/space name, e.g. 'business-one'.",
        },
        budget_tokens: {
          type: "integer",
          exclusiveMinimum: 0,
          description:
            "Override the default read token budget for this call (larger = more history, smaller = tighter context).",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "write_context",
    title: "Write a shared planning decision",
    description:
      "Append a DELIBERATE decision or established context to the shared project space and commit it, so collaborators' sessions see it. Write decisions ('we decided X because Y') and durable context — NOT a firehose of every reasoning step. When the user says 'record this', 'remember this', 'save this decision' (or runs the /remember command), treat it as an EXPLICIT instruction to call this tool right away.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "The shared project/space name, e.g. 'business-one'.",
        },
        type: {
          type: "string",
          enum: ["decision", "context"],
          default: "decision",
          description:
            "'decision' for a settled call, 'context' for durable background.",
        },
        payload: {
          type: "string",
          description:
            "The decision or context, stated plainly. For decisions, include the 'because' — the reasoning that settles it.",
        },
        author: {
          type: "string",
          description:
            "Ignored on the hosted gateway: attribution always comes from the authenticated member token.",
        },
      },
      required: ["project", "payload"],
    },
  },
];

/** Cache key for /hook/read's per-space projection cache (Task 7 reads it). */
export function hookCacheKey(space: string, project: string): string {
  return `hookread:${space}:${slug(project)}`;
}

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

export async function handleMcp(req: Request, env: Env): Promise<Response> {
  const member = await resolveMember(req, env);
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
        serverInfo: { name: "memorylayer", version: "0.1.0" },
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: TOOLS });
    case "tools/call":
      return toolsCall(msg, member, env);
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
  member: SpaceMember,
  env: Env,
): Promise<Response> {
  const fetchImpl = env.githubFetch ?? fetch;
  const args = msg.params?.arguments ?? {};
  const project = typeof args.project === "string" ? args.project : "";
  if (!project)
    return rpcResult(
      msg.id,
      toolText("missing required argument: project", true),
    );

  try {
    switch (msg.params?.name) {
      case "read_context": {
        const budget =
          typeof args.budget_tokens === "number" && args.budget_tokens > 0
            ? args.budget_tokens
            : DEFAULT_BUDGET_TOKENS;
        const { entries, total } = await readEntries(
          env,
          member,
          project,
          budget,
          fetchImpl,
        );
        return rpcResult(
          msg.id,
          toolText(projectContext(project, entries, total)),
        );
      }
      case "write_context": {
        const type: EntryType =
          args.type === "context" ? "context" : "decision";
        const payload = typeof args.payload === "string" ? args.payload : "";
        if (!payload)
          return rpcResult(
            msg.id,
            toolText("missing required argument: payload", true),
          );
        const entry = await writeEntry(
          env,
          member,
          project,
          { type, payload },
          fetchImpl,
        );
        // Best-effort cache invalidation: the write is already durably
        // committed, so never let a KV failure misreport it as an error
        // (the cache key has a 60s TTL, so a missed delete self-heals
        // within a minute).
        try {
          await env.ROUTING.delete(hookCacheKey(member.space, project));
        } catch {
          // swallow: stale cache expires via TTL
        }
        return rpcResult(
          msg.id,
          toolText(
            `Recorded ${entry.type} in '${project}' as ${entry.author} at ${entry.timestamp} (${entry.file}).`,
          ),
        );
      }
      default:
        return rpcResult(
          msg.id,
          toolText(`unknown tool: ${msg.params?.name ?? "(none)"}`, true),
        );
    }
  } catch (err) {
    return rpcResult(msg.id, toolText((err as Error).message, true));
  }
}
