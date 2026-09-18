/**
 * The MCP tool contract: names, descriptions and JSON schemas advertised by
 * tools/list. Descriptions are prompts — they decide when agents call a tool —
 * so they live apart from the transport (mcp.ts) and the services behind it.
 */
import {
  FACT_KINDS,
  MAX_CLIENT_FACTS,
  MAX_CLIENT_FACT_CHARS,
} from "./extract.js";

export const TOOLS = [
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
    name: "transition_plan",
    title: "Move a team plan through its lifecycle",
    description:
      "Use this to move plan #N forward: draft → active (agreed) → building " +
      "(an agent is implementing it) → shipped (merged). When shipping, pass " +
      "`decisions` — what the plan settled, as atomic facts with their " +
      "'because' — so they join the team's memory; the plan's checklist then " +
      "leaves search. Use to='superseded' with superseded_by when another " +
      "plan replaces this one.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "The shared project name." },
        plan: {
          type: "string",
          description: "Plan number ('#12' or '12') or plan id.",
        },
        to: {
          type: "string",
          enum: ["active", "building", "shipped", "superseded"],
        },
        agent: {
          type: "string",
          description: "When to='building': who builds it, e.g. 'claude-code'.",
        },
        commit_sha: {
          type: "string",
          description: "When to='shipped': the merge commit.",
        },
        decisions: {
          type: "array",
          maxItems: MAX_CLIENT_FACTS,
          description:
            "When to='shipped': the decisions this plan produced, each " +
            "self-contained with its 'because'. Indexed as given — no LLM " +
            "extraction.",
          items: {
            type: "object",
            properties: {
              kind: { type: "string", enum: [...FACT_KINDS] },
              body: { type: "string", maxLength: MAX_CLIENT_FACT_CHARS },
              entities: { type: "array", items: { type: "string" } },
            },
            required: ["body"],
          },
        },
        produced_fact_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "When to='shipped': ids of facts already recorded while building.",
        },
        supersedes: {
          type: "array",
          items: { type: "string" },
          description: "When to='shipped': fact ids the new decisions replace.",
        },
        superseded_by: {
          type: "string",
          description: "When to='superseded': the replacing plan (#N or id).",
        },
      },
      required: ["project", "plan", "to"],
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
