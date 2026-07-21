/**
 * Pure builders/mergers for the per-vendor config artifacts `init` writes.
 *
 * Each `merge*` takes the client's existing parsed config (or undefined) and
 * returns it with MemoryLayer's entries added. Merges are:
 *  - non-clobbering: unrelated existing entries are preserved;
 *  - idempotent: our command appears at most once on re-run (matched by command
 *    substring / server key).
 *
 * Commands invoke the globally-installed `memorylayer` binary (fast, offline),
 * NOT a bash launcher or npx. All are secret-free: `memorylayer` self-loads
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
 * `node ./dist/cli.js hook cursor`, an absolute path, or `npx memorylayer …`) is
 * still recognized and re-running `init` stays idempotent instead of appending a
 * duplicate hook that would fire the read/review twice per turn.
 */
function addOnce(list: unknown[], marker: string, entry: unknown): unknown[] {
  const present = list.some((item) => JSON.stringify(item).includes(marker));
  return present ? list : [...list, entry];
}

export function mergeClaudeSettings(
  existing: unknown,
  bin: string = "memorylayer",
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
  root.hooks = hooks;
  return root;
}

export function mergeCursorHooks(
  existing: unknown,
  bin: string = "memorylayer",
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
  bin: string = "memorylayer",
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
  servers.memorylayer = { command: "memorylayer", args: [], env: {} };
  root.mcpServers = servers;
  return root;
}

/**
 * Project-scoped Codex MCP block for the LOCAL (self-hosted clone) tier, written
 * to `.codex/config.toml`. Secret-free stdio server: `command = "memorylayer"`
 * self-loads `.memorylayer-hook.env` at runtime. Codex applies project config
 * for trusted repos, so this needs no global paste.
 */
export const CODEX_MCP_TOML = `[mcp_servers.memorylayer]
command = "memorylayer"
args = []
`;

/**
 * Native HTTP MCP for a hosted member, written into a project's `.cursor/mcp.json`.
 * This file carries the member token, so `init --remote` MUST gitignore it — it is
 * per-member and never committed. Non-clobbering + idempotent on `wayform`.
 */
export function mergeCursorRemoteMcp(
  existing: unknown,
  gatewayUrl: string,
  token: string,
): Json {
  const root = asObject(existing);
  const servers = asObject(root.mcpServers);
  servers.wayform = {
    url: `${gatewayUrl}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
  };
  root.mcpServers = servers;
  return root;
}

/**
 * Project-scoped Codex MCP block for a HOSTED (gateway) member, written to
 * `.codex/config.toml`. Codex 0.144+ speaks native streamable-HTTP and applies
 * project config for trusted repos, so no global paste and no `mcp-remote`
 * bridge are needed. The member token is inlined as a literal Authorization
 * header via `http_headers` — the same pattern as `.cursor/mcp.json` — because
 * the env-var alternative (`bearer_token_env_var`) requires exporting the token
 * before every launch and fails SILENTLY for IDE-launched Codex (the MCP client
 * never initializes and the model just sees no tools). Codex rejects a literal
 * `bearer_token` field for HTTP servers; `http_headers` is the sanctioned
 * literal path. This file therefore CARRIES THE TOKEN: `init --remote` MUST
 * gitignore it and harden it to 0600.
 */
export function codexRemoteConfigToml(
  gatewayUrl: string,
  token: string,
): string {
  return `[mcp_servers.wayform]
url = "${gatewayUrl}/mcp"
http_headers = { Authorization = "Bearer ${token}" }
`;
}
