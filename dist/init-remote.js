/**
 * `wayform init --remote` — wire a HOSTED (gateway) member into the current
 * project. Same LOUD, idempotent posture as local `init`, but writes gateway
 * creds + native HTTP MCP instead of a local clone. Token never touches a
 * committed file (gitignored env + gitignored .cursor/mcp.json and
 * .codex/config.toml + Claude's user-scoped ~/.claude.json).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mergeClaudeSettings, mergeCursorHooks, mergeCodexHooks, mergeCursorRemoteMcp, codexRemoteConfigToml, } from "./init-configs.js";
import { buildRemoteHookEnv, gitConfigDefault, ensureGitignore, writeSecretFile, hardenSecretFile, trustCodexHooks, } from "./init-env.js";
const defaultRunner = (cmd, args) => {
    // Bounded + non-interactive: a hanging or prompting `claude` must never freeze
    // init. On timeout/ENOENT this throws → the caller falls open to a printed
    // manual command. stdin is closed so the child cannot block waiting for input.
    // Claude Code's default install is a shell-rc alias to ~/.claude/local/claude,
    // invisible to execFileSync's PATH lookup — try that location before giving up.
    const home = process.env.HOME ?? "";
    const candidates = cmd === "claude" && home
        ? [cmd, path.join(home, ".claude", "local", "claude")]
        : [cmd];
    let lastErr;
    for (const bin of candidates) {
        try {
            execFileSync(bin, args, {
                stdio: ["ignore", "ignore", "ignore"],
                timeout: 15000,
            });
            return;
        }
        catch (err) {
            lastErr = err;
        }
    }
    throw lastErr;
};
/**
 * Register the gateway as a project-scoped (`--scope local`) HTTP MCP server for
 * Claude Code. `--scope local` stores config in ~/.claude.json (NOT the repo), so
 * it is project-scoped AND token-safe. Non-fatal: if `claude` is absent the
 * returned command is printed for the member to run by hand.
 */
export function registerClaudeCodeMcp(gatewayUrl, token, run = defaultRunner) {
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
    // Shell-quote the header arg so the printed fallback is copy-paste safe.
    const command = `claude ${args.map((a) => (a.includes(" ") ? `"${a}"` : a)).join(" ")}`;
    try {
        run("claude", args);
        return { ok: true, command };
    }
    catch {
        return { ok: false, command };
    }
}
const flag = (args, name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const has = (args, name) => args.includes(`--${name}`);
function readJson(file) {
    if (!fs.existsSync(file))
        return undefined;
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        fs.copyFileSync(file, `${file}.bak`);
        console.warn(`! ${file} was not valid JSON — backed up to ${file}.bak.`);
        return undefined;
    }
}
function writeJson(cwd, rel, data) {
    const file = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
    console.log(`  wrote ${rel}`);
}
function writeText(cwd, rel, text) {
    const file = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`  wrote ${rel}`);
}
export async function runInitRemote(args) {
    const cwd = process.cwd();
    if (!fs.existsSync(path.join(cwd, ".git"))) {
        throw new Error("Not a git repository — cd to your project's root and re-run. Nothing was written.");
    }
    const gatewayUrl = (flag(args, "gateway") ?? "").replace(/\/+$/, "");
    const token = flag(args, "token") ?? "";
    if (!gatewayUrl || !token) {
        throw new Error("wayform init --remote requires --gateway <url> and --token <mlk_...>");
    }
    // Identity (attribution/display; the gateway is authoritative on write).
    const useDefaults = has(args, "yes");
    const rl = useDefaults || (flag(args, "author") && flag(args, "email"))
        ? undefined
        : readline.createInterface({ input, output });
    const ask = async (q, def) => {
        if (!rl)
            return def;
        const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
        return a || def;
    };
    const author = flag(args, "author") ??
        (await ask("Author name", gitConfigDefault("user.name")));
    const email = flag(args, "email") ??
        (await ask("Author email", gitConfigDefault("user.email")));
    const project = flag(args, "project") ?? path.basename(cwd);
    rl?.close();
    // --- Project tier: session/Stop hooks calling the `wayform` binary ---
    writeJson(cwd, ".claude/settings.json", mergeClaudeSettings(readJson(path.join(cwd, ".claude/settings.json")), "wayform"));
    writeJson(cwd, ".cursor/hooks.json", mergeCursorHooks(readJson(path.join(cwd, ".cursor/hooks.json")), "wayform"));
    const codexHooks = mergeCodexHooks(readJson(path.join(cwd, ".codex/hooks.json")), "wayform");
    writeJson(cwd, ".codex/hooks.json", codexHooks);
    // User tier: codex requires per-hook trust in ~/.codex/config.toml and
    // silently skips untrusted hooks — grant it for the hooks we just wrote.
    trustCodexHooks(cwd, codexHooks);
    // --- Cursor native HTTP MCP (gitignored — carries the token) ---
    writeJson(cwd, ".cursor/mcp.json", mergeCursorRemoteMcp(readJson(path.join(cwd, ".cursor/mcp.json")), gatewayUrl, token));
    // Token-bearing: tighten to owner-only (writeJson creates at umask default).
    hardenSecretFile(path.join(cwd, ".cursor/mcp.json"));
    // --- Codex native HTTP MCP (project-scoped, gitignored — carries the token) ---
    writeText(cwd, ".codex/config.toml", codexRemoteConfigToml(gatewayUrl, token));
    hardenSecretFile(path.join(cwd, ".codex/config.toml"));
    // --- User tier: gitignored gateway env (hosted-only, no CONTEXT_REPO_URL) ---
    const envFile = path.join(cwd, ".memorylayer-hook.env");
    if (fs.existsSync(envFile) && !has(args, "force")) {
        hardenSecretFile(envFile); // retro-tighten a pre-existing 0644 file
        console.log("  .memorylayer-hook.env exists — leaving it (use --force to rewrite).");
    }
    else {
        writeSecretFile(envFile, buildRemoteHookEnv({ gatewayUrl, token, project, author, email }));
        console.log("  wrote .memorylayer-hook.env (gitignored)");
    }
    // --- Gitignore secrets: env + local settings + the token-bearing cursor mcp ---
    const giPath = path.join(cwd, ".gitignore");
    const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, "utf8") : "";
    fs.writeFileSync(giPath, ensureGitignore(gi, [
        ".memorylayer-hook.env",
        ".claude/settings.local.json",
        ".cursor/mcp.json",
        ".codex/config.toml",
    ]));
    console.log("  updated .gitignore");
    // --- Claude Code native HTTP MCP (project-scoped, token in ~/.claude.json) ---
    const claude = registerClaudeCodeMcp(gatewayUrl, token);
    if (claude.ok) {
        console.log("  registered Claude Code MCP (claude mcp add --scope local)");
    }
    else {
        console.log("  ! Couldn't find the Claude Code CLI — finish setup by running this in your project root:\n");
        console.log(`    ${claude.command}\n`);
        console.log('    then restart Claude Code and check /mcp shows "wayform" connected.\n');
    }
    console.log("\nNext steps:");
    console.log("  1. Verify the round trip:");
    console.log("       wayform doctor        (gateway reachable + token accepted)");
    console.log('     then restart your agent and ask it to "read the shared context" —');
    console.log("     you should see your team's entries. (Claude Code: /mcp shows wayform connected.)");
    console.log("  2. Commit the project hook configs so teammates inherit them:");
    console.log("       git add .claude .cursor/hooks.json .codex/hooks.json .gitignore && git commit -m 'chore: wire Wayform (remote)'");
    console.log("     (.cursor/mcp.json, .codex/config.toml and .memorylayer-hook.env are gitignored — each member runs init --remote.)");
    console.log("  3. Codex users: mark the project trusted (Codex only loads project-scoped");
    console.log("     config for trusted repos) — then wayform tools appear on next launch.");
}
//# sourceMappingURL=init-remote.js.map