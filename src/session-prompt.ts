/**
 * Session-start + MCP invocation copy.
 *
 * Lives in one place so the always-on session-start injection and the MCP
 * `initialize.instructions` field stay in lockstep. Pattern notes (why this
 * shape, not a vaguer "use memory when helpful"):
 * - Tool-FORCING language for private/collaborative facts (training data is stale).
 * - Explicit when / when-not + negatives to stop wrong-tool and no-tool failures.
 * - Order constraint: search/read before re-deciding; write only after settled.
 * - Separate policy (this block) from data (briefing / recency dump).
 * - Keep under ~300 words so it competes for attention, not context budget.
 */

/** Data-side framing for the briefing / recency dump that follows the playbook. */
export function sessionPreamble(project: string): string {
  return (
    `The following is shared planning memory (MemoryLayer) for project ` +
    `"${project}", loaded automatically at session start. Treat these recorded ` +
    `decisions and context as already-known; do not ask the user to re-explain ` +
    `them.`
  );
}

/**
 * Operating rules injected at session start (before the data briefing).
 * This is the mid-session pull lever — the briefing alone makes models assume
 * they "already have memory" and never call tools again.
 */
/** Options for copy that only applies on some planes: `supersedes` is a
 *  gateway-only write_context capability, so local-stdio callers omit it and
 *  the amend guidance stays out of their playbook. */
export interface PlaybookOpts {
  supersedes?: boolean;
}

export function invocationPlaybook(
  project: string,
  opts: PlaybookOpts = {},
): string {
  return [
    `## MemoryLayer — required tool policy (project "${project}")`,
    ``,
    `The briefing below is a SELECTIVE snapshot, not the full store. Collaborator ` +
      `decisions live in MemoryLayer tools — not in your training data. Prefer ` +
      `these tools over guessing or asking the user to re-explain recorded work.`,
    ``,
    `### MUST call`,
    `- \`search_memory(query)\` BEFORE contradicting, reversing, or re-deciding ` +
      `anything that might already be settled — and whenever the topic is absent ` +
      `or unclear in "memory covers", Open questions, or Recent decisions.`,
    `- \`search_memory(query)\` BEFORE asking the user a clarifying question — ` +
      `the answer is often recorded. Only ask if memory comes back empty; never ` +
      `ask for information you could have retrieved.`,
    `- \`search_memory(query)\` BEFORE recommending an action or approach — check ` +
      `whether it was already recommended or already done; acknowledge that ` +
      `instead of repeating it.`,
    `- \`read_context(project="${project}", query=…)\` for depth on ONE topic ` +
      `(after search, or when Open questions / Unresolved conflicts touch the work).`,
    `- \`write_context(project="${project}", type, payload)\` when THIS turn ` +
      `settles "we decided X because Y" or durable background not already stored — ` +
      `including durable conclusions YOU produced (a design, plan, or non-obvious ` +
      `finding), written as a condensed summary. Not for open options or ` +
      `intermediate reasoning.`,
    ...(opts.supersedes
      ? [
          `- To UPDATE or CORRECT a recorded decision: \`write_context\` the new ` +
            `version with \`supersedes: [<old fact id from search results>]\` — ` +
            `never write an unlinked near-duplicate.`,
        ]
      : []),
    `- \`memory_feedback(fact_id, useful|wrong|stale)\` after a retrieved fact ` +
      `clearly helped or misled (use the fact id from tool results).`,
    ``,
    `### MUST NOT`,
    `- Re-call queryless \`read_context\` just to "refresh" — session-start already ` +
      `injected canon/recency.`,
    `- Invent prior decisions, silently pick a side on Unresolved conflicts, or ` +
      `treat the briefing as exhaustive.`,
    `- Skip search because the briefing "looks related" — if you would change a ` +
      `settled call, search first.`,
    ``,
    `### Order`,
    `search_memory (or read_context with query) → then decide/advise → ` +
      `write_context only if settled. Empty/irrelevant results: say so; do not ` +
      `fill gaps from memory. Tool errors: retry once with fixed args, then report ` +
      `— never invent a result.`,
  ].join("\n");
}

/** Full session-start payload: policy first, then data framing + body. */
export function composeSessionStartText(
  project: string,
  body: string,
  opts: PlaybookOpts = {},
): string {
  return (
    `${invocationPlaybook(project, opts)}\n\n---\n\n` +
    `${sessionPreamble(project)}\n\n${body}`
  );
}

/**
 * Shorter twin for MCP `initialize.instructions` (no briefing present there).
 * Same forcing rules; names the default project when the agent is unsure.
 */
export function mcpInstructions(
  defaultProject: string,
  opts: PlaybookOpts = {},
): string {
  return (
    `This server holds shared planning memory (decisions and durable context) ` +
    `for collaborators. Default project if unsure: "${defaultProject}". ` +
    `MUST: call search_memory before contradicting or re-deciding settled work, ` +
    `before asking the user a clarifying question memory might answer, and ` +
    `before recommending an action that may already be recommended or done; ` +
    `call read_context(project, query=…) for topic depth (if a session-start ` +
    `briefing was already injected, do NOT queryless re-read just to refresh); ` +
    `call write_context only for deliberate "we decided X because Y", durable ` +
    `background, or a condensed durable conclusion you produced — not every ` +
    `reasoning step; ` +
    (opts.supersedes
      ? `to update or correct a recorded decision, write_context the new ` +
        `version with supersedes:[old fact id from search results] instead of ` +
        `a near-duplicate; `
      : ``) +
    `call memory_feedback(fact_id, useful|wrong|stale) when a retrieved fact ` +
    `helped or misled. Prefer these tools over guessing or asking the user to ` +
    `re-explain recorded decisions.`
  );
}
