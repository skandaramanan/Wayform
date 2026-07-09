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
const asObject = (v) => v && typeof v === "object" && !Array.isArray(v) ? { ...v } : {};
const asArray = (v) => (Array.isArray(v) ? [...v] : []);
/**
 * Append `entry` to `list` unless some existing item already invokes MemoryLayer
 * for this event. `marker` MUST be the stable `<subcommand> <client>` token
 * (e.g. "hook cursor", "stop-review claude-code") — NOT a whole command string —
 * so an equivalent hook that invokes the tool via a different form (the dogfood
 * `node ./dist/cli.js hook cursor`, an absolute path, or `npx memorylayer …`) is
 * still recognized and re-running `init` stays idempotent instead of appending a
 * duplicate hook that would fire the read/review twice per turn.
 */
function addOnce(list, marker, entry) {
    const present = list.some((item) => JSON.stringify(item).includes(marker));
    return present ? list : [...list, entry];
}
export function mergeClaudeSettings(existing, bin = "memorylayer") {
    const root = asObject(existing);
    const hooks = asObject(root.hooks);
    hooks.SessionStart = addOnce(asArray(hooks.SessionStart), "hook claude-code", {
        hooks: [{ type: "command", command: `${bin} hook claude-code` }],
    });
    hooks.Stop = addOnce(asArray(hooks.Stop), "stop-review claude-code", {
        hooks: [{ type: "command", command: `${bin} stop-review claude-code` }],
    });
    root.hooks = hooks;
    return root;
}
export function mergeCursorHooks(existing, bin = "memorylayer") {
    const root = asObject(existing);
    root.version = 1;
    const hooks = asObject(root.hooks);
    hooks.sessionStart = addOnce(asArray(hooks.sessionStart), "hook cursor", {
        command: `${bin} hook cursor`,
    });
    hooks.stop = addOnce(asArray(hooks.stop), "stop-review cursor", {
        command: `${bin} stop-review cursor`,
        loop_limit: 3,
    });
    root.hooks = hooks;
    return root;
}
export function mergeCodexHooks(existing, bin = "memorylayer") {
    const root = asObject(existing);
    const hooks = asObject(root.hooks);
    hooks.SessionStart = addOnce(asArray(hooks.SessionStart), "hook codex", {
        matcher: "startup|resume",
        hooks: [{ type: "command", command: `${bin} hook codex` }],
    });
    hooks.Stop = addOnce(asArray(hooks.Stop), "stop-review codex", {
        hooks: [{ type: "command", command: `${bin} stop-review codex` }],
    });
    root.hooks = hooks;
    return root;
}
export function mergeMcpJson(existing) {
    const root = asObject(existing);
    const servers = asObject(root.mcpServers);
    servers.memorylayer = { command: "memorylayer", args: [], env: {} };
    root.mcpServers = servers;
    return root;
}
/** Manual paste block for Codex MCP (global ~/.codex/config.toml). */
export const CODEX_MCP_TOML = `[mcp_servers.memorylayer]
command = "memorylayer"
args = []
`;
/**
 * Native HTTP MCP for a hosted member, written into a project's `.cursor/mcp.json`.
 * This file carries the member token, so `init --remote` MUST gitignore it — it is
 * per-member and never committed. Non-clobbering + idempotent on `wayform`.
 */
export function mergeCursorRemoteMcp(existing, gatewayUrl, token) {
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
 * Manual paste block for Codex MCP (global `~/.codex/config.toml`). Codex has no
 * project-scoped MCP (platform limitation), so the hosted member pastes this;
 * the `mcp-remote` bridge adapts the stdio-only client to the HTTP gateway.
 */
export function codexRemoteMcpToml(gatewayUrl, token) {
    return `[mcp_servers.wayform]
command = "npx"
args = ["-y", "mcp-remote", "${gatewayUrl}/mcp", "--header", "Authorization: Bearer ${token}"]
`;
}
//# sourceMappingURL=init-configs.js.map