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
import { loadConfig, defaultProject, envVar } from "./config.js";
import { ContextStore } from "./store.js";
import { remoteHookRead } from "./remote-read.js";
import { syncPlanMirror } from "./plan-mirror.js";
import { projectContext } from "./context-format.js";
import { composeSessionStartText } from "./session-prompt.js";
import { recordMetric } from "./metrics.js";
import {
  resolveClient,
  renderContext,
  renderEmpty,
  type HookClient,
} from "./hook-clients.js";
import { isMain } from "./is-main.js";

export async function runHook(): Promise<void> {
  // Resolved here (not at module load) so the dispatcher can set
  // MEMORYLAYER_HOOK_CLIENT from the subcommand arg before calling. Cannot throw,
  // so both the success and fail-open paths always know which envelope to emit.
  const client: HookClient = resolveClient(envVar("HOOK_CLIENT"));

  let mirrored: Promise<void> = Promise.resolve();
  const finish = async (out: string): Promise<never> => {
    await mirrored;
    process.stdout.write(out);
    process.exit(0);
  };

  /** Drain stdin so the client's write never blocks; the payload is unused today. */
  const drainStdin = async (): Promise<void> => {
    if (process.stdin.isTTY) return;
    try {
      for await (const _ of process.stdin) {
        // discard
      }
    } catch {
      // stdin not readable — irrelevant to producing context.
    }
  };

  try {
    await drainStdin();

    const project = envVar("PROJECT")?.trim() || defaultProject();

    const cfg = loadConfig();

    // Started (not awaited) so the mirror write runs concurrently with the
    // remote read below; every exit path awaits `mirrored` via `finish`.
    mirrored = syncPlanMirror(
      cfg,
      project,
      process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    );

    // Remote-first (§2.2): the gateway's index serves the read; the local
    // clone is the offline fallback. remoteHookRead returns ready-to-inject
    // text ("" = empty store) or null meaning "gateway unusable — fall back".
    const remote = await remoteHookRead(cfg, project, cfg.readBudgetTokens);
    if (remote !== null) {
      await recordMetric(cfg, { source: "hook", event: "read", project });
      if (remote === "") return finish(renderEmpty(client));
      return finish(renderContext(client, remote));
    }

    // Gateway-only member (no local clone): there is nothing to fall back to.
    // Fail-open to the client's empty no-op rather than constructing a store
    // against an empty repo path.
    if (!cfg.repoUrl) return finish(renderEmpty(client));

    const store = new ContextStore(cfg);
    await store.ensure();
    const { entries, total } = await store.read(project, cfg.readBudgetTokens);

    // Record the read before branching so an empty-store read still counts toward
    // read-rate. recordMetric is internally fail-open (never throws), so it cannot
    // divert the non-empty path into the catch/emitEmpty branch.
    await recordMetric(cfg, { source: "hook", event: "read", project, total });

    // An empty store has nothing worth injecting — start clean rather than pushing
    // a "(no entries yet)" placeholder into every session.
    if (total === 0) return finish(renderEmpty(client));

    const body = projectContext(project, entries, total);
    const text = composeSessionStartText(project, body);

    return finish(renderContext(client, text));
  } catch {
    return finish(renderEmpty(client));
  }
}

if (isMain(import.meta.url)) {
  void runHook();
}
