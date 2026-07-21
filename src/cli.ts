#!/usr/bin/env node
/**
 * The single `wayform` command. Routes subcommands so the tool is one
 * installable binary (no bash launchers, no separate entrypoints to wire):
 *
 *   wayform                       -> MCP server (default)
 *   wayform hook <client>         -> read hook
 *   wayform prompt-hook <client>  -> Claude UserPromptSubmit → /hook/prompt
 *   wayform stop-review <client>  -> Stop no-op (legacy; re-engagement removed)
 *   wayform init [flags]          -> installer (add --remote for hosted members)
 *   wayform doctor                -> local diagnostics
 *   wayform space create [flags]  -> Plan C: provision a new hosted space
 *
 * `hook`/`prompt-hook`/`stop-review` set MEMORYLAYER_HOOK_CLIENT from the positional arg, then
 * delegate to the neutral run functions (which self-load .memorylayer-hook.env).
 */
import { loadHookEnv } from "./config.js";
import { runServer } from "./index.js";
import { runHook } from "./hook.js";
import { runPromptHook } from "./prompt-hook.js";
import { runStopHook } from "./stop-hook.js";
import { runInit } from "./init.js";
import { runDoctor } from "./doctor.js";
import { runSpaceCreate } from "./space-create.js";

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
    case "prompt-hook":
      if (rest[0]) process.env.MEMORYLAYER_HOOK_CLIENT = rest[0];
      await runPromptHook();
      return;
    case "stop-review":
      if (rest[0]) process.env.MEMORYLAYER_HOOK_CLIENT = rest[0];
      await runStopHook();
      return;
    case "init":
      await runInit(rest);
      return;
    case "doctor":
      await runDoctor();
      return;
    case "space":
      if (rest[0] === "create") {
        await runSpaceCreate(rest.slice(1));
        return;
      }
      console.error(
        `Unknown "space" subcommand "${rest[0]}". Use: wayform space create --space <name> --owner <owner> --repo <repo> --gateway <url>`,
      );
      process.exit(1);
      return;
    case undefined:
      await runServer();
      return;
    default:
      console.error(
        `Unknown command "${sub}". Use: wayform [hook|prompt-hook|stop-review|init|doctor|space] …`,
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
