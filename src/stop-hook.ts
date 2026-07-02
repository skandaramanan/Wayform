#!/usr/bin/env node
/**
 * Stop-hook entrypoint — the write-side counterpart to hook.ts (write-trigger Path C).
 *
 * A client runs this at the END OF EVERY TURN (Claude Code `Stop`). It injects a
 * self-review instruction so the model records a decision it just settled, without the
 * human having to remember to. Per-turn (not session-end) because SessionEnd is
 * cleanup-only and cannot re-engage the model; only Stop can.
 *
 * LOOP GUARD is load-bearing: when the model is already continuing because of THIS hook,
 * the client sets stop_hook_active=true on the payload. We MUST emit a no-op then, or we
 * create an infinite Stop loop.
 *
 * FAIL-OPEN: on any error (unparseable payload, unknown state) emit the client no-op and
 * exit 0. A hook that traps a turn would itself cause the "can't rely on this" failure
 * this feature exists to prevent.
 */
import { reviewInstruction } from "./review-prompt.js";
import {
  resolveClient,
  renderStopReview,
  renderStopNoop,
  type HookClient,
} from "./hook-clients.js";

const client: HookClient = resolveClient(process.env.MEMORYLAYER_HOOK_CLIENT);

function emitNoop(): never {
  process.stdout.write(renderStopNoop(client));
  process.exit(0);
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  let data = "";
  try {
    for await (const chunk of process.stdin) data += chunk;
  } catch {
    // stdin not readable — treat as empty payload.
  }
  return data;
}

async function main(): Promise<void> {
  const raw = await readStdin();

  // Loop guard: if we cannot confirm we are NOT already in a hook-driven
  // continuation, the safe choice is to let the turn end (never risk a loop).
  let payload: { stop_hook_active?: boolean };
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    emitNoop();
  }
  if (payload.stop_hook_active === true) emitNoop();

  const project = process.env.MEMORYLAYER_PROJECT?.trim() || "memorylayer";
  process.stdout.write(renderStopReview(client, reviewInstruction(project)));
  process.exit(0);
}

main().catch(() => emitNoop());
