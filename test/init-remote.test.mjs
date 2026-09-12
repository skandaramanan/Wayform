import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registerClaudeCodeMcp,
  parseRemoteClients,
  detectExistingClients,
} from "../dist/init-remote.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("parseRemoteClients accepts aliases and rejects unknown names", () => {
  assert.deepEqual(parseRemoteClients("cursor, claude-code"), [
    "cursor",
    "claude",
  ]);
  assert.deepEqual(parseRemoteClients("agy"), ["antigravity"]);
  assert.throws(() => parseRemoteClients("cursor,notepad"), /Unknown client/);
});

test("detectExistingClients only reports folders already in the repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayform-clients-"));
  assert.deepEqual(detectExistingClients(dir), []);
  fs.mkdirSync(path.join(dir, ".cursor"));
  fs.writeFileSync(path.join(dir, ".mcp.json"), "{}\n");
  assert.deepEqual(detectExistingClients(dir), ["cursor", "claude"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("registerClaudeCodeMcp invokes claude mcp add with no Authorization header", () => {
  let seen;
  const run = (cmd, args) => {
    seen = { cmd, args };
  };
  const res = registerClaudeCodeMcp("https://gw.example.com", run);
  assert.equal(res.ok, true);
  assert.equal(seen.cmd, "claude");
  assert.deepEqual(seen.args, [
    "mcp",
    "add",
    "--transport",
    "http",
    "--scope",
    "project",
    "wayform",
    "https://gw.example.com/mcp",
  ]);
  assert.ok(!seen.args.includes("--header"));
});

test("registerClaudeCodeMcp fails open to a printable command when claude is absent", () => {
  const run = () => {
    const e = new Error("spawn claude ENOENT");
    e.code = "ENOENT";
    throw e;
  };
  const res = registerClaudeCodeMcp("https://gw", run);
  assert.equal(res.ok, false);
  assert.match(
    res.command,
    /^claude mcp add --transport http --scope project /,
  );
  assert.doesNotMatch(res.command, /--header/);
  assert.doesNotMatch(res.command, /mlk_/);
});

test("runInitRemote hard-fails outside a git repo before writing anything", async (t) => {
  const { runInitRemote } = await import("../dist/init-remote.js");
  const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wayform-nogit-"));
  const prev = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(
    runInitRemote(["--gateway", "https://gw"]),
    /Not a git repository/,
  );
  assert.deepEqual(readdirSync(dir), []);
});

test("runInitRemote --yes wires only vendor folders already in the repo", async (t) => {
  const { runInitRemote } = await import("../dist/init-remote.js");
  const { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "wayform-existing-"));
  const prev = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  });
  execFileSync("git", ["init", "-q"]);
  mkdirSync(join(dir, ".cursor"));
  await runInitRemote([
    "--yes",
    "--gateway",
    "https://gw.example.com",
    "--author",
    "Dana",
    "--email",
    "dana@acme.com",
  ]);
  assert.equal(
    JSON.parse(readFileSync(join(dir, ".cursor/mcp.json"), "utf8")).mcpServers
      .wayform.url,
    "https://gw.example.com/mcp",
  );
  assert.equal(existsSync(join(dir, ".devin")), false);
  assert.equal(existsSync(join(dir, ".agents")), false);
  assert.equal(existsSync(join(dir, ".mcp.json")), false);
  assert.equal(existsSync(join(dir, ".codex")), false);
});

test("runInitRemote migrates legacy credentials and preserves Codex config", async (t) => {
  const { runInitRemote } = await import("../dist/init-remote.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayform-migrate-"));
  const prev = process.cwd();
  const prevCodexHome = process.env.CODEX_HOME;
  process.chdir(dir);
  process.env.CODEX_HOME = path.join(dir, "codex-home");
  t.after(() => {
    process.chdir(prev);
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["init", "-q"]);
  fs.mkdirSync(path.join(dir, ".cursor"));
  fs.mkdirSync(path.join(dir, ".codex"));
  fs.writeFileSync(
    path.join(dir, ".memorylayer-hook.env"),
    [
      "MEMORYLAYER_GATEWAY_URL=https://old.test",
      "MEMORYLAYER_GATEWAY_TOKEN=mlk_legacy",
      "MEMORYLAYER_AUTHOR=Ada",
      "MEMORYLAYER_AUTHOR_EMAIL=ada@example.com",
      "MEMORYLAYER_PROJECT=product",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, ".gitignore"),
    [
      "node_modules/",
      ".memorylayer-hook.env",
      ".cursor/mcp.json",
      ".codex/config.toml",
      ".claude/settings.local.json",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, ".codex/config.toml"),
    [
      'model = "gpt-5"',
      "",
      "[mcp_servers.other]",
      'url = "https://other.test/mcp"',
      "",
      "[mcp_servers.wayform]",
      'url = "https://old.test/mcp"',
      'http_headers = { Authorization = "Bearer mlk_legacy" }',
      "",
    ].join("\n"),
  );

  await runInitRemote([
    "--yes",
    "--clients",
    "cursor,codex",
    "--gateway",
    "https://gw.test",
    "--project",
    "product",
  ]);

  const backup = fs.readFileSync(
    path.join(dir, ".wayform-hook.env.bak"),
    "utf8",
  );
  assert.match(backup, /mlk_legacy/);
  const env = fs.readFileSync(path.join(dir, ".wayform-hook.env"), "utf8");
  assert.match(env, /WAYFORM_GATEWAY_URL=https:\/\/gw\.test/);
  assert.match(env, /WAYFORM_PROJECT=product/);
  assert.doesNotMatch(
    env,
    /(?:MEMORYLAYER|WAYFORM)_GATEWAY_TOKEN|(?:MEMORYLAYER|WAYFORM)_AUTHOR|mlk_/,
  );
  // the legacy file is consumed, not left beside the new one
  assert.equal(fs.existsSync(path.join(dir, ".memorylayer-hook.env")), false);

  const gitignore = fs.readFileSync(path.join(dir, ".gitignore"), "utf8");
  assert.match(gitignore, /node_modules\//);
  assert.match(gitignore, /\.claude\/settings\.local\.json/);
  assert.match(gitignore, /^\.memorylayer-hook\.env\.bak$/m);
  assert.doesNotMatch(
    gitignore,
    /^\.memorylayer-hook\.env$|\.cursor\/mcp\.json|\.codex\/config\.toml/m,
  );
  if (process.platform !== "win32") {
    assert.equal(
      fs.statSync(path.join(dir, ".wayform-hook.env.bak")).mode & 0o777,
      0o600,
    );
  }

  const codex = fs.readFileSync(path.join(dir, ".codex/config.toml"), "utf8");
  assert.match(codex, /model = "gpt-5"/);
  assert.match(codex, /\[mcp_servers\.other\]/);
  assert.match(codex, /url = "https:\/\/gw\.test\/mcp"/);
  assert.doesNotMatch(codex, /old\.test|http_headers|mlk_legacy/);
});
