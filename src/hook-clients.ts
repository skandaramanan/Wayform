/**
 * The per-vendor adapter layer — and the whole of what is NOT vendor-neutral.
 *
 * The store, the MCP contract, and the context markdown are all vendor-neutral.
 * The only thing a client owns is the JSON envelope its session-start hook
 * expects. Keeping that envelope isolated here means onboarding a new tool is a
 * single `case`, and the neutral core (store read + projection) never changes.
 */
export type HookClient = "cursor" | "claude-code" | "raw";

/** Map the configured client string to a known adapter; default to Cursor. */
export function resolveClient(raw: string | undefined): HookClient {
  switch ((raw ?? "").trim().toLowerCase()) {
    case "claude-code":
    case "claude_code":
    case "claudecode":
      return "claude-code";
    case "raw":
      return "raw";
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
