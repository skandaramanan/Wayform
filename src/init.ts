/**
 * `memorylayer init` — wire MemoryLayer into the current project repo.
 *
 * LOUD, not fail-open (the inverse of the runtime hooks): a half-written setup
 * must surface. Unparseable existing configs are backed up (.bak), never
 * destroyed. Idempotent: re-running adds our entries at most once.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  mergeClaudeSettings,
  mergeCursorHooks,
  mergeCodexHooks,
  mergeMcpJson,
  CODEX_MCP_TOML,
} from "./init-configs.js";
import { buildHookEnv, gitConfigDefault, ensureGitignore } from "./init-env.js";

const USAGE = `memorylayer init — wire MemoryLayer into this project

Options (all optional; missing identity values are prompted for):
  --author <name>         commit author / attribution
  --email <email>         commit email
  --context-repo <url>    shared context repo URL (may embed a token)
  --project <name>        shared project/space name (default: repo dir name)
  --force                 rewrite an existing .memorylayer-hook.env
  --yes                   accept git-config / directory defaults, no prompts
  --help                  show this help

Hosted member (gateway) mode:
  --remote                wire a hosted member (gateway URL+token, no clone)
  --gateway <url>         (remote) hosted gateway base URL
  --token <mlk_...>       (remote) member token
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}
const has = (args: string[], name: string): boolean =>
  args.includes(`--${name}`);

/** Read+parse a JSON config; on parse error, back it up and treat as absent. */
function readJson(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  const raw = fs.readFileSync(file, "utf8");
  try {
    return JSON.parse(raw);
  } catch {
    fs.copyFileSync(file, `${file}.bak`);
    console.warn(
      `! ${file} was not valid JSON — backed up to ${file}.bak and rewriting.`,
    );
    return undefined;
  }
}

function writeJson(cwd: string, rel: string, data: unknown): void {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  console.log(`  wrote ${rel}`);
}

export async function runInit(args: string[]): Promise<void> {
  if (has(args, "help")) {
    output.write(USAGE);
    return;
  }

  if (has(args, "remote")) {
    const { runInitRemote } = await import("./init-remote.js");
    await runInitRemote(args);
    return;
  }

  const cwd = process.cwd();
  if (!fs.existsSync(path.join(cwd, ".git"))) {
    console.warn(
      "! Not a git repository. Hooks are project-scoped; run this in your project root.",
    );
  }

  // --- Project tier: hook configs (all three clients) ---
  writeJson(
    cwd,
    ".claude/settings.json",
    mergeClaudeSettings(readJson(path.join(cwd, ".claude/settings.json"))),
  );
  writeJson(
    cwd,
    ".cursor/hooks.json",
    mergeCursorHooks(readJson(path.join(cwd, ".cursor/hooks.json"))),
  );
  writeJson(
    cwd,
    ".codex/hooks.json",
    mergeCodexHooks(readJson(path.join(cwd, ".codex/hooks.json"))),
  );

  // --- Project tier: MCP registration (Claude Code + Cursor; Codex is manual) ---
  writeJson(
    cwd,
    ".mcp.json",
    mergeMcpJson(readJson(path.join(cwd, ".mcp.json"))),
  );
  writeJson(
    cwd,
    ".cursor/mcp.json",
    mergeMcpJson(readJson(path.join(cwd, ".cursor/mcp.json"))),
  );

  // --- User tier: identity env file ---
  const envFile = path.join(cwd, ".memorylayer-hook.env");
  if (fs.existsSync(envFile) && !has(args, "force")) {
    console.log(
      "  .memorylayer-hook.env exists — leaving it (use --force to rewrite).",
    );
  } else {
    const useDefaults = has(args, "yes");
    const rl =
      useDefaults ||
      (flag(args, "author") &&
        flag(args, "email") &&
        flag(args, "context-repo"))
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
    const repoUrl =
      flag(args, "context-repo") ??
      (await ask("Context repo URL (with token)", ""));
    const project =
      flag(args, "project") ?? (await ask("Project name", path.basename(cwd)));
    rl?.close();

    if (!author || !repoUrl) {
      throw new Error(
        "author and context-repo are required to write .memorylayer-hook.env",
      );
    }
    fs.writeFileSync(
      envFile,
      buildHookEnv({ author, email, repoUrl, project }),
    );
    console.log("  wrote .memorylayer-hook.env (gitignored)");
  }

  // --- Gitignore the per-user + per-user-local files ---
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

  // --- Codex MCP: manual step (global config.toml, no TOML dependency) ---
  console.log("\nNext steps:");
  console.log("  1. Commit the project configs so teammates inherit them:");
  console.log(
    "       git add .claude .cursor .codex .mcp.json .gitignore && git commit -m 'chore: wire MemoryLayer'",
  );
  console.log(
    "  2. Each teammate runs `memorylayer init` to set their own identity.",
  );
  console.log(
    "  3. Codex users: add this to ~/.codex/config.toml (MCP tools):\n",
  );
  console.log(CODEX_MCP_TOML);
}
