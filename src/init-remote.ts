/**
 * `wayform init --remote` — wire a HOSTED (gateway) member into the current
 * project. Same LOUD, idempotent posture as local `init`, but writes gateway
 * creds + native HTTP MCP instead of a local clone. Token never touches a
 * committed file (gitignored env + gitignored .cursor/mcp.json + Claude's
 * user-scoped ~/.claude.json).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  mergeClaudeSettings,
  mergeCursorHooks,
  mergeCodexHooks,
  mergeCursorRemoteMcp,
  codexRemoteConfigToml,
} from "./init-configs.js";
import {
  buildRemoteHookEnv,
  gitConfigDefault,
  ensureGitignore,
  writeSecretFile,
  hardenSecretFile,
} from "./init-env.js";

export type Runner = (cmd: string, args: string[]) => void;

const defaultRunner: Runner = (cmd, args) =>
  // Bounded + non-interactive: a hanging or prompting `claude` must never freeze
  // init. On timeout/ENOENT this throws → the caller falls open to a printed
  // manual command. stdin is closed so the child cannot block waiting for input.
  void execFileSync(cmd, args, {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 15000,
  });

/**
 * Register the gateway as a project-scoped (`--scope local`) HTTP MCP server for
 * Claude Code. `--scope local` stores config in ~/.claude.json (NOT the repo), so
 * it is project-scoped AND token-safe. Non-fatal: if `claude` is absent the
 * returned command is printed for the member to run by hand.
 */
export function registerClaudeCodeMcp(
  gatewayUrl: string,
  token: string,
  run: Runner = defaultRunner,
): { ok: boolean; command: string } {
  const args = [
    "mcp",
    "add",
    "--transport",
    "http",
    "--scope",
    "local",
    "wayform",
    `${gatewayUrl}/mcp`,
    "--header",
    `Authorization: Bearer ${token}`,
  ];
  const command = `claude ${args.join(" ")}`;
  try {
    run("claude", args);
    return { ok: true, command };
  } catch {
    return { ok: false, command };
  }
}

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const has = (args: string[], name: string): boolean =>
  args.includes(`--${name}`);

function readJson(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    fs.copyFileSync(file, `${file}.bak`);
    console.warn(`! ${file} was not valid JSON — backed up to ${file}.bak.`);
    return undefined;
  }
}

function writeJson(cwd: string, rel: string, data: unknown): void {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  console.log(`  wrote ${rel}`);
}

function writeText(cwd: string, rel: string, text: string): void {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  console.log(`  wrote ${rel}`);
}

export async function runInitRemote(args: string[]): Promise<void> {
  const cwd = process.cwd();
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    console.warn(
      "! Not a git repository. Hooks are project-scoped; run this in your project root.",
    );
  }

  const gatewayUrl = (flag(args, "gateway") ?? "").replace(/\/+$/, "");
  const token = flag(args, "token") ?? "";
  if (!gatewayUrl || !token) {
    throw new Error(
      "wayform init --remote requires --gateway <url> and --token <mlk_...>",
    );
  }

  // Identity (attribution/display; the gateway is authoritative on write).
  const useDefaults = has(args, "yes");
  const rl =
    useDefaults || (flag(args, "author") && flag(args, "email"))
      ? undefined
      : readline.createInterface({ input, output });
  const ask = async (q: string, def: string): Promise<string> => {
    if (!rl) return def;
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def;
  };
  const author =
    flag(args, "author") ??
    (await ask("Author name", gitConfigDefault("user.name")));
  const email =
    flag(args, "email") ??
    (await ask("Author email", gitConfigDefault("user.email")));
  const project = flag(args, "project") ?? path.basename(cwd);
  rl?.close();

  // --- Project tier: session/Stop hooks calling the `wayform` binary ---
  writeJson(
    cwd,
    ".claude/settings.json",
    mergeClaudeSettings(
      readJson(path.join(cwd, ".claude/settings.json")),
      "wayform",
    ),
  );
  writeJson(
    cwd,
    ".cursor/hooks.json",
    mergeCursorHooks(readJson(path.join(cwd, ".cursor/hooks.json")), "wayform"),
  );
  writeJson(
    cwd,
    ".codex/hooks.json",
    mergeCodexHooks(readJson(path.join(cwd, ".codex/hooks.json")), "wayform"),
  );

  // --- Cursor native HTTP MCP (gitignored — carries the token) ---
  writeJson(
    cwd,
    ".cursor/mcp.json",
    mergeCursorRemoteMcp(
      readJson(path.join(cwd, ".cursor/mcp.json")),
      gatewayUrl,
      token,
    ),
  );
  // Token-bearing: tighten to owner-only (writeJson creates at umask default).
  hardenSecretFile(path.join(cwd, ".cursor/mcp.json"));

  // --- Codex native HTTP MCP (project-scoped; token read from env at launch) ---
  writeText(cwd, ".codex/config.toml", codexRemoteConfigToml(gatewayUrl));

  // --- User tier: gitignored gateway env (hosted-only, no CONTEXT_REPO_URL) ---
  const envFile = path.join(cwd, ".memorylayer-hook.env");
  if (fs.existsSync(envFile) && !has(args, "force")) {
    hardenSecretFile(envFile); // retro-tighten a pre-existing 0644 file
    console.log(
      "  .memorylayer-hook.env exists — leaving it (use --force to rewrite).",
    );
  } else {
    writeSecretFile(
      envFile,
      buildRemoteHookEnv({ gatewayUrl, token, project, author, email }),
    );
    console.log("  wrote .memorylayer-hook.env (gitignored)");
  }

  // --- Gitignore secrets: env + local settings + the token-bearing cursor mcp ---
  const giPath = path.join(cwd, ".gitignore");
  const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";
  fs.writeFileSync(
    giPath,
    ensureGitignore(gi, [
      ".memorylayer-hook.env",
      ".claude/settings.local.json",
      ".cursor/mcp.json",
      ".codex/config.toml",
    ]),
  );
  console.log("  updated .gitignore");

  // --- Claude Code native HTTP MCP (project-scoped, token in ~/.claude.json) ---
  const claude = registerClaudeCodeMcp(gatewayUrl, token);
  if (claude.ok) {
    console.log("  registered Claude Code MCP (claude mcp add --scope local)");
  } else {
    console.log(
      "  ! Could not run the Claude CLI — register Claude Code MCP by hand:\n",
    );
    console.log(`    ${claude.command}\n`);
  }

  console.log("  wrote .codex/config.toml (gitignored — token read from env)");

  console.log("\nNext steps:");
  console.log(
    "  1. Commit the project hook configs so teammates inherit them:",
  );
  console.log(
    "       git add .claude .cursor/hooks.json .codex/hooks.json .gitignore && git commit -m 'chore: wire Wayform (remote)'",
  );
  console.log(
    "     (.cursor/mcp.json, .codex/config.toml and .memorylayer-hook.env are gitignored — each member runs init --remote.)",
  );
  console.log(
    "  2. Codex users: export the gateway token before launching, e.g.\n",
  );
  console.log("       set -a; source .memorylayer-hook.env; set +a; codex\n");
  console.log(
    "     (.codex/config.toml reads MEMORYLAYER_GATEWAY_TOKEN from the environment.)",
  );
}
