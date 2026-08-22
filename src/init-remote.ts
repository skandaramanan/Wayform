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
  mergeCursorRemoteMcp,
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
 * Register the gateway as a project-scoped (`--scope local`) HTTP MCP server for
 * Claude Code. URL only — `claude mcp login wayform` stores tokens in the
 * keychain. Non-fatal: if `claude` is absent the returned command is printed.
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
    "local",
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
    mergeCursorRemoteMcp(
      readJson(path.join(cwd, ".cursor/mcp.json")),
      gatewayUrl,
    ),
  );
  writeText(cwd, ".codex/config.toml", codexRemoteConfigToml(gatewayUrl));

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

  const claude = registerClaudeCodeMcp(gatewayUrl);
  if (claude.ok) {
    console.log("  registered Claude Code MCP (claude mcp add --scope local)");
  } else {
    console.log(
      "  ! Couldn't find the Claude Code CLI — finish setup by running this in your project root:\n",
    );
    console.log(`    ${claude.command}\n`);
    console.log("    then run: claude mcp login wayform\n");
  }

  console.log("\nNext steps:");
  console.log("  1. wayform login");
  console.log(
    "     then click Connect in Cursor, or: claude mcp login wayform",
  );
  console.log("     Codex: codex mcp login wayform");
  console.log("  2. wayform doctor");
  console.log(
    "  3. Commit URL-only MCP configs so teammates only click Connect:",
  );
  console.log(
    "       git add .claude .cursor .codex .gitignore && git commit -m 'chore: wire Wayform (remote)'",
  );
}
