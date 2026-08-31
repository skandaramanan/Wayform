/**
 * The per-vendor adapter layer — and the whole of what is NOT vendor-neutral.
 *
 * The store, the MCP contract, and the context markdown are all vendor-neutral.
 * The only thing a client owns is the JSON envelope its session-start hook
 * expects. Keeping that envelope isolated here means onboarding a new tool is a
 * single `case`, and the neutral core (store read + projection) never changes.
 */
export type HookClient = "cursor" | "claude-code" | "raw" | "codex";

/** Map the configured client string to a known adapter; default to Cursor. */
export function resolveClient(raw: string | undefined): HookClient {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "claude-code":
    case "claude_code":
    case "claudecode":
      return "claude-code";
    case "raw":
      return "raw";
    case "codex":
      return "codex";
    default:
      return "cursor";
  }
}

/** Envelope emitted when there IS context to inject. */
export function renderContext(client: HookClient, text: string): string {
  switch (client) {
    case "raw":
      // No envelope: clients whose start hook injects stdout verbatim.
      return text;
    case "claude-code":
    case "codex":
      // Codex SessionStart injection is byte-identical to Claude Code today;
      // a future divergence splits the fallthrough (see spec decision a).
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: text,
        },
      });
    case "cursor":
      return JSON.stringify({ additional_context: text });
  }
}

/**
 * Envelope emitted when there is NOTHING to inject (empty store, or the
 * fail-open path). Must be a valid no-op for the client so the session is
 * untouched.
 */
export function renderEmpty(client: HookClient): string {
  return client === "raw" ? "" : "{}";
}

/**
 * UserPromptSubmit envelope (Claude Code) — hidden additionalContext beside
 * the submitted prompt. Other clients return empty no-op JSON.
 */
export function renderPromptContext(client: HookClient, text: string): string {
  if (client !== "claude-code") return renderEmpty(client);
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: text,
    },
  });
}


/**
 * PreToolUse envelope (Claude Code) — the one place wayform can stop an action
 * before it happens. Only Claude Code exposes a blocking pre-execution hook we
 * have verified, exactly as only Claude Code supports UserPromptSubmit
 * injection; other clients get the empty no-op until their contract is checked.
 *
 * "deny" is never emitted in this phase (spec decision 1): a false positive on
 * ask costs one keystroke, on deny it costs the feature.
 */
export function renderGuardDecision(
  client: HookClient,
  decision: "ask" | "allow",
  reason: string,
): string {
  if (client !== "claude-code" || decision === "allow") {
    return renderEmpty(client);
  }
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "ask",
      permissionDecisionReason: `Wayform — this contradicts a recorded team decision:\n\n${reason}`,
    },
  });
}
