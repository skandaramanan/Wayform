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
import { defaultProject } from "./config.js";
import { reviewInstruction } from "./review-prompt.js";
import { resolveClient, renderStopReview, renderStopNoop, } from "./hook-clients.js";
import { isMain } from "./is-main.js";
export async function runStopHook() {
    // Resolved here (not at module load) so the dispatcher can set the client from
    // the subcommand arg before calling.
    const client = resolveClient(process.env.MEMORYLAYER_HOOK_CLIENT);
    const emitNoop = () => {
        process.stdout.write(renderStopNoop(client));
        process.exit(0);
    };
    const readStdin = async () => {
        if (process.stdin.isTTY)
            return "";
        let data = "";
        try {
            for await (const chunk of process.stdin)
                data += chunk;
        }
        catch {
            // stdin not readable — treat as empty payload.
        }
        return data;
    };
    const raw = await readStdin();
    // Loop guard: if we cannot confirm we are NOT already in a hook-driven
    // continuation, the safe choice is to let the turn end (never risk a loop).
    // Client-agnostic: Claude Code / Codex set stop_hook_active; Cursor increments
    // loop_count (and enforces loop_limit in config as a hard backstop).
    let payload = {};
    try {
        payload = raw.trim() ? JSON.parse(raw) : {};
    }
    catch {
        emitNoop();
    }
    const isContinuation = payload.stop_hook_active === true ||
        (typeof payload.loop_count === "number" && payload.loop_count > 0);
    if (isContinuation)
        emitNoop();
    const project = process.env.MEMORYLAYER_PROJECT?.trim() || defaultProject();
    process.stdout.write(renderStopReview(client, reviewInstruction(project)));
    process.exit(0);
}
if (isMain(import.meta.url)) {
    void runStopHook();
}
//# sourceMappingURL=stop-hook.js.map