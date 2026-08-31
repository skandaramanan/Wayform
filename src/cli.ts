#!/usr/bin/env node
/**
 * The single `wayform` command. Routes subcommands so the tool is one
 * installable binary (no bash launchers, no separate entrypoints to wire):
 *
 *   wayform                       -> MCP server (default)
 *   wayform hook <client>         -> read hook
 *   wayform prompt-hook <client>  -> Claude UserPromptSubmit → /hook/prompt
 *   wayform guard <client>        -> PreToolUse guard → /hook/guard
 *   wayform stop-review <client>  -> Stop no-op (legacy; re-engagement removed)
 *   wayform login                 -> GitHub OAuth; tokens go to the OS keychain
 *   wayform init [flags]          -> installer (add --remote for hosted members)
 *   wayform doctor                -> local diagnostics
 *   wayform space create [flags]  -> print App install URL + allowlist reminder
 *
 * `hook`/`prompt-hook` set MEMORYLAYER_HOOK_CLIENT from the positional arg, then
 * delegate to the neutral run functions (which self-load .memorylayer-hook.env).
 */
import { loadHookEnv } from "./config.js";
import { runServer } from "./index.js";
import { runHook } from "./hook.js";
import { runPromptHook } from "./prompt-hook.js";
import { runGuardHook } from "./guard-hook.js";
import { runInit } from "./init.js";
import { runDoctor } from "./doctor.js";
import { runSpaceCreate } from "./space-create.js";
import { runLogin } from "./oauth-login.js";

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
    case "guard":
      if (rest[0]) process.env.MEMORYLAYER_HOOK_CLIENT = rest[0];
      await runGuardHook();
      return;
    case "stop-review":
      // Stop re-engagement retired (da491a7d): emit the client no-op so stale
      // Stop wiring keeps working until configs drop it.
      process.stdout.write(rest[0] === "raw" ? "" : "{}");
      return;
    case "init":
      await runInit(rest);
      return;
    case "doctor":
      await runDoctor();
      return;
    case "login":
      await runLogin(rest);
      return;
    case "space":
      if (rest[0] === "create") {
        await runSpaceCreate(rest.slice(1));
        return;
      }
      console.error(
        `Unknown "space" subcommand "${rest[0]}". Use: wayform space create --owner <github-login>`,
      );
      process.exit(1);
      return;
    case undefined:
      await runServer();
      return;
    default:
      console.error(
        `Unknown command "${sub}". Use: wayform [hook|prompt-hook|guard|stop-review|init|doctor|login|space] …`,
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
