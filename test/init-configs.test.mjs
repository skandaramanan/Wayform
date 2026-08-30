import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mergeClaudeSettings,
  mergeCursorHooks,
  mergeCodexHooks,
  mergeMcpJson,
  mergeCursorRemoteMcp,
  mergeDevinRemoteMcp,
  mergeAntigravityRemoteMcp,
  codexRemoteConfigToml,
  mergeCodexRemoteConfigToml,
  codexHookTrust,
  mergeCodexTrustToml,
  CODEX_MCP_TOML,
} from "../dist/init-configs.js";

test("mergeClaudeSettings creates SessionStart + UserPromptSubmit (no Stop)", () => {
  const out = mergeClaudeSettings(undefined);
  const cmds = JSON.stringify(out);
  assert.match(cmds, /memorylayer hook claude-code/);
  assert.match(cmds, /memorylayer prompt-hook claude-code/);
  assert.equal(out.hooks.Stop, undefined);
  assert.ok(out.hooks.UserPromptSubmit?.length >= 1);
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

test("mergeCursorHooks sets version 1 and sessionStart only (no stop)", () => {
  const out = mergeCursorHooks(undefined);
  assert.equal(out.version, 1);
  assert.match(
    JSON.stringify(out.hooks.sessionStart),
    /memorylayer hook cursor/,
  );
  assert.equal(out.hooks.stop, undefined);
});

test("mergeCodexHooks uses the startup|resume matcher on SessionStart (no Stop)", () => {
  const out = mergeCodexHooks(undefined);
  assert.equal(out.hooks.SessionStart[0].matcher, "startup|resume");
  assert.equal(out.hooks.Stop, undefined);
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
  assert.equal(out.hooks.stop, undefined);
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
  assert.equal(out.hooks.Stop, undefined);
  assert.ok(out.hooks.UserPromptSubmit?.length >= 1);
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
  assert.equal(out.hooks.Stop, undefined);
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

test("CODEX_MCP_TOML is the project-scoped local mcp_servers block", () => {
  assert.match(CODEX_MCP_TOML, /\[mcp_servers\.memorylayer\]/);
  assert.match(CODEX_MCP_TOML, /command = "memorylayer"/);
});

test("mergeClaudeSettings emits the given binary name in hook commands", () => {
  const out = mergeClaudeSettings(undefined, "wayform");
  const cmds = out.hooks.SessionStart[0].hooks.map((h) => h.command);
  assert.ok(cmds.includes("wayform hook claude-code"));
  const prompt = out.hooks.UserPromptSubmit[0].hooks.map((h) => h.command);
  assert.ok(prompt.includes("wayform prompt-hook claude-code"));
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

test("mergeCursorRemoteMcp writes a typed, token-free HTTP server", () => {
  const out = mergeCursorRemoteMcp(undefined, "https://gw.example.com");
  // `type` is load-bearing: Claude Code skips a url-only entry outright.
  assert.deepEqual(out.mcpServers.wayform, {
    type: "http",
    url: "https://gw.example.com/mcp",
  });
});

test("mergeCursorRemoteMcp preserves unrelated servers and is idempotent", () => {
  const existing = { mcpServers: { other: { url: "x" } } };
  const once = mergeCursorRemoteMcp(existing, "https://gw");
  const twice = mergeCursorRemoteMcp(once, "https://gw");
  assert.equal(twice.mcpServers.other.url, "x");
  assert.deepEqual(twice.mcpServers.wayform, {
    type: "http",
    url: "https://gw/mcp",
  });
});

test("mergeDevinRemoteMcp is project HTTP + transport, no headers", () => {
  const out = mergeDevinRemoteMcp(undefined, "https://gw");
  assert.deepEqual(out.mcpServers.wayform, {
    url: "https://gw/mcp",
    transport: "http",
  });
});

test("mergeAntigravityRemoteMcp uses serverUrl (not url) and no headers", () => {
  const out = mergeAntigravityRemoteMcp(undefined, "https://gw");
  assert.deepEqual(out.mcpServers.wayform, { serverUrl: "https://gw/mcp" });
  assert.equal(out.mcpServers.wayform.url, undefined);
  assert.equal(out.mcpServers.wayform.headers, undefined);
});

test("codexRemoteConfigToml renders native HTTP with OAuth, no headers", () => {
  const toml = codexRemoteConfigToml("https://gw");
  assert.match(toml, /\[mcp_servers\.wayform\]/);
  assert.match(toml, /url = "https:\/\/gw\/mcp"/);
  assert.match(toml, /auth = "oauth"/);
  assert.doesNotMatch(toml, /http_headers/);
  assert.doesNotMatch(toml, /mlk_/);
  assert.doesNotMatch(toml, /mcp-remote/);
});

test("mergeCodexRemoteConfigToml replaces only Wayform and preserves unrelated config", () => {
  const existing = `model = "gpt-5"

[mcp_servers.other]
url = "https://other.test/mcp"

[mcp_servers.wayform]
url = "https://old.test/mcp"
http_headers = { Authorization = "Bearer mlk_old" }

[projects."/repo"]
trust_level = "trusted"
`;
  const merged = mergeCodexRemoteConfigToml(existing, "https://gw.test");
  assert.match(merged, /model = "gpt-5"/);
  assert.match(merged, /\[mcp_servers\.other\]/);
  assert.match(merged, /\[projects\."\/repo"\]/);
  assert.match(merged, /url = "https:\/\/gw\.test\/mcp"/);
  assert.match(merged, /auth = "oauth"/);
  assert.doesNotMatch(merged, /old\.test|http_headers|mlk_old/);
  assert.equal(mergeCodexRemoteConfigToml(merged, "https://gw.test"), merged);
});

test("codexHookTrust reproduces codex's own trusted hashes (gold values from a real TUI grant)", () => {
  const entries = codexHookTrust(
    mergeCodexHooks(undefined, "wayform"),
    "/repo/.codex/hooks.json",
  );
  // SessionStart hash from codex 0.144 TUI grant; Stop wiring removed.
  assert.deepEqual(entries, [
    {
      key: "/repo/.codex/hooks.json:session_start:0:0",
      hash: "sha256:35bb314ef9d1e09ab6d27f98fdb77487a2bd85190d9ccc0c1339b996a6df922d",
    },
  ]);
});

test("codexHookTrust ignores foreign hooks and uses real group indices", () => {
  const merged = mergeCodexHooks(
    {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "somebody-elses-hook" }] },
        ],
      },
    },
    "wayform",
  );
  const entries = codexHookTrust(merged, "/repo/.codex/hooks.json");
  assert.deepEqual(
    entries.map((e) => e.key),
    ["/repo/.codex/hooks.json:session_start:1:0"],
  );
});

test("mergeCodexTrustToml appends once, preserves unrelated config, refreshes a stale hash", () => {
  const entries = [
    { key: "/r/.codex/hooks.json:stop:0:0", hash: "sha256:new" },
  ];
  const base = '[projects."/r"]\ntrust_level = "trusted"\n';
  const once = mergeCodexTrustToml(base, entries);
  assert.match(once, /trust_level = "trusted"/);
  assert.match(
    once,
    /\[hooks\.state\."\/r\/\.codex\/hooks\.json:stop:0:0"\]\ntrusted_hash = "sha256:new"/,
  );
  // Idempotent on re-run.
  assert.equal(mergeCodexTrustToml(once, entries), once);
  // A stale hash is replaced in place, not duplicated.
  const stale = once.replace("sha256:new", "sha256:old");
  const fixed = mergeCodexTrustToml(stale, entries);
  assert.equal(fixed, once);
});
