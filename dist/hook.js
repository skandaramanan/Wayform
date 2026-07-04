#!/usr/bin/env node
/**
 * Session-start hook entrypoint.
 *
 * A client (Cursor `sessionStart`, Claude Code `SessionStart`, ...) runs this at
 * the start of every new session. It pulls the shared planning memory for a
 * project and prints it as injectable context, so a collaborator's decisions are
 * already present without anyone reading or pasting anything — the whole point of
 * the "unprompted read."
 *
 * Neutrality: everything here (store read + projection) is vendor-neutral. The
 * ONLY per-vendor thing is the output envelope, isolated in ./hook-clients.ts and
 * selected by MEMORYLAYER_HOOK_CLIENT (cursor | claude-code | raw). A new tool is
 * one `case` there; this file never changes.
 *
 * FAIL-OPEN is the load-bearing property: a broken read (offline, bad config,
 * empty store) must NEVER break the user's session. On any failure we emit the
 * client's empty no-op and exit 0, so the session starts as if no hook existed.
 */
import { loadConfig, defaultProject } from "./config.js";
import { ContextStore } from "./store.js";
import { projectContext } from "./context-format.js";
import { recordMetric } from "./metrics.js";
import { resolveClient, renderContext, renderEmpty, } from "./hook-clients.js";
import { isMain } from "./is-main.js";
export async function runHook() {
    // Resolved here (not at module load) so the dispatcher can set
    // MEMORYLAYER_HOOK_CLIENT from the subcommand arg before calling. Cannot throw,
    // so both the success and fail-open paths always know which envelope to emit.
    const client = resolveClient(process.env.MEMORYLAYER_HOOK_CLIENT);
    const emitEmpty = () => {
        process.stdout.write(renderEmpty(client));
        process.exit(0);
    };
    /** Drain stdin so the client's write never blocks; the payload is unused today. */
    const drainStdin = async () => {
        if (process.stdin.isTTY)
            return;
        try {
            for await (const _ of process.stdin) {
                // discard
            }
        }
        catch {
            // stdin not readable — irrelevant to producing context.
        }
    };
    try {
        await drainStdin();
        const project = process.env.MEMORYLAYER_PROJECT?.trim() || defaultProject();
        const cfg = loadConfig();
        const store = new ContextStore(cfg);
        await store.ensure();
        const { entries, total } = await store.read(project, cfg.readBudgetTokens);
        // Record the read before branching so an empty-store read still counts toward
        // read-rate. recordMetric is internally fail-open (never throws), so it cannot
        // divert the non-empty path into the catch/emitEmpty branch.
        await recordMetric(cfg, { source: "hook", event: "read", project, total });
        // An empty store has nothing worth injecting — start clean rather than pushing
        // a "(no entries yet)" placeholder into every session.
        if (total === 0)
            emitEmpty();
        const body = projectContext(project, entries, total);
        const text = `The following is shared planning memory (MemoryLayer) for project ` +
            `"${project}", loaded automatically at session start. Treat these recorded ` +
            `decisions and context as already-known; do not ask the user to re-explain ` +
            `them.\n\n${body}`;
        process.stdout.write(renderContext(client, text));
        process.exit(0);
    }
    catch {
        emitEmpty();
    }
}
if (isMain(import.meta.url)) {
    void runHook();
}
//# sourceMappingURL=hook.js.map