#!/usr/bin/env node
/**
 * The single `memorylayer` command. Routes subcommands so the tool is one
 * installable binary (no bash launchers, no separate entrypoints to wire):
 *
 *   memorylayer                       -> MCP server (default)
 *   memorylayer hook <client>         -> read hook
 *   memorylayer stop-review <client>  -> Stop/write-review hook
 *   memorylayer init [flags]          -> installer
 *
 * `hook`/`stop-review` set MEMORYLAYER_HOOK_CLIENT from the positional arg, then
 * delegate to the neutral run functions (which self-load .memorylayer-hook.env).
 */
import { loadHookEnv } from "./config.js";
import { runServer } from "./index.js";
import { runHook } from "./hook.js";
import { runStopHook } from "./stop-hook.js";
import { runInit } from "./init.js";

async function main(): Promise<void> {
  // Self-load .memorylayer-hook.env from the project cwd for every subcommand,
  // so the command is self-contained (no bash launcher). loadConfig stays pure.
  loadHookEnv();

  const [sub, ...rest] = process.argv.slice(2);

  switch (sub) {
    case "hook":
      if (rest[0]) process.env.MEMORYLAYER_HOOK_CLIENT = rest[0];
      await runHook();
      return;
    case "stop-review":
      if (rest[0]) process.env.MEMORYLAYER_HOOK_CLIENT = rest[0];
      await runStopHook();
      return;
    case "init":
      await runInit(rest);
      return;
    case undefined:
      await runServer();
      return;
    default:
      console.error(
        `Unknown command "${sub}". Use: memorylayer [hook|stop-review|init] …`,
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
