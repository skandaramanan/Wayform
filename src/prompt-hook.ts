#!/usr/bin/env node
/**
 * Claude Code UserPromptSubmit hook — hidden prompt-context injection via
 * gateway POST /hook/prompt (decision da491a7d). Cursor cannot inject on
 * beforeSubmitPrompt; Cursor stays rules + remote MCP.
 *
 * FAIL-OPEN: any error / empty injection → client empty no-op, exit 0.
 */
import { loadConfig, defaultProject, envVar } from "./config.js";
import { remoteHookPrompt } from "./remote-read.js";
import {
  resolveClient,
  renderPromptContext,
  renderEmpty,
  type HookClient,
} from "./hook-clients.js";
import { isMain } from "./is-main.js";

export async function runPromptHook(): Promise<void> {
  const client: HookClient = resolveClient(envVar("HOOK_CLIENT"));

  const emitEmpty = (): never => {
    process.stdout.write(renderEmpty(client));
    process.exit(0);
  };

  try {
    let raw = "";
    if (!process.stdin.isTTY) {
      for await (const chunk of process.stdin) raw += chunk;
    }
    let prompt = "";
    try {
      const payload = raw.trim() ? JSON.parse(raw) : {};
      prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
    } catch {
      emitEmpty();
    }
    if (!prompt) emitEmpty();

    // Only Claude Code supports hidden UserPromptSubmit injection for us.
    if (client !== "claude-code") emitEmpty();

    const project = envVar("PROJECT")?.trim() || defaultProject();
    const cfg = loadConfig();
    const text = await remoteHookPrompt(
      cfg,
      project,
      prompt,
      cfg.readBudgetTokens,
    );
    if (text == null || text === "") emitEmpty();
    process.stdout.write(renderPromptContext(client, text as string));
    process.exit(0);
  } catch {
    emitEmpty();
  }
}

if (isMain(import.meta.url)) {
  void runPromptHook();
}
