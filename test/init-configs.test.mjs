import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeClaudeSettings,
  mergeCursorHooks,
  mergeCodexHooks,
  mergeMcpJson,
  mergeCursorRemoteMcp,
  codexRemoteMcpToml,
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

test("mergeCursorHooks does NOT duplicate when an equivalent dist-path hook exists (F1)", () => {
  const existing = {
    version: 1,
    hooks: {
      sessionStart: [{ command: "node ./dist/cli.js hook cursor" }],
      stop: [
        { command: "node ./dist/cli.js stop-review cursor", loop_limit: 3 },
      ],
    },
  };
  const out = mergeCursorHooks(existing);
  assert.equal(out.hooks.sessionStart.length, 1);
  assert.equal(out.hooks.stop.length, 1);
  assert.match(out.hooks.sessionStart[0].command, /dist\/cli\.js hook cursor/);
});

test("mergeClaudeSettings does NOT duplicate an equivalent dist-path hook (F1)", () => {
  const existing = {
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command:
                'node "$CLAUDE_PROJECT_DIR/dist/cli.js" hook claude-code',
            },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command:
                'node "$CLAUDE_PROJECT_DIR/dist/cli.js" stop-review claude-code',
            },
          ],
        },
      ],
    },
  };
  const out = mergeClaudeSettings(existing);
  assert.equal(out.hooks.SessionStart.length, 1);
  assert.equal(out.hooks.Stop.length, 1);
});

test("mergeCodexHooks does NOT duplicate an equivalent dist-path hook (F1)", () => {
  const existing = {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [
            { type: "command", command: "node ./dist/cli.js hook codex" },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "node ./dist/cli.js stop-review codex",
            },
          ],
        },
      ],
    },
  };
  const out = mergeCodexHooks(existing);
  assert.equal(out.hooks.SessionStart.length, 1);
  assert.equal(out.hooks.Stop.length, 1);
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

test("mergeClaudeSettings emits the given binary name in hook commands", () => {
  const out = mergeClaudeSettings(undefined, "wayform");
  const cmds = out.hooks.SessionStart[0].hooks.map((h) => h.command);
  assert.ok(cmds.includes("wayform hook claude-code"));
  const stop = out.hooks.Stop[0].hooks.map((h) => h.command);
  assert.ok(stop.includes("wayform stop-review claude-code"));
});

test("mergeClaudeSettings defaults to the memorylayer binary", () => {
  const out = mergeClaudeSettings(undefined);
  assert.equal(
    out.hooks.SessionStart[0].hooks[0].command,
    "memorylayer hook claude-code",
  );
});

test("mergeCursorHooks / mergeCodexHooks honor the binary name", () => {
  const cur = mergeCursorHooks(undefined, "wayform");
  assert.equal(cur.hooks.sessionStart[0].command, "wayform hook cursor");
  const cdx = mergeCodexHooks(undefined, "wayform");
  assert.equal(
    cdx.hooks.SessionStart[0].hooks[0].command,
    "wayform hook codex",
  );
});

test("re-merging with a different binary name does not duplicate hooks (marker is bin-independent)", () => {
  const once = mergeClaudeSettings(undefined, "memorylayer");
  const twice = mergeClaudeSettings(once, "wayform");
  assert.equal(twice.hooks.SessionStart.length, 1);
});

test("mergeCursorRemoteMcp writes an HTTP server with a bearer header", () => {
  const out = mergeCursorRemoteMcp(
    undefined,
    "https://gw.example.com",
    "mlk_x",
  );
  assert.deepEqual(out.mcpServers.wayform, {
    url: "https://gw.example.com/mcp",
    headers: { Authorization: "Bearer mlk_x" },
  });
});

test("mergeCursorRemoteMcp preserves unrelated servers and is idempotent", () => {
  const existing = { mcpServers: { other: { url: "x" } } };
  const once = mergeCursorRemoteMcp(existing, "https://gw", "mlk_x");
  const twice = mergeCursorRemoteMcp(once, "https://gw", "mlk_x");
  assert.equal(twice.mcpServers.other.url, "x");
  assert.deepEqual(twice.mcpServers.wayform, {
    url: "https://gw/mcp",
    headers: { Authorization: "Bearer mlk_x" },
  });
});

test("codexRemoteMcpToml renders an mcp-remote bridge with the token", () => {
  const toml = codexRemoteMcpToml("https://gw", "mlk_x");
  assert.match(toml, /\[mcp_servers\.wayform\]/);
  assert.match(toml, /mcp-remote/);
  assert.match(toml, /https:\/\/gw\/mcp/);
  assert.match(toml, /Authorization: Bearer mlk_x/);
});
