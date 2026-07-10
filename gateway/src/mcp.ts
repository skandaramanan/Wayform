import type { Env } from "./env.js";
import { resolveMember, type SpaceMember } from "./tenancy.js";
import { readEntries, writeEntry } from "./github-store.js";
import { projectContext } from "../../src/context-format.js";
import { slug } from "../../src/slug.js";
import { DEFAULT_BUDGET_TOKENS } from "../../src/token-budget.js";
import type { EntryType } from "../../src/frontmatter.js";
import { indexDeps } from "./deps.js";
import { retrieve, renderSearchResults } from "./retrieval.js";
import { ingestEntries } from "./ingest.js";
import { detectWriteConflicts, formatWriteResult } from "./supersede.js";

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
        query: {
          type: "string",
          description:
            "Optional natural-language or keyword query. When given, returns " +
            "relevance-ranked matches from the WHOLE indexed history " +
            "(keyword + semantic search) instead of only the most recent entries. " +
            "Use it when looking for a specific past decision or topic.",
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
        supersedes: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional live fact ids this entry replaces. Skips conflict checks for those ids; links after ingest without judge.",
        },
      },
      required: ["project", "payload"],
    },
  },
  {
    name: "search_memory",
    title: "Search the shared memory",
    description:
      "Relevance-ranked search over ALL recorded decisions and context in this " +
      "space (keyword + semantic, whole history — not just recent entries). " +
      "Use it BEFORE contradicting or re-deciding anything that may already be " +
      "settled, and when the user references prior work or decisions.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to look for, e.g. 'cursor mcp config scoping'.",
        },
        project: {
          type: "string",
          description:
            "Restrict to one project/space name. Omit to search every project.",
        },
        kinds: {
          type: "array",
          items: { type: "string", enum: ["decision", "context"] },
          description: "Restrict to entry kinds.",
        },
      },
      required: ["query"],
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

export async function handleMcp(
  req: Request,
  env: Env,
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
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
        instructions:
          `This server holds shared planning memory (decisions and durable context) for the space "${member.space}". ` +
          `Call read_context at the start of a planning turn with project set to the name of the project/repo you are working in (default to "${member.space}" if unsure) so you see decisions your collaborators already recorded. ` +
          `Call search_memory before contradicting or re-deciding anything that might already be settled. ` +
          `Call write_context only for a DELIBERATE decision ("we decided X because Y") or durable background — not every reasoning step.`,
      });
    case "notifications/initialized":
      return new Response(null, { status: 202 });
    case "ping":
      return rpcResult(msg.id, {});
    case "tools/list":
      return rpcResult(msg.id, { tools: TOOLS });
    case "tools/call":
      return toolsCall(msg, member, env, ctx);
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
  ctx?: { waitUntil(p: Promise<unknown>): void },
): Promise<Response> {
  const fetchImpl = env.githubFetch ?? fetch;
  const args = msg.params?.arguments ?? {};
  const project = typeof args.project === "string" ? args.project : "";
  const toolName = msg.params?.name;
  if ((toolName === "read_context" || toolName === "write_context") && !project)
    return rpcResult(
      msg.id,
      toolText("missing required argument: project", true),
    );

  try {
    switch (toolName) {
      case "read_context": {
        const budget =
          typeof args.budget_tokens === "number" && args.budget_tokens > 0
            ? args.budget_tokens
            : DEFAULT_BUDGET_TOKENS;
        const query = typeof args.query === "string" ? args.query.trim() : "";
        const deps = indexDeps(env);
        if (query && deps) {
          try {
            const { results, total } = await retrieve(deps, {
              space: member.space,
              project: slug(project),
              query,
              budgetTokens: budget,
              trigger: "mcp_read",
            });
            return rpcResult(
              msg.id,
              toolText(renderSearchResults(project, query, results, total)),
            );
          } catch {
            // fail-open to the recency read below
          }
        }
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
      case "search_memory": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query)
          return rpcResult(
            msg.id,
            toolText("missing required argument: query", true),
          );
        const deps = indexDeps(env);
        if (!deps)
          return rpcResult(
            msg.id,
            toolText("memory search is not enabled on this gateway", true),
          );
        const kinds = Array.isArray(args.kinds)
          ? args.kinds.filter((k): k is string => typeof k === "string")
          : undefined;
        const { results, total } = await retrieve(deps, {
          space: member.space,
          project: project ? slug(project) : undefined,
          query,
          budgetTokens: DEFAULT_BUDGET_TOKENS,
          kinds,
          trigger: "search_memory",
        });
        return rpcResult(
          msg.id,
          toolText(
            renderSearchResults(project || undefined, query, results, total),
          ),
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
        const authorSupersedes = Array.isArray(args.supersedes)
          ? args.supersedes.filter((x): x is string => typeof x === "string")
          : [];
        const deps = indexDeps(env);
        let conflicts: Awaited<ReturnType<typeof detectWriteConflicts>> = [];
        if (deps) {
          try {
            conflicts = await detectWriteConflicts(
              deps.db,
              deps.embed,
              deps.gen,
              member.space,
              project,
              payload,
              { skipIds: authorSupersedes },
            );
          } catch {
            // fail-open: write already committed
          }
        }
        // Index ingest runs async (ctx.waitUntil): LLM fact extraction would
        // add ~1-3s to the write, and the ledger entry is already committed and
        // served by the recency read, so read-your-own-writes on the extracted
        // view is worth a few seconds' eventual consistency (design §0.2).
        // Fail-open — the webhook/cron paths re-derive from the ledger if this
        // misses. Without a ctx (tests / no-ctx runtime) run inline.
        const runIngest = async () => {
          try {
            const deps = indexDeps(env);
            if (deps) {
              await ingestEntries(
                deps.db,
                deps.embed,
                deps.gen,
                member.space,
                project,
                [entry],
                { authorSupersedes },
              );
            }
          } catch {
            // swallow: reconcile cron re-derives the doc from the ledger
          }
        };
        if (ctx) ctx.waitUntil(runIngest());
        else await runIngest();
        return rpcResult(
          msg.id,
          toolText(
            formatWriteResult(
              {
                type: entry.type,
                author: entry.author,
                timestamp: entry.timestamp,
                file: entry.file,
              },
              project,
              conflicts,
              authorSupersedes,
            ),
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
