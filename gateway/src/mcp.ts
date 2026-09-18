import type { Env, HandlerCtx } from "./env.js";
import { resolveMember, type SpaceMember } from "./tenancy.js";
import {
  readEntriesCached,
  warmRecencyCache,
  writeEntry,
} from "./github-store.js";
import { projectContext } from "../../src/context-format.js";
import { mcpInstructions } from "../../src/session-prompt.js";
import { slug } from "../../src/slug.js";
import { DEFAULT_BUDGET_TOKENS } from "../../src/token-budget.js";
import type { EntryType } from "../../src/frontmatter.js";
import { indexDeps } from "./deps.js";
import {
  retrieve,
  renderSearchResults,
  SEARCH_MAX_FACTS,
} from "./retrieval.js";
import { ingestEntries } from "./ingest.js";
import {
  clientFacts,
  FACT_KINDS,
  MAX_CLIENT_FACTS,
  MAX_CLIENT_FACT_CHARS,
} from "./extract.js";
import { inviteGithubUser, revokeGithubUser } from "./spaces.js";
import {
  createPlan,
  editPlan,
  listProjectPlans,
  readPlan,
  renderPlan,
  renderPlanList,
  type PlanCtx,
} from "./plans.js";
import { listSessions, revokeSession } from "./sessions.js";
import {
  detectWriteConflicts,
  formatDuplicateResult,
  formatWriteResult,
  type WriteCheck,
} from "./supersede.js";

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
      "Use this when you need shared planning memory for a project: either a " +
      "queryless recency snapshot (after session-start, prefer NOT re-calling " +
      "queryless — use a query instead) or depth on ONE topic via query=. " +
      "Use query= when looking for a specific past decision or topic across " +
      "the whole indexed history. Do NOT use this to invent decisions, to " +
      "refresh after every turn, or when search_memory already answered.",
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
      "Use this when THIS turn settles a decision or durable background the " +
      "team should keep — including soft phrasing like 'log this for the team', " +
      "'note that we decided…', 'remember we…', 'save this', or '/remember'. " +
      "Also use it for condensed durable conclusions YOU produced (a design, " +
      "plan, or non-obvious finding). Write 'we decided X because Y' (or clear " +
      "context), not open options or intermediate reasoning. To UPDATE or " +
      "CORRECT an already-recorded decision, write the new version with " +
      "supersedes: [old fact id from search results] — never an unlinked " +
      "near-duplicate. Do NOT use this for every reasoning step, speculative " +
      "ideas, or restating what is already stored.",
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
            "Live fact ids this entry replaces or corrects (shown as `id:` in search results). Use whenever updating/amending a recorded decision. Skips conflict checks for those ids; links after ingest without judge.",
        },
        facts: {
          type: "array",
          maxItems: MAX_CLIENT_FACTS,
          description:
            "Strongly preferred: the payload pre-split into atomic facts, each " +
            "understandable ALONE and carrying its own 'because'. When given, " +
            "the server indexes exactly these instead of running its own LLM " +
            "extraction — searchable immediately, no extraction cost, and " +
            "reused on every re-index. The payload stays the human-readable " +
            "record.",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: [...FACT_KINDS] },
              body: {
                type: "string",
                maxLength: MAX_CLIENT_FACT_CHARS,
                description: "One self-contained fact.",
              },
              tier: {
                type: "string",
                enum: ["normal", "canon"],
                description:
                  "'canon' ONLY for standing rules ('always X', 'never Y'); status updates are never canon.",
              },
              entities: {
                type: "array",
                items: { type: "string" },
                description:
                  "Short topic tags, e.g. 'mcp-config', 'neuron-budget'.",
              },
            },
            required: ["body"],
          },
        },
      },
      required: ["project", "payload"],
    },
  },
  {
    name: "search_memory",
    title: "Search the shared memory",
    description:
      "Use this BEFORE contradicting, reversing, or re-deciding anything that " +
      "may already be settled; BEFORE asking the user a clarifying question " +
      "memory might answer; and BEFORE recommending an action that may already " +
      "be recommended or done. Searches ALL recorded decisions/context " +
      "(keyword + semantic), not just recent entries. Do NOT skip this because " +
      "the session briefing 'looks related'.",
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
  {
    name: "memory_feedback",
    title: "Rate a retrieved memory fact",
    description:
      "Use this after a retrieved fact clearly helped or misled: 'useful', " +
      "'wrong', or 'stale'. Pass the fact id shown in search/read results. " +
      "Do NOT call on every result — only when the verdict is clear.",
    inputSchema: {
      type: "object",
      properties: {
        fact_id: {
          type: "string",
          description:
            "The id of the fact to rate, as shown in search results.",
        },
        verdict: {
          type: "string",
          enum: ["useful", "wrong", "stale"],
          description: "'useful', 'wrong', or 'stale'.",
        },
      },
      required: ["fact_id", "verdict"],
    },
  },
  {
    name: "supersede_facts",
    title: "Confirm which existing facts an entry replaced",
    description:
      "Use this right after write_context when its result lists existing " +
      "facts your entry may replace or contradict: pass ONLY the ones your " +
      "entry really makes obsolete (changed, reversed, completed, answered). " +
      "They leave briefings and search. Do not pass facts that are merely " +
      "related or restated.",
    inputSchema: {
      type: "object",
      properties: {
        fact_ids: {
          type: "array",
          items: { type: "string" },
          description: "Fact ids from the write_context result (or search).",
        },
        replaced_by_entry: {
          type: "string",
          description: 'The entry id write_context reported (e.g. "0c72c6e5").',
        },
      },
      required: ["fact_ids", "replaced_by_entry"],
    },
  },
  {
    name: "create_plan",
    title: "Create a team engineering plan",
    description:
      "Use this to record an engineering plan (markdown: goal, approach, " +
      "checklist) as a living, versioned plan the whole team and every agent " +
      "can read — instead of a local plan file. Pass `inherits` with the fact " +
      "ids of recorded decisions the plan builds on. Returns the plan's " +
      "number (#N). New plans start as draft.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "The shared project name, e.g. 'business-one'.",
        },
        title: { type: "string", description: "Short plan title." },
        body: {
          type: "string",
          description: "The plan in markdown.",
        },
        repo: {
          type: "string",
          description: "Code repo the plan targets, e.g. 'acme/app'.",
        },
        branch: { type: "string", description: "Target branch." },
        inherits: {
          type: "array",
          items: { type: "string" },
          description:
            "Fact ids (from search results) of decisions this plan builds on.",
        },
      },
      required: ["project", "title", "body"],
    },
  },
  {
    name: "read_plan",
    title: "Read a team plan, or list plans",
    description:
      "Use this to read plan #N (its state, linked decisions, runs and body) " +
      "or, with no `plan`, to list the project's plans. Pass `version` to read " +
      "an older version — every edit is kept.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "The shared project name.",
        },
        plan: {
          type: "string",
          description: "Plan number ('#12' or '12') or plan id. Omit to list.",
        },
        version: {
          type: "integer",
          exclusiveMinimum: 0,
          description: "A specific version; default the latest.",
        },
      },
      required: ["project"],
    },
  },
  {
    name: "edit_plan",
    title: "Edit a team plan (new version)",
    description:
      "Use this to change a draft, active or building plan's body or title. " +
      "Every body edit is a new version; old versions stay readable via " +
      "read_plan(version=). Shipped and superseded plans are frozen.",
    inputSchema: {
      type: "object",
      properties: {
        project: {
          type: "string",
          description: "The shared project name.",
        },
        plan: {
          type: "string",
          description: "Plan number ('#12' or '12') or plan id.",
        },
        body: {
          type: "string",
          description: "The full new markdown body.",
        },
        title: { type: "string", description: "A new title." },
      },
      required: ["project", "plan"],
    },
  },
  {
    name: "invite_member",
    title: "Invite a GitHub user to this space",
    description:
      "Grant a teammate access to this Wayform space by GitHub username. " +
      "They sign in with GitHub (Connect / wayform login); you never send them a token. " +
      "Admin only.",
    inputSchema: {
      type: "object",
      properties: {
        github_username: {
          type: "string",
          description: "GitHub login to invite, e.g. 'dberquist'.",
        },
      },
      required: ["github_username"],
    },
  },
  {
    name: "revoke_member",
    title: "Revoke a GitHub user's access to this space",
    description:
      "Remove a GitHub username from this Wayform space (pending invite or live member). Admin only.",
    inputSchema: {
      type: "object",
      properties: {
        github_username: {
          type: "string",
          description: "GitHub login to revoke.",
        },
      },
      required: ["github_username"],
    },
  },
  {
    name: "list_sessions",
    title: "List the apps connected to your Wayform account",
    description:
      "Use this when the user asks which apps, clients, or devices are connected to their Wayform account, or wants to review or audit their own access. Shows every active session for YOUR account only, and marks the one you are using now. No arguments.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "revoke_session",
    title: "Disconnect one app from your Wayform account",
    description:
      "Use this when the user wants to disconnect, sign out, or revoke an app's access to their own Wayform account — for example after losing a laptop. Call list_sessions first to get the session id. Affects only YOUR account; use revoke_member instead to remove a teammate from the space.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session id from list_sessions.",
        },
      },
      required: ["session_id"],
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
      return toolsCall(msg, member, env, req, ctx);
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
  req: Request,
  ctx?: HandlerCtx,
): Promise<Response> {
  const fetchImpl = env.githubFetch ?? fetch;
  const args = msg.params?.arguments ?? {};
  const project = typeof args.project === "string" ? args.project : "";
  const toolName = msg.params?.name;
  const started = Date.now();
  const finish = (res: Response): Response => {
    console.log(
      JSON.stringify({
        evt: "mcp_tool",
        tool: toolName ?? "(none)",
        project: project || null,
        space: member.space,
        ms: Date.now() - started,
        status: res.status,
      }),
    );
    return res;
  };
  const needsProject = [
    "read_context",
    "write_context",
    "create_plan",
    "read_plan",
    "edit_plan",
  ];
  if (needsProject.includes(toolName ?? "") && !project)
    return finish(
      rpcResult(msg.id, toolText("missing required argument: project", true)),
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
            return finish(
              rpcResult(
                msg.id,
                toolText(renderSearchResults(project, query, results, total)),
              ),
            );
          } catch {
            // fail-open to the recency read below
          }
        }
        const { entries, total } = await readEntriesCached(
          env,
          member,
          project,
          budget,
          fetchImpl,
        );
        return finish(
          rpcResult(msg.id, toolText(projectContext(project, entries, total))),
        );
      }
      case "search_memory": {
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query)
          return finish(
            rpcResult(
              msg.id,
              toolText("missing required argument: query", true),
            ),
          );
        const deps = indexDeps(env);
        if (!deps)
          return finish(
            rpcResult(
              msg.id,
              toolText("memory search is not enabled on this gateway", true),
            ),
          );
        const kinds = Array.isArray(args.kinds)
          ? args.kinds.filter((k): k is string => typeof k === "string")
          : undefined;
        try {
          const { results, total } = await retrieve(deps, {
            space: member.space,
            project: project ? slug(project) : undefined,
            query,
            budgetTokens: DEFAULT_BUDGET_TOKENS,
            kinds,
            // Candidates for renderSearchResults, which groups them by entry.
            // Uncapped, a 4000-token budget of short facts returned ~68.
            maxResults: SEARCH_MAX_FACTS,
            trigger: "search_memory",
          });
          return finish(
            rpcResult(
              msg.id,
              toolText(
                renderSearchResults(
                  project || undefined,
                  query,
                  results,
                  total,
                ),
              ),
            ),
          );
        } catch {
          // Degrade parity with read_context: a transient index/AI failure
          // returns a useful non-error result instead of isError (one hard
          // failure teaches agents the tool is unreliable and they stop
          // calling it). With a project we can serve the recency read; the
          // whole-space form has no recency equivalent, so say so plainly.
          if (project) {
            const { entries, total } = await readEntriesCached(
              env,
              member,
              project,
              DEFAULT_BUDGET_TOKENS,
              fetchImpl,
            );
            return finish(
              rpcResult(
                msg.id,
                toolText(
                  `_Semantic search is temporarily unavailable — showing the most recent entries for "${project}" instead._\n\n` +
                    projectContext(project, entries, total),
                ),
              ),
            );
          }
          return finish(
            rpcResult(
              msg.id,
              toolText(
                "Memory search is temporarily unavailable. Retry shortly, or call read_context with a project name for its recent entries.",
              ),
            ),
          );
        }
      }
      case "write_context": {
        const type: EntryType =
          args.type === "context" ? "context" : "decision";
        const payload = typeof args.payload === "string" ? args.payload : "";
        if (!payload)
          return finish(
            rpcResult(
              msg.id,
              toolText("missing required argument: payload", true),
            ),
          );
        const authorSupersedes = Array.isArray(args.supersedes)
          ? args.supersedes.filter((x): x is string => typeof x === "string")
          : [];
        // Writer-split facts are validated here and persisted with the entry,
        // so this and every later re-index skips server-side extraction.
        const facts = clientFacts(args.facts, { type }) ?? undefined;
        const deps = indexDeps(env);
        // Conflict + duplicate check runs BEFORE the commit: it reads only
        // the index and the payload, so ordering it first costs nothing and
        // lets an enforced duplicate skip the commit entirely. Fail-open —
        // any check failure stores the write as if the check found nothing.
        let check: WriteCheck = { duplicate: null, conflicts: [] };
        if (deps) {
          try {
            check = await detectWriteConflicts(
              deps.db,
              deps.embed,
              deps.gen,
              member.space,
              project,
              payload,
              {
                skipIds: authorSupersedes,
                kind: type,
                timeoutMs: 2000,
                // Explicit supersedes = deliberate replacement; never
                // second-guess it with the dup gate.
                dedupe: authorSupersedes.length === 0,
                enforceDup: env.dupGateEnforce,
              },
            );
          } catch {
            // fail-open: store the write
          }
        }
        if (check.duplicate) {
          return finish(
            rpcResult(
              msg.id,
              toolText(formatDuplicateResult(check.duplicate, project)),
            ),
          );
        }
        const entry = await writeEntry(
          env,
          member,
          project,
          { type, payload, facts },
          fetchImpl,
        );
        // Hook projection must rebuild; recency is warmed (not deleted) so the
        // next queryless read never pays a cold GitHub fan-out.
        try {
          await env.ROUTING.delete(hookCacheKey(member.space, project));
          const { refresh } = await warmRecencyCache(
            env,
            member,
            project,
            entry,
            fetchImpl,
          );
          if (ctx) ctx.waitUntil(refresh);
          else await refresh;
        } catch {
          // swallow: stale/missing cache heals via TTL or next warm
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
                // Old facts the pre-commit check already judged "relates"
                // are not worth a second paid verdict for the same entry.
                { authorSupersedes, skipJudgeOld: check.relatedIds },
              );
            }
          } catch {
            // fail-open
          }
        };
        if (ctx) ctx.waitUntil(runIngest());
        else await runIngest();
        return finish(
          rpcResult(
            msg.id,
            toolText(
              formatWriteResult(
                entry,
                project,
                check.conflicts,
                authorSupersedes,
              ),
            ),
          ),
        );
      }
      case "memory_feedback": {
        const factId =
          typeof args.fact_id === "string" ? args.fact_id.trim() : "";
        const verdict = args.verdict;
        if (!factId)
          return finish(
            rpcResult(
              msg.id,
              toolText("missing required argument: fact_id", true),
            ),
          );
        if (verdict !== "useful" && verdict !== "wrong" && verdict !== "stale")
          return finish(
            rpcResult(
              msg.id,
              toolText("verdict must be one of: useful, wrong, stale", true),
            ),
          );
        const deps = indexDeps(env);
        if (!deps)
          return finish(
            rpcResult(
              msg.id,
              toolText("memory feedback is not enabled on this gateway", true),
            ),
          );
        try {
          const target = await deps.db.getDoc(member.space, factId);
          await deps.db.recordFeedback({
            space: member.space,
            project: target?.project ?? "",
            factId,
            member: member.author,
            verdict,
            ts: new Date().toISOString(),
          });
          return finish(
            rpcResult(
              msg.id,
              toolText(
                `Recorded '${verdict}' feedback on ${factId}. This will adjust its future ranking.`,
              ),
            ),
          );
        } catch (e) {
          console.warn(
            `[feedback] record failed for ${factId}: ${(e as Error).message}`,
          );
          return finish(
            rpcResult(
              msg.id,
              toolText(
                "couldn't record feedback right now (it was not saved)",
                true,
              ),
            ),
          );
        }
      }
      case "supersede_facts": {
        const factIds = Array.isArray(args.fact_ids)
          ? args.fact_ids
              .filter((x): x is string => typeof x === "string")
              .map((x) => x.trim())
              .filter(Boolean)
              .slice(0, 20)
          : [];
        const byEntry =
          typeof args.replaced_by_entry === "string"
            ? args.replaced_by_entry.trim()
            : "";
        if (factIds.length === 0 || !byEntry)
          return finish(
            rpcResult(
              msg.id,
              toolText(
                "missing required arguments: fact_ids and replaced_by_entry",
                true,
              ),
            ),
          );
        const deps = indexDeps(env);
        if (!deps)
          return finish(
            rpcResult(
              msg.id,
              toolText("supersession is not enabled on this gateway", true),
            ),
          );
        // The new entry is indexed a few seconds after write_context returns.
        // If it is not there yet, point at the entry itself: the cron's
        // dangling-pointer repair re-points it to the entry's fact.
        const live = (await deps.db.docsBySource(member.space, byEntry)).filter(
          (d) => !d.supersededBy,
        );
        const target = live[0]?.id ?? `${byEntry}#entry`;
        const done: string[] = [];
        const skipped: string[] = [];
        const projects = new Set<string>();
        for (const id of factIds) {
          const old = await deps.db.getDoc(member.space, id);
          if (!old || old.sourceId === byEntry) {
            skipped.push(id);
            continue;
          }
          await deps.db.markSuperseded(member.space, id, target);
          await deps.db.logSupersession({
            space: member.space,
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
          await env.ROUTING.delete(hookCacheKey(member.space, p)).catch(
            () => {},
          );
        }
        return finish(
          rpcResult(
            msg.id,
            toolText(
              `Marked ${done.length} fact(s) as replaced by entry ${byEntry}.` +
                (skipped.length
                  ? ` Skipped ${skipped.join(", ")} (not found, or part of that entry).`
                  : ""),
            ),
          ),
        );
      }
      case "create_plan":
      case "read_plan":
      case "edit_plan": {
        if (!env.DB)
          return finish(
            rpcResult(
              msg.id,
              toolText("plans are not enabled on this gateway", true),
            ),
          );
        const deps = indexDeps(env);
        const pc: PlanCtx = {
          env,
          member,
          db: env.DB,
          idx: deps?.db ?? null,
          embed: deps?.embed ?? null,
          fetchImpl,
        };
        const ref = typeof args.plan === "string" ? args.plan.trim() : "";
        if (toolName === "create_plan") {
          const v = await createPlan(pc, project, {
            title: args.title,
            body: args.body,
            repo: args.repo,
            branch: args.branch,
            inherits: args.inherits,
          });
          return finish(
            rpcResult(
              msg.id,
              toolText(
                `Created plan #${v.meta.seq} "${v.meta.title}" (id ${v.meta.id}, draft, v1)` +
                  (v.links.length
                    ? ` inheriting ${v.links.length} decision(s).`
                    : ".") +
                  (v.unknownInherits.length
                    ? ` Not linked (no such fact): ${v.unknownInherits.join(", ")}.`
                    : ""),
              ),
            ),
          );
        }
        if (toolName === "read_plan") {
          if (!ref)
            return finish(
              rpcResult(
                msg.id,
                toolText(
                  renderPlanList(project, await listProjectPlans(pc, project)),
                ),
              ),
            );
          const version =
            typeof args.version === "number" && args.version > 0
              ? Math.floor(args.version)
              : undefined;
          return finish(
            rpcResult(
              msg.id,
              toolText(renderPlan(await readPlan(pc, project, ref, version))),
            ),
          );
        }
        if (!ref)
          return finish(
            rpcResult(
              msg.id,
              toolText("missing required argument: plan", true),
            ),
          );
        const v = await editPlan(pc, project, ref, {
          title: args.title,
          body: args.body,
        });
        return finish(
          rpcResult(
            msg.id,
            toolText(
              `Plan #${v.meta.seq} "${v.meta.title}" is now v${v.meta.version}.`,
            ),
          ),
        );
      }
      case "list_sessions": {
        const out = await listSessions(env, member, req);
        return finish(rpcResult(msg.id, toolText(out.text, out.isError)));
      }
      case "revoke_session": {
        const out = await revokeSession(
          env,
          member,
          req,
          typeof args.session_id === "string" ? args.session_id : "",
        );
        return finish(rpcResult(msg.id, toolText(out.text, out.isError)));
      }
      case "invite_member":
      case "revoke_member": {
        if (member.role !== "admin") {
          return finish(
            rpcResult(
              msg.id,
              toolText("only a space admin can invite or revoke members", true),
            ),
          );
        }
        const login =
          typeof args.github_username === "string"
            ? args.github_username.trim()
            : "";
        if (!login) {
          return finish(
            rpcResult(
              msg.id,
              toolText("missing required argument: github_username", true),
            ),
          );
        }
        if (toolName === "invite_member") {
          await inviteGithubUser(env, member, login);
          return finish(
            rpcResult(
              msg.id,
              toolText(
                `Invited @${login}. They click Connect (or run wayform login) with GitHub — no token to paste.`,
              ),
            ),
          );
        }
        const revoked = await revokeGithubUser(env, member, login);
        if (revoked === "not_found") {
          return finish(
            rpcResult(
              msg.id,
              toolText(`@${login} is not a member of this space.`, true),
            ),
          );
        }
        return finish(
          rpcResult(msg.id, toolText(`Revoked @${login} from this space.`)),
        );
      }
      default:
        return finish(
          rpcResult(
            msg.id,
            toolText(`unknown tool: ${msg.params?.name ?? "(none)"}`, true),
          ),
        );
    }
  } catch (err) {
    return finish(rpcResult(msg.id, toolText((err as Error).message, true)));
  }
}
