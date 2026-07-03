import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeClaudeSettings,
  mergeCursorHooks,
  mergeCodexHooks,
  mergeMcpJson,
  CODEX_MCP_TOML,
} from "../dist/init-configs.js";

test("mergeClaudeSettings creates SessionStart + Stop from empty", () => {
  const out = mergeClaudeSettings(undefined);
  const cmds = JSON.stringify(out);
  assert.match(cmds, /memorylayer hook claude-code/);
  assert.match(cmds, /memorylayer stop-review claude-code/);
});

test("mergeClaudeSettings preserves unrelated existing hooks and is idempotent", () => {
  const existing = {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: "echo other" }] }],
    },
  };
  const once = mergeClaudeSettings(existing);
  assert.match(JSON.stringify(once), /echo other/);
  const twice = mergeClaudeSettings(once);
  const count =
    JSON.stringify(twice).split("memorylayer hook claude-code").length - 1;
  assert.equal(count, 1);
});

test("mergeCursorHooks sets version 1, loop_limit 3, both events", () => {
  const out = mergeCursorHooks(undefined);
  assert.equal(out.version, 1);
  assert.match(
    JSON.stringify(out.hooks.sessionStart),
    /memorylayer hook cursor/,
  );
  const stop = out.hooks.stop[0];
  assert.equal(stop.loop_limit, 3);
  assert.match(stop.command, /memorylayer stop-review cursor/);
});

test("mergeCodexHooks uses the startup|resume matcher on SessionStart", () => {
  const out = mergeCodexHooks(undefined);
  assert.equal(out.hooks.SessionStart[0].matcher, "startup|resume");
  assert.match(JSON.stringify(out.hooks.Stop), /memorylayer stop-review codex/);
});

test("mergeMcpJson adds a secret-free memorylayer server, preserving others", () => {
  const out = mergeMcpJson({ mcpServers: { other: { command: "x" } } });
  assert.equal(out.mcpServers.other.command, "x");
  assert.deepEqual(out.mcpServers.memorylayer, {
    command: "memorylayer",
    args: [],
    env: {},
  });
});

test("CODEX_MCP_TOML is the manual mcp_servers block", () => {
  assert.match(CODEX_MCP_TOML, /\[mcp_servers\.memorylayer\]/);
  assert.match(CODEX_MCP_TOML, /command = "memorylayer"/);
});
