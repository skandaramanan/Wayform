import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

function initRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-init-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function runInit(dir) {
  return execFileSync(
    process.execPath,
    [
      cli,
      "init",
      "--author",
      "Ada",
      "--email",
      "ada@x.io",
      "--context-repo",
      "https://t@github.com/team/mem.git",
      "--project",
      "team-app",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      // CODEX_HOME keeps the codex hook-trust write off the real ~/.codex.
      env: {
        PATH: process.env.PATH ?? "",
        CODEX_HOME: path.join(dir, ".codex-home"),
      },
    },
  );
}

test("init writes all three hook configs, both MCP files, env, and gitignore", () => {
  const dir = initRepo();
  try {
    runInit(dir);
    const read = (p) => fs.readFileSync(path.join(dir, p), "utf8");

    assert.match(read(".claude/settings.json"), /memorylayer hook claude-code/);
    assert.match(read(".claude/settings.json"), /prompt-hook claude-code/);
    assert.doesNotMatch(read(".claude/settings.json"), /stop-review/);
    assert.match(read(".cursor/hooks.json"), /memorylayer hook cursor/);
    assert.doesNotMatch(read(".cursor/hooks.json"), /stop-review/);
    assert.match(read(".codex/hooks.json"), /startup\|resume/);
    assert.doesNotMatch(read(".codex/hooks.json"), /stop-review/);
    assert.match(read(".mcp.json"), /"memorylayer"/);
    assert.match(read(".cursor/mcp.json"), /"memorylayer"/);
    // Codex MCP is now an auto-written, project-scoped, gitignored file.
    assert.match(read(".codex/config.toml"), /\[mcp_servers\.memorylayer\]/);
    assert.match(read(".memorylayer-hook.env"), /MEMORYLAYER_AUTHOR=Ada/);
    assert.match(read(".gitignore"), /\.memorylayer-hook\.env/);
    assert.match(read(".gitignore"), /\.codex\/config\.toml/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init trusts its codex hooks in CODEX_HOME/config.toml, idempotently", () => {
  const dir = initRepo();
  try {
    runInit(dir);
    runInit(dir);
    const cfg = fs.readFileSync(
      path.join(dir, ".codex-home", "config.toml"),
      "utf8",
    );
    for (const key of ["session_start:0:0"]) {
      const header = `.codex/hooks.json:${key}"]`;
      assert.equal(cfg.split(header).length - 1, 1, `one entry for ${key}`);
    }
    assert.doesNotMatch(cfg, /hooks\.json:stop:/);
    assert.match(cfg, /trusted_hash = "sha256:[0-9a-f]{64}"/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init is idempotent — re-run adds no duplicate hook entries", () => {
  const dir = initRepo();
  try {
    runInit(dir);
    runInit(dir);
    const claude = fs.readFileSync(
      path.join(dir, ".claude/settings.json"),
      "utf8",
    );
    assert.equal(claude.split("memorylayer hook claude-code").length - 1, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("init backs up an unparseable existing config instead of destroying it", () => {
  const dir = initRepo();
  try {
    fs.mkdirSync(path.join(dir, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".cursor/hooks.json"), "{ not json");
    runInit(dir);
    assert.ok(fs.existsSync(path.join(dir, ".cursor/hooks.json.bak")));
    assert.match(
      fs.readFileSync(path.join(dir, ".cursor/hooks.json"), "utf8"),
      /memorylayer hook cursor/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
