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
/** Append `entry` to `list` unless some existing item's JSON contains `marker`. */
function addOnce(list, marker, entry) {
    const present = list.some((item) => JSON.stringify(item).includes(marker));
    return present ? list : [...list, entry];
}
export function mergeClaudeSettings(existing) {
    const root = asObject(existing);
    const hooks = asObject(root.hooks);
    hooks.SessionStart = addOnce(asArray(hooks.SessionStart), "memorylayer hook claude-code", {
        hooks: [{ type: "command", command: "memorylayer hook claude-code" }],
    });
    hooks.Stop = addOnce(asArray(hooks.Stop), "memorylayer stop-review claude-code", {
        hooks: [
            { type: "command", command: "memorylayer stop-review claude-code" },
        ],
    });
    root.hooks = hooks;
    return root;
}
export function mergeCursorHooks(existing) {
    const root = asObject(existing);
    root.version = 1;
    const hooks = asObject(root.hooks);
    hooks.sessionStart = addOnce(asArray(hooks.sessionStart), "memorylayer hook cursor", {
        command: "memorylayer hook cursor",
    });
    hooks.stop = addOnce(asArray(hooks.stop), "memorylayer stop-review cursor", {
        command: "memorylayer stop-review cursor",
        loop_limit: 3,
    });
    root.hooks = hooks;
    return root;
}
export function mergeCodexHooks(existing) {
    const root = asObject(existing);
    const hooks = asObject(root.hooks);
    hooks.SessionStart = addOnce(asArray(hooks.SessionStart), "memorylayer hook codex", {
        matcher: "startup|resume",
        hooks: [{ type: "command", command: "memorylayer hook codex" }],
    });
    hooks.Stop = addOnce(asArray(hooks.Stop), "memorylayer stop-review codex", {
        hooks: [{ type: "command", command: "memorylayer stop-review codex" }],
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
//# sourceMappingURL=init-configs.js.map