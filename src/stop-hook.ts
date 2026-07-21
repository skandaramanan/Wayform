#!/usr/bin/env node
/**
 * Stop-hook entrypoint — formerly write-trigger Path C (model re-engagement).
 *
 * Per recorded decision da491a7d, Stop re-engagement is removed: visible extra
 * chats and double model cost across Cursor / Claude Code / Codex. This entry
 * always emits the client no-op so existing Stop wiring remains harmless until
 * configs drop it. Write capture leans on tool descriptions, session playbook,
 * /remember, and (Claude) UserPromptSubmit → /hook/prompt.
 *
 * FAIL-OPEN: always exit 0 with a no-op envelope.
 */
import {
  resolveClient,
  renderStopNoop,
  type HookClient,
} from "./hook-clients.js";
import { isMain } from "./is-main.js";

/** Kept for tests / callers that still import the counter helper. */
export function bumpStopCount(_sessionId: string): number {
  return 0;
}

/** Kept for tests that still import the transcript gate helper. */
export function wroteContextThisTurn(_transcriptPath: string): boolean {
  return false;
}

export async function runStopHook(): Promise<void> {
  const client: HookClient = resolveClient(process.env.MEMORYLAYER_HOOK_CLIENT);

  const emitNoop = (): never => {
    process.stdout.write(renderStopNoop(client));
    process.exit(0);
  };

  // Drain stdin so the client's write never blocks.
  if (!process.stdin.isTTY) {
    try {
      for await (const _ of process.stdin) {
        // discard
      }
    } catch {
      // ignore
    }
  }

  emitNoop();
}

if (isMain(import.meta.url)) {
  void runStopHook();
}
