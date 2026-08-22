/**
 * `wayform init --remote` — wire a HOSTED (gateway) member into the current
 * project. Same LOUD, idempotent posture as local `init`, but writes a gateway
 * URL + native HTTP MCP instead of a local clone. No member token is written
 * anywhere: Cursor/Claude/Codex run OAuth; hooks use `wayform login` + keychain.
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
  mergeRemoteHttpMcp,
  mergeDevinRemoteMcp,
  mergeAntigravityRemoteMcp,
  codexRemoteConfigToml,
} from "./init-configs.js";
import {
  buildRemoteHookEnv,
  gitConfigDefault,
  ensureGitignore,
  writeSecretFile,
  trustCodexHooks,
} from "./init-env.js";
import { DEFAULT_GATEWAY_URL } from "./oauth-login.js";

export type Runner = (cmd: string, args: string[]) => void;

const defaultRunner: Runner = (cmd, args) => {
  // Bounded + non-interactive: a hanging or prompting `claude` must never freeze
  // init. On timeout/ENOENT this throws → the caller falls open to a printed
  // manual command. stdin is closed so the child cannot block waiting for input.
  // Claude Code's default install is a shell-rc alias to ~/.claude/local/claude,
  // invisible to execFileSync's PATH lookup — try that location before giving up.
  const home = process.env.HOME ?? "";
  const candidates =
    cmd === "claude" && home
      ? [cmd, path.join(home, ".claude", "local", "claude")]
      : [cmd];
  let lastErr: unknown;
  for (const bin of candidates) {
    try {
      execFileSync(bin, args, {
        stdio: ["ignore", "ignore", "ignore"],
        timeout: 15000,
      });
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
};

/**
 * Recommended Claude Code CLI if someone adds the server by hand.
 * `--scope project` writes `.mcp.json` in this repo. Never `--scope user`
 * (that would load Wayform in every folder they open).
 */
export function registerClaudeCodeMcp(
  gatewayUrl: string,
  run: Runner = defaultRunner,
): { ok: boolean; command: string } {
  const args = [
    "mcp",
    "add",
    "--transport",
    "http",
    "--scope",
    "project",
    "wayform",
    `${gatewayUrl}/mcp`,
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
    throw new Error(
      "Not a git repository — cd to your project's root and re-run. Nothing was written.",
    );
  }

  const gatewayUrl = (flag(args, "gateway") ?? DEFAULT_GATEWAY_URL).replace(
    /\/+$/,
    "",
  );

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
  const codexHooks = mergeCodexHooks(
    readJson(path.join(cwd, ".codex/hooks.json")),
    "wayform",
  );
  writeJson(cwd, ".codex/hooks.json", codexHooks);
  trustCodexHooks(cwd, codexHooks);

  writeJson(
    cwd,
    ".cursor/mcp.json",
    mergeRemoteHttpMcp(
      readJson(path.join(cwd, ".cursor/mcp.json")),
      gatewayUrl,
    ),
  );
  writeJson(
    cwd,
    ".mcp.json",
    mergeRemoteHttpMcp(readJson(path.join(cwd, ".mcp.json")), gatewayUrl),
  );
  writeText(cwd, ".codex/config.toml", codexRemoteConfigToml(gatewayUrl));
  writeJson(
    cwd,
    ".devin/mcp_config.json",
    mergeDevinRemoteMcp(
      readJson(path.join(cwd, ".devin/mcp_config.json")),
      gatewayUrl,
    ),
  );
  writeJson(
    cwd,
    ".agents/mcp_config.json",
    mergeAntigravityRemoteMcp(
      readJson(path.join(cwd, ".agents/mcp_config.json")),
      gatewayUrl,
    ),
  );

  const envFile = path.join(cwd, ".memorylayer-hook.env");
  if (fs.existsSync(envFile) && !has(args, "force")) {
    console.log(
      "  .memorylayer-hook.env exists — leaving it (use --force to rewrite).",
    );
  } else {
    writeSecretFile(
      envFile,
      buildRemoteHookEnv({ gatewayUrl, project, author, email }),
    );
    console.log("  wrote .memorylayer-hook.env");
  }

  const giPath = path.join(cwd, ".gitignore");
  const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";
  fs.writeFileSync(
    giPath,
    ensureGitignore(gi, [
      ".memorylayer-hook.env",
      ".claude/settings.local.json",
    ]),
  );
  console.log("  updated .gitignore");

  console.log("\nNext steps (this product repo only — not a global MCP):");
  console.log("  1. wayform login   # OS keychain for session-start hooks");
  console.log("  2. In this folder, authenticate the client you use:");
  console.log("       Cursor:        Connect on the wayform server");
  console.log("       Claude Code:   claude mcp login wayform");
  console.log("       Codex:         codex mcp login wayform");
  console.log("       Devin CLI:     devin mcp login wayform");
  console.log("       Antigravity:   Authenticate wayform in MCP settings");
  console.log("  3. wayform doctor");
  console.log("  4. Commit the project MCP files so teammates inherit them:");
  console.log(
    "       git add .mcp.json .cursor/mcp.json .codex/config.toml .devin .agents .claude .codex/hooks.json .cursor/hooks.json .gitignore && git commit -m 'chore: wire Wayform (remote)'",
  );
}
