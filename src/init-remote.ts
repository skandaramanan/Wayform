import { HOOK_ENV_FILE, LEGACY_HOOK_ENV_FILE } from "./config.js";
/**
 * `wayform init --remote` — wire a HOSTED (gateway) member into the current
 * project. Same LOUD, idempotent posture as local `init`, but writes a gateway
 * URL + native HTTP MCP instead of a local clone. No member token is written
 * anywhere: selected clients run OAuth; hooks use `wayform login` + keychain.
 * `--clients` picks which vendor folders to write so unused tools are not dumped.
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
  mergeCodexRemoteConfigToml,
} from "./init-configs.js";
import {
  buildRemoteHookEnv,
  ensureGitignore,
  removeGitignoreEntries,
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

export type RemoteClient =
  "cursor" | "claude" | "codex" | "devin" | "antigravity";

const CLIENT_ALIASES: Record<string, RemoteClient> = {
  cursor: "cursor",
  claude: "claude",
  "claude-code": "claude",
  codex: "codex",
  devin: "devin",
  antigravity: "antigravity",
  agy: "antigravity",
};

export function parseRemoteClients(raw: string): RemoteClient[] {
  const out: RemoteClient[] = [];
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const id = CLIENT_ALIASES[part.toLowerCase()];
    if (!id) {
      throw new Error(
        `Unknown client "${part}". Use: cursor, claude, codex, devin, antigravity`,
      );
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** Clients that already have a project folder/file in this repo. */
export function detectExistingClients(cwd: string): RemoteClient[] {
  const found: RemoteClient[] = [];
  if (fs.existsSync(path.join(cwd, ".cursor"))) found.push("cursor");
  if (
    fs.existsSync(path.join(cwd, ".claude")) ||
    fs.existsSync(path.join(cwd, ".mcp.json"))
  ) {
    found.push("claude");
  }
  if (fs.existsSync(path.join(cwd, ".codex"))) found.push("codex");
  if (fs.existsSync(path.join(cwd, ".devin"))) found.push("devin");
  if (fs.existsSync(path.join(cwd, ".agents"))) found.push("antigravity");
  return found;
}

function wants(clients: RemoteClient[], id: RemoteClient): boolean {
  return clients.includes(id);
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
  const rl = useDefaults
    ? undefined
    : readline.createInterface({ input, output });
  const ask = async (q: string, def: string): Promise<string> => {
    if (!rl) return def;
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def;
  };
  const project = flag(args, "project") ?? path.basename(cwd);

  const clientsFlag = flag(args, "clients");
  let clients: RemoteClient[];
  if (clientsFlag !== undefined) {
    clients = parseRemoteClients(clientsFlag);
  } else if (rl) {
    const existing = detectExistingClients(cwd);
    const picked = await ask(
      "Clients to wire (cursor, claude, codex, devin, antigravity)",
      existing.join(","),
    );
    clients = picked ? parseRemoteClients(picked) : existing;
  } else {
    clients = detectExistingClients(cwd);
  }
  rl?.close();

  if (wants(clients, "claude")) {
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
      ".mcp.json",
      mergeRemoteHttpMcp(readJson(path.join(cwd, ".mcp.json")), gatewayUrl),
    );
  }
  if (wants(clients, "cursor")) {
    writeJson(
      cwd,
      ".cursor/hooks.json",
      mergeCursorHooks(
        readJson(path.join(cwd, ".cursor/hooks.json")),
        "wayform",
      ),
    );
    writeJson(
      cwd,
      ".cursor/mcp.json",
      mergeRemoteHttpMcp(
        readJson(path.join(cwd, ".cursor/mcp.json")),
        gatewayUrl,
      ),
    );
  }
  if (wants(clients, "codex")) {
    const codexHooks = mergeCodexHooks(
      readJson(path.join(cwd, ".codex/hooks.json")),
      "wayform",
    );
    writeJson(cwd, ".codex/hooks.json", codexHooks);
    trustCodexHooks(cwd, codexHooks);
    const codexConfig = path.join(cwd, ".codex/config.toml");
    const existing = fs.existsSync(codexConfig)
      ? fs.readFileSync(codexConfig, "utf8")
      : "";
    writeText(
      cwd,
      ".codex/config.toml",
      mergeCodexRemoteConfigToml(existing, gatewayUrl),
    );
  }
  if (wants(clients, "devin")) {
    writeJson(
      cwd,
      ".devin/mcp_config.json",
      mergeDevinRemoteMcp(
        readJson(path.join(cwd, ".devin/mcp_config.json")),
        gatewayUrl,
      ),
    );
  }
  if (wants(clients, "antigravity")) {
    writeJson(
      cwd,
      ".agents/mcp_config.json",
      mergeAntigravityRemoteMcp(
        readJson(path.join(cwd, ".agents/mcp_config.json")),
        gatewayUrl,
      ),
    );
  }

  const giPath = path.join(cwd, ".gitignore");
  const initialGitignore = fs.existsSync(giPath)
    ? fs.readFileSync(giPath, "utf8")
    : "";
  fs.writeFileSync(
    giPath,
    ensureGitignore(initialGitignore, [
      `${HOOK_ENV_FILE}.bak`,
      `${LEGACY_HOOK_ENV_FILE}.bak`,
    ]),
  );

  const envFile = path.join(cwd, HOOK_ENV_FILE);
  const legacyFile = path.join(cwd, LEGACY_HOOK_ENV_FILE);
  const hasNew = fs.existsSync(envFile);
  const hasLegacy = fs.existsSync(legacyFile);
  const existingEnv = hasNew
    ? fs.readFileSync(envFile, "utf8")
    : hasLegacy
      ? fs.readFileSync(legacyFile, "utf8")
      : "";
  // Credential-bearing shapes from before token-free onboarding. Both env-var
  // prefixes are checked: the rename does not make an old token safe.
  const credentialed =
    /(?:MEMORYLAYER|WAYFORM)_GATEWAY_TOKEN\s*=|(?:MEMORYLAYER|WAYFORM)_AUTHOR(?:_EMAIL)?\s*=|(?:mlk_|wfi_)[A-Za-z0-9_-]+/.test(
      existingEnv,
    );
  if (credentialed) {
    writeSecretFile(`${envFile}.bak`, existingEnv);
    writeSecretFile(envFile, buildRemoteHookEnv({ gatewayUrl, project }));
    if (hasLegacy) fs.rmSync(legacyFile, { force: true });
    console.log(
      `  migrated ${HOOK_ENV_FILE} (legacy file backed up to ${HOOK_ENV_FILE}.bak)`,
    );
  } else if (hasLegacy && !hasNew) {
    // Same contract, new file name. Rewrite rather than copy so the contents
    // use the current var names too.
    writeSecretFile(envFile, buildRemoteHookEnv({ gatewayUrl, project }));
    fs.rmSync(legacyFile, { force: true });
    console.log(`  renamed ${LEGACY_HOOK_ENV_FILE} -> ${HOOK_ENV_FILE}`);
  } else if (existingEnv && !has(args, "force")) {
    console.log(
      `  ${HOOK_ENV_FILE} exists — leaving it (use --force to rewrite).`,
    );
  } else {
    writeSecretFile(envFile, buildRemoteHookEnv({ gatewayUrl, project }));
    console.log(`  wrote ${HOOK_ENV_FILE}`);
  }

  const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";
  const cleaned = removeGitignoreEntries(gi, [
    HOOK_ENV_FILE,
    LEGACY_HOOK_ENV_FILE,
    ".cursor/mcp.json",
    ".codex/config.toml",
  ]);
  const ignore: string[] = [
    `${HOOK_ENV_FILE}.bak`,
    `${LEGACY_HOOK_ENV_FILE}.bak`,
  ];
  if (wants(clients, "claude")) ignore.push(".claude/settings.local.json");
  fs.writeFileSync(giPath, ensureGitignore(cleaned, ignore));
  console.log("  updated .gitignore");

  if (clients.length === 0) {
    console.log(
      "\nNo agent configs written. Pass --clients with the tools this team uses:",
    );
    console.log(
      "  wayform init --remote --clients cursor,claude   # example — only those folders",
    );
  }

  console.log("\nNext steps (this product repo only — not a global MCP):");
  console.log("  1. wayform login   # OS keychain for session-start hooks");
  if (clients.length > 0) {
    console.log("  2. In this folder, authenticate the client you use:");
    if (wants(clients, "cursor")) {
      console.log("       Cursor:        Connect on the wayform server");
    }
    if (wants(clients, "claude")) {
      console.log("       Claude Code:   claude mcp login wayform");
    }
    if (wants(clients, "codex")) {
      console.log("       Codex:         codex mcp login wayform");
    }
    if (wants(clients, "devin")) {
      console.log("       Devin CLI:     devin mcp login wayform");
    }
    if (wants(clients, "antigravity")) {
      console.log("       Antigravity:   Authenticate wayform in MCP settings");
    }
  }
  console.log("  3. wayform doctor");
  const add = commitPaths(clients);
  if (add.length > 0) {
    console.log("  4. Commit the project MCP files so teammates inherit them:");
    console.log(
      `       git add ${add.join(" ")} && git commit -m 'chore: wire Wayform (remote)'`,
    );
  }
}

function commitPaths(clients: RemoteClient[]): string[] {
  const add: string[] = [".gitignore", ".memorylayer-hook.env"];
  if (wants(clients, "claude")) add.push(".mcp.json", ".claude");
  if (wants(clients, "cursor")) add.push(".cursor");
  if (wants(clients, "codex")) add.push(".codex");
  if (wants(clients, "devin")) add.push(".devin");
  if (wants(clients, "antigravity")) add.push(".agents");
  return add;
}
