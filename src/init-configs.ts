/**
 * Pure builders/mergers for the per-vendor config artifacts `init` writes.
 *
 * Each `merge*` takes the client's existing parsed config (or undefined) and
 * returns it with MemoryLayer's entries added. Merges are:
 *  - non-clobbering: unrelated existing entries are preserved;
 *  - idempotent: our command appears at most once on re-run (matched by command
 *    substring / server key).
 *
 * Commands invoke the globally-installed `wayform` binary (fast, offline),
 * NOT a bash launcher or npx. All are secret-free: `wayform` self-loads
 * `.memorylayer-hook.env` from the project cwd at runtime.
 */
import { createHash } from "node:crypto";

type Json = Record<string, unknown>;

const asObject = (v: unknown): Json =>
  v && typeof v === "object" && !Array.isArray(v) ? { ...(v as Json) } : {};
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? [...v] : []);

/**
 * Append `entry` to `list` unless some existing item already invokes MemoryLayer
 * for this event. `marker` MUST be the stable `<subcommand> <client>` token
 * (e.g. "hook cursor", "stop-review claude-code") — NOT a whole command string —
 * so an equivalent hook that invokes the tool via a different form (the dogfood
 * `node ./dist/cli.js hook cursor`, an absolute path, or `npx wayform …`) is
 * still recognized and re-running `init` stays idempotent instead of appending a
 * duplicate hook that would fire the read/review twice per turn.
 */
function addOnce(list: unknown[], marker: string, entry: unknown): unknown[] {
  const present = list.some((item) => JSON.stringify(item).includes(marker));
  return present ? list : [...list, entry];
}

export function mergeClaudeSettings(
  existing: unknown,
  bin: string = "wayform",
): Json {
  const root = asObject(existing);
  const hooks = asObject(root.hooks);
  hooks.SessionStart = addOnce(
    asArray(hooks.SessionStart),
    "hook claude-code",
    {
      hooks: [{ type: "command", command: `${bin} hook claude-code` }],
    },
  );
  // Stop re-engagement removed (da491a7d). Claude gets mid-prompt injection
  // via UserPromptSubmit → /hook/prompt instead.
  delete hooks.Stop;
  hooks.UserPromptSubmit = addOnce(
    asArray(hooks.UserPromptSubmit),
    "prompt-hook claude-code",
    {
      hooks: [
        {
          type: "command",
          command: `${bin} prompt-hook claude-code`,
          timeout: 15,
        },
      ],
    },
  );
  // PreToolUse guard (Phase E): matcher limits the hook to mutating tools so
  // reads never pay for a network round trip.
  hooks.PreToolUse = addOnce(asArray(hooks.PreToolUse), "guard claude-code", {
    matcher: "Edit|Write|Bash",
    hooks: [
      { type: "command", command: `${bin} guard claude-code`, timeout: 5 },
    ],
  });
  root.hooks = hooks;
  return root;
}

export function mergeCursorHooks(
  existing: unknown,
  bin: string = "wayform",
): Json {
  const root = asObject(existing);
  root.version = 1;
  const hooks = asObject(root.hooks);
  hooks.sessionStart = addOnce(asArray(hooks.sessionStart), "hook cursor", {
    command: `${bin} hook cursor`,
  });
  // Cursor beforeSubmitPrompt cannot inject; Stop re-engagement retired.
  delete hooks.stop;
  root.hooks = hooks;
  return root;
}

export function mergeCodexHooks(
  existing: unknown,
  bin: string = "wayform",
): Json {
  const root = asObject(existing);
  const hooks = asObject(root.hooks);
  hooks.SessionStart = addOnce(asArray(hooks.SessionStart), "hook codex", {
    matcher: "startup|resume",
    hooks: [{ type: "command", command: `${bin} hook codex` }],
  });
  delete hooks.Stop;
  root.hooks = hooks;
  return root;
}

/**
 * Trust entries for OUR hooks in a merged .codex/hooks.json.
 *
 * Codex grants hook trust per entry in the USER-global ~/.codex/config.toml
 * (`[hooks.state."<abs hooks.json path>:<event>:<group>:<index>"] trusted_hash`),
 * separate from the project `trust_level` — untrusted hooks are skipped
 * SILENTLY, and the grant is only ever offered in the interactive Codex TUI.
 * So without writing these, init'd Codex hooks never fire. The user running
 * `init` is the consent step: we only trust the marker-matched hooks we
 * ourselves wire, never pre-existing foreign entries.
 *
 * The hash reproduces codex's `command_hook_hash` (codex-rs
 * hooks/src/engine/discovery.rs + config/src/fingerprint.rs): sha256 over
 * key-sorted compact JSON of the normalized identity — event label, matcher
 * (dropped for stop, which ignores matchers), and the handler with timeout
 * defaulted to 600. The file path is NOT part of the hash. Verified against
 * hashes codex 0.144 writes after a TUI trust grant.
 * ponytail: formula is Codex-internal — if a future Codex changes it, hooks go
 * quiet again and the one-time remedy is re-trusting in the Codex TUI.
 */
export function codexHookTrust(
  merged: Json,
  hooksJsonAbsPath: string,
): Array<{ key: string; hash: string }> {
  const events: Array<[string, string, boolean]> = [
    ["SessionStart", "session_start", true],
  ];
  const ours = / (hook|prompt-hook) codex$/;
  const out: Array<{ key: string; hash: string }> = [];
  const hooks = asObject(merged.hooks);
  for (const [prop, label, keepMatcher] of events) {
    asArray(hooks[prop]).forEach((g, gi) => {
      const group = asObject(g);
      asArray(group.hooks).forEach((h, hi) => {
        const handler = asObject(h);
        const command =
          typeof handler.command === "string" ? handler.command : "";
        // async hooks are skipped (unsupported) by codex before hashing.
        if (!ours.test(command) || handler.async === true) return;
        // Build with keys pre-sorted: codex canonicalizes by sorting keys.
        const norm: Json = { async: false, command };
        if (typeof handler.statusMessage === "string")
          norm.statusMessage = handler.statusMessage;
        norm.timeout = Math.max(
          1,
          typeof handler.timeout === "number" ? handler.timeout : 600,
        );
        norm.type = "command";
        const identity: Json = { event_name: label, hooks: [norm] };
        if (keepMatcher && typeof group.matcher === "string")
          identity.matcher = group.matcher;
        const hash =
          "sha256:" +
          createHash("sha256").update(JSON.stringify(identity)).digest("hex");
        out.push({ key: `${hooksJsonAbsPath}:${label}:${gi}:${hi}`, hash });
      });
    });
  }
  return out;
}

const escapeTomlKey = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/**
 * Merge trust entries into the user-global codex config.toml TEXT (never
 * parsed/rewritten — unrelated user config is untouched). Idempotent; if a
 * table already exists its trusted_hash is refreshed in place, because a stale
 * hash (e.g. after a hook command change) silently disables the hook again.
 */
export function mergeCodexTrustToml(
  existing: string,
  entries: Array<{ key: string; hash: string }>,
): string {
  let out = existing;
  for (const { key, hash } of entries) {
    const header = `[hooks.state."${escapeTomlKey(key)}"]`;
    const at = out.indexOf(header);
    if (at < 0) {
      if (out !== "" && !out.endsWith("\n")) out += "\n";
      out += `\n${header}\ntrusted_hash = "${hash}"\n`;
      continue;
    }
    const start = at + header.length;
    const nextTable = out.indexOf("\n[", start);
    const end = nextTable < 0 ? out.length : nextTable;
    const section = out.slice(start, end);
    const hashLine = /((^|\n)\s*trusted_hash\s*=\s*)"[^"]*"/;
    const updated = hashLine.test(section)
      ? section.replace(hashLine, `$1"${hash}"`)
      : `\ntrusted_hash = "${hash}"` + section;
    out = out.slice(0, start) + updated + out.slice(end);
  }
  return out;
}

export function mergeMcpJson(existing: unknown): Json {
  const root = asObject(existing);
  const servers = asObject(root.mcpServers);
  servers.wayform = { command: "wayform", args: [], env: {} };
  root.mcpServers = servers;
  return root;
}

/**
 * Project-scoped Codex MCP block for the LOCAL (self-hosted clone) tier, written
 * to `.codex/config.toml`. Secret-free stdio server: `command = "wayform"`
 * self-loads `.memorylayer-hook.env` at runtime. Codex applies project config
 * for trusted repos, so this needs no global paste.
 */
export const CODEX_MCP_TOML = `[mcp_servers.wayform]
command = "wayform"
args = []
`;

/**
 * Native HTTP MCP for a hosted member. No token in the file — the client runs
 * OAuth. Used for Cursor `.cursor/mcp.json` and Claude Code project-scope
 * `.mcp.json` (never `~/.cursor/mcp.json` or `--scope user`).
 *
 * `type` is REQUIRED, not decorative: Claude Code skips a `url` entry that
 * omits it ("has a url but no type; add type: http"), so a URL-only file
 * silently yields no tools. Cursor ignores the extra key.
 */
export function mergeRemoteHttpMcp(
  existing: unknown,
  gatewayUrl: string,
): Json {
  const root = asObject(existing);
  const servers = asObject(root.mcpServers);
  servers.wayform = { type: "http", url: `${gatewayUrl}/mcp` };
  root.mcpServers = servers;
  return root;
}

export const mergeCursorRemoteMcp = mergeRemoteHttpMcp;

/**
 * Project-scoped Codex MCP block for a HOSTED (gateway) member. Lives in
 * `.codex/config.toml` (trusted project only) — not `~/.codex/config.toml`.
 */
export function codexRemoteConfigToml(gatewayUrl: string): string {
  return `[mcp_servers.wayform]
url = "${gatewayUrl}/mcp"
auth = "oauth"
`;
}

/**
 * Replace only Codex's project-scoped Wayform table. Keeping the operation
 * text-based preserves comments, model settings, trust, and unrelated MCP
 * servers without introducing a TOML serializer that rewrites user config.
 */
export function mergeCodexRemoteConfigToml(
  existing: string,
  gatewayUrl: string,
): string {
  const replacement = codexRemoteConfigToml(gatewayUrl);
  const header = /^\[mcp_servers\.wayform\]\s*$/m;
  const found = header.exec(existing);
  if (!found) {
    let out = existing;
    if (out && !out.endsWith("\n")) out += "\n";
    if (out && !out.endsWith("\n\n")) out += "\n";
    return out + replacement;
  }

  const nextHeader = /^\[/gm;
  nextHeader.lastIndex = found.index + found[0].length;
  const next = nextHeader.exec(existing);
  const end = next?.index ?? existing.length;
  const suffix = existing.slice(end);
  return (
    existing.slice(0, found.index) + replacement + (suffix ? "\n" : "") + suffix
  );
}

/**
 * Devin CLI project MCP (`.devin/mcp_config.json`). Not `--scope user` /
 * `~/.config/devin/mcp_config.json`, which would load in every repo.
 */
export function mergeDevinRemoteMcp(
  existing: unknown,
  gatewayUrl: string,
): Json {
  const root = asObject(existing);
  const servers = asObject(root.mcpServers);
  servers.wayform = {
    url: `${gatewayUrl}/mcp`,
    transport: "http",
  };
  root.mcpServers = servers;
  return root;
}

/**
 * Antigravity workspace MCP (`.agents/mcp_config.json`). Uses `serverUrl`
 * per Google's schema. Not `~/.gemini/config/mcp_config.json` (global).
 * DCR OAuth: URL only, no headers.
 */
export function mergeAntigravityRemoteMcp(
  existing: unknown,
  gatewayUrl: string,
): Json {
  const root = asObject(existing);
  const servers = asObject(root.mcpServers);
  servers.wayform = { serverUrl: `${gatewayUrl}/mcp` };
  root.mcpServers = servers;
  return root;
}
