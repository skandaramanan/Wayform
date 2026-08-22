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
