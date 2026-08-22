/**
 * `wayform init` — wire Wayform into the current project repo.
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
import {
  buildHookEnv,
  gitConfigDefault,
  ensureGitignore,
  writeSecretFile,
  hardenSecretFile,
  trustCodexHooks,
} from "./init-env.js";

const USAGE = `wayform init — wire Wayform into this project

Options (all optional; missing identity values are prompted for):
  --author <name>         commit author / attribution
  --email <email>         commit email
  --context-repo <url>    shared context repo URL (may embed a token)
  --project <name>        shared project/space name (default: repo dir name)
  --force                 rewrite an existing .memorylayer-hook.env
  --yes                   accept git-config / directory defaults, no prompts
  --help                  show this help

Hosted member (gateway) mode:
  --remote                wire a hosted member (gateway URL, no clone)
  --gateway <url>         (remote) hosted gateway base URL (default: production)
  Then run: wayform login
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

function writeText(cwd: string, rel: string, text: string): void {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
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
    throw new Error(
      "Not a git repository — cd to your project's root and re-run. Nothing was written.",
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
  const codexHooks = mergeCodexHooks(
    readJson(path.join(cwd, ".codex/hooks.json")),
  );
  writeJson(cwd, ".codex/hooks.json", codexHooks);
  // User tier: codex requires per-hook trust in ~/.codex/config.toml and
  // silently skips untrusted hooks — grant it for the hooks we just wrote.
  trustCodexHooks(cwd, codexHooks);

  // --- Project tier: MCP registration (Claude Code + Cursor + Codex) ---
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
  writeText(cwd, ".codex/config.toml", CODEX_MCP_TOML);

  // --- User tier: identity env file ---
  const envFile = path.join(cwd, ".memorylayer-hook.env");
  if (fs.existsSync(envFile) && !has(args, "force")) {
    hardenSecretFile(envFile); // retro-tighten a pre-existing 0644 file
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
    writeSecretFile(envFile, buildHookEnv({ author, email, repoUrl, project }));
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
      ".codex/config.toml",
    ]),
  );
  console.log("  updated .gitignore");

  console.log("\nNext steps:");
  console.log("  1. Commit the project configs so teammates inherit them:");
  console.log(
    "       git add .claude .cursor .codex/hooks.json .mcp.json .gitignore && git commit -m 'chore: wire Wayform'",
  );
  console.log(
    "  2. Each teammate runs `wayform init` to set their own identity and",
  );
  console.log(
    "     regenerate the gitignored .codex/config.toml (project-scoped MCP).",
  );
}
