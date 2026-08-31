#!/usr/bin/env node
/**
 * PreToolUse guard hook — the enforcement half of wayform.
 *
 * Claude Code runs this before every tool call. For mutating tools only, it
 * summarizes the proposed action, asks the gateway whether it contradicts a
 * live team decision, and emits an "ask" permission decision when it does.
 *
 * FAIL-OPEN, and more load-bearing here than anywhere else: this sits on the
 * hot path of every edit. Wrong config, offline gateway, slow judge, weird
 * payload — all resolve to the empty no-op and exit 0, so the tool runs exactly
 * as if no hook existed. This hook NEVER emits "deny" (spec decision 1).
 */
import { loadConfig, defaultProject } from "./config.js";
import { remoteGuardCheck } from "./remote-read.js";
import {
  resolveClient,
  renderGuardDecision,
  renderEmpty,
  type HookClient,
} from "./hook-clients.js";
import { isMain } from "./is-main.js";

/**
 * PreToolUse fires on EVERY tool. Guarding reads would put network latency on
 * calls that cannot contradict a decision, so only mutating tools qualify.
 */
export const GUARDED_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "Write",
  "Bash",
]);

/** On unless explicitly disabled; "ask" is already the safe setting. */
export function guardEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.WAYFORM_GUARD ?? "").trim().toLowerCase() !== "off";
}

/** Cap the action text: it becomes a retrieval query and a judge prompt. */
const ACTION_CHARS = 2000;

/**
 * Flatten a tool input into one line of intent. Deliberately dumb — the judge
 * reads prose, and a structured diff would cost tokens without adding signal.
 */
export function summarizeAction(toolName: string, toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== "object") return "";
  const input = toolInput as Record<string, unknown>;
  const str = (k: string) =>
    typeof input[k] === "string" ? (input[k] as string) : "";
  const path = str("file_path");
  const payload =
    str("command") || str("new_string") || str("content") || str("prompt");
  if (!path && !payload) return "";
  const head = path ? `${toolName} ${path}` : toolName;
  return `${head}: ${payload}`.slice(0, ACTION_CHARS);
}

export async function runGuardHook(): Promise<void> {
  const client: HookClient = resolveClient(process.env.MEMORYLAYER_HOOK_CLIENT);

  const emitEmpty = (): never => {
    process.stdout.write(renderEmpty(client));
    process.exit(0);
  };

  try {
    if (!guardEnabled(process.env)) emitEmpty();

    let raw = "";
    if (!process.stdin.isTTY) {
      for await (const chunk of process.stdin) raw += chunk;
    }
    let payload: { tool_name?: unknown; tool_input?: unknown };
    try {
      payload = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      emitEmpty();
      return;
    }

    const toolName =
      typeof payload.tool_name === "string" ? payload.tool_name : "";
    if (!GUARDED_TOOLS.has(toolName)) emitEmpty();

    const action = summarizeAction(toolName, payload.tool_input);
    if (!action) emitEmpty();

    const project = process.env.MEMORYLAYER_PROJECT?.trim() || defaultProject();
    const cfg = loadConfig();
    // null = gateway unusable. There is no local fallback by design: judging
    // needs the index and the model, both of which live in the gateway.
    const check = await remoteGuardCheck(cfg, project, action);
    if (check == null || check.decision !== "ask") emitEmpty();

    process.stdout.write(
      renderGuardDecision(client, "ask", (check as { reason: string }).reason),
    );
    process.exit(0);
  } catch {
    emitEmpty();
  }
}

if (isMain(import.meta.url)) {
  void runGuardHook();
}
