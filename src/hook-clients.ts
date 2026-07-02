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
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: text,
        },
      });
    case "codex":
      // Codex SessionStart injection is byte-identical to Claude Code today, but
      // kept a separate case so a future divergence in either tool is a one-line
      // change (see spec decision a).
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
 * Stop-hook envelope that ASKS the model to self-review (write-trigger Path C).
 *
 * Unlike SessionStart, the Stop event can re-engage the model: Claude Code accepts
 * `hookSpecificOutput.additionalContext` on Stop as non-error feedback that continues
 * the conversation. `raw` emits the text verbatim.
 *
 * Cursor and Codex are now supported: Cursor re-engages via followup_message,
 * Codex uses decision:block with reason to trigger a re-engagement. Self-review
 * is available to all three tools; raw still emits verbatim.
 */
export function renderStopReview(client: HookClient, text: string): string {
  switch (client) {
    case "raw":
      return text;
    case "claude-code":
      return JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "Stop",
          additionalContext: text,
        },
      });
    case "codex":
      // Codex Stop re-engages differently from Claude Code: decision:block makes
      // `reason` the next user prompt.
      return JSON.stringify({ decision: "block", reason: text });
    case "cursor":
      // Cursor Stop re-engages via followup_message (auto-submitted as next user
      // message); loop protection is loop_count/loop_limit (see stop-hook + config).
      return JSON.stringify({ followup_message: text });
  }
}

/**
 * Stop-hook no-op: let the turn end with no injected review. Used on the loop-guard
 * path (stop_hook_active) and the fail-open path.
 */
export function renderStopNoop(client: HookClient): string {
  return client === "raw" ? "" : "{}";
}
