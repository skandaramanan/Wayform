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
 *
 * THROTTLE + GATES: each fire re-engages the model with the full conversation as input,
 * so firing every turn roughly doubles a session's model calls. We fire only every
 * FIRE_EVERY-th stop per session (counter in a tmpdir state file keyed by the payload's
 * session_id / conversation_id), and skip turns that cannot produce a useful review:
 * Cursor aborted/errored turns (status), Codex turns with no assistant text
 * (last_assistant_message), and Claude Code turns where write_context was already
 * called (transcript_path — the only tool whose transcript format is stable enough
 * to parse; Codex documents its transcript as unstable).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { defaultProject } from "./config.js";
import { reviewInstruction } from "./review-prompt.js";
import {
  resolveClient,
  renderStopReview,
  renderStopNoop,
  type HookClient,
} from "./hook-clients.js";
import { isMain } from "./is-main.js";

/** Fire the self-review on every Nth non-continuation stop of a session. */
const FIRE_EVERY = 4;

/**
 * Increment and return this session's stop counter. State lives in tmpdir (one small
 * file per session id; the OS reaps them). Fail-open: if the counter cannot be
 * read/written, return FIRE_EVERY so the review still fires.
 */
export function bumpStopCount(sessionId: string): number {
  const file = path.join(
    os.tmpdir(),
    `wayform-stop-${sessionId.replace(/[^\w.-]/g, "_")}`,
  );
  try {
    let count = 0;
    try {
      count = parseInt(fs.readFileSync(file, "utf8"), 10) || 0;
    } catch {
      // First stop of the session — no counter file yet.
    }
    count += 1;
    fs.writeFileSync(file, String(count));
    return count;
  } catch {
    return FIRE_EVERY;
  }
}

/**
 * True when the current turn already called write_context, so a self-review fire
 * would be pure redundant cost. Claude Code transcripts are JSONL; we walk backwards
 * from the end until the last REAL user message (tool_result carriers also arrive as
 * type "user" and don't end the turn). Fail-open: unparseable transcript → false.
 */
export function wroteContextThisTurn(transcriptPath: string): boolean {
  try {
    const lines = fs.readFileSync(transcriptPath, "utf8").trimEnd().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry: {
        type?: string;
        message?: { content?: unknown };
      };
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      const content = entry?.message?.content;
      const blocks = Array.isArray(content) ? content : [];
      if (entry?.type === "assistant") {
        if (
          blocks.some(
            (b) =>
              b?.type === "tool_use" &&
              typeof b?.name === "string" &&
              b.name.includes("write_context"),
          )
        ) {
          return true;
        }
      } else if (entry?.type === "user") {
        if (!blocks.some((b) => b?.type === "tool_result")) return false;
      }
    }
  } catch {
    // Missing/unreadable transcript — no gate.
  }
  return false;
}

export async function runStopHook(): Promise<void> {
  // Resolved here (not at module load) so the dispatcher can set the client from
  // the subcommand arg before calling.
  const client: HookClient = resolveClient(process.env.MEMORYLAYER_HOOK_CLIENT);

  const emitNoop = (): never => {
    process.stdout.write(renderStopNoop(client));
    process.exit(0);
  };

  const readStdin = async (): Promise<string> => {
    if (process.stdin.isTTY) return "";
    let data = "";
    try {
      for await (const chunk of process.stdin) data += chunk;
    } catch {
      // stdin not readable — treat as empty payload.
    }
    return data;
  };

  const raw = await readStdin();

  // Loop guard: if we cannot confirm we are NOT already in a hook-driven
  // continuation, the safe choice is to let the turn end (never risk a loop).
  // Client-agnostic: Claude Code / Codex set stop_hook_active; Cursor increments
  // loop_count (and enforces loop_limit in config as a hard backstop).
  let payload: {
    stop_hook_active?: boolean;
    loop_count?: number;
    session_id?: string;
    conversation_id?: string;
    status?: string;
    last_assistant_message?: string | null;
    transcript_path?: string | null;
  } = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    emitNoop();
  }
  const isContinuation =
    payload.stop_hook_active === true ||
    (typeof payload.loop_count === "number" && payload.loop_count > 0);
  if (isContinuation) emitNoop();

  // Gate: Cursor reports turn outcome; aborted/errored turns settled nothing worth
  // reviewing. Skipped turns don't advance the throttle counter.
  if (typeof payload.status === "string" && payload.status !== "completed") {
    emitNoop();
  }

  // Gate: Codex reports the turn's assistant text; a turn that produced none has
  // nothing to review. Only gates when the field is explicitly present-but-empty.
  if (
    "last_assistant_message" in payload &&
    !(payload.last_assistant_message ?? "").trim()
  ) {
    emitNoop();
  }

  // Throttle: fire only every FIRE_EVERY-th counted stop. Claude Code / Codex key by
  // session_id, Cursor by conversation_id; a payload with neither (never seen from a
  // real client) fires every turn, preserving pre-throttle behavior.
  const sessionId = payload.session_id || payload.conversation_id;
  if (sessionId && bumpStopCount(sessionId) % FIRE_EVERY !== 0) emitNoop();

  // Gate (checked only on firing turns to spare the file read): the model already
  // recorded a decision this turn — a review fire would be redundant cost.
  if (
    client === "claude-code" &&
    payload.transcript_path &&
    wroteContextThisTurn(payload.transcript_path)
  ) {
    emitNoop();
  }

  const project = process.env.MEMORYLAYER_PROJECT?.trim() || defaultProject();
  process.stdout.write(renderStopReview(client, reviewInstruction(project)));
  process.exit(0);
}

if (isMain(import.meta.url)) {
  void runStopHook();
}
