import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkEnvFile, redactSecrets, runDoctor } from "../dist/doctor.js";

function cfg(repoPath, repoUrl = "https://token@github.com/org/memory.git") {
  return {
    repoUrl,
    repoPath,
    author: "Alice",
    authorEmail: "alice@memorylayer.local",
    autoPush: true,
    readBudgetTokens: 4000,
  };
}

function writeEnv(cwd) {
  fs.writeFileSync(
    path.join(cwd, ".memorylayer-hook.env"),
    [
      "CONTEXT_REPO_URL=https://token@github.com/org/memory.git",
      "MEMORYLAYER_AUTHOR=Alice",
      "",
    ].join("\n"),
  );
}

test("redactSecrets removes HTTPS URL userinfo", () => {
  assert.equal(
    redactSecrets("fatal: https://token@github.com/org/repo.git failed"),
    "fatal: https://***@github.com/org/repo.git failed",
  );
  assert.equal(
    redactSecrets("fatal: https://user:token@github.com/org/repo.git failed"),
    "fatal: https://***@github.com/org/repo.git failed",
  );
});

test("checkEnvFile fails when required keys are missing", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-doc-"));
  try {
    fs.writeFileSync(
      path.join(tmp, ".memorylayer-hook.env"),
      "MEMORYLAYER_AUTHOR=Alice\n",
    );
    const result = checkEnvFile(tmp, {});
    assert.equal(result.status, "fail");
    assert.match(result.message, /CONTEXT_REPO_URL/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDoctor reports healthy config without leaking tokens", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-doc-"));
  try {
    writeEnv(tmp);
    const clone = path.join(tmp, "clone");
    fs.mkdirSync(path.join(clone, ".git"), { recursive: true });
    const lines = [];
    const runner = async (_cwd, args) => {
      const command = args.join(" ");
      if (command === "remote get-url origin") {
        return "https://token@github.com/org/memory.git\n";
      }
      if (command.startsWith("ls-remote")) return "abc\tHEAD\n";
      if (command === "rev-parse --abbrev-ref HEAD") return "main\n";
      if (command === "rev-list --left-right --count origin/main...HEAD") {
        return "0\t0\n";
      }
      throw new Error(`unexpected git ${command}`);
    };

    const code = await runDoctor({
      cwd: tmp,
      config: cfg(clone),
      gitRunner: runner,
      write: (line) => lines.push(line),
      setExitCode: false,
    });

    assert.equal(code, 0);
    assert.match(lines.join("\n"), /\[ok\] remote/);
    assert.doesNotMatch(lines.join("\n"), /token/);
    assert.match(
      lines.join("\n"),
      /https:\/\/\*\*\*@github\.com\/org\/memory\.git/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function remoteCfg(gatewayUrl = "https://gw.example.com") {
  return {
    repoUrl: "",
    repoPath: "",
    author: "Alice",
    authorEmail: "alice@memorylayer.local",
    autoPush: true,
    readBudgetTokens: 4000,
    gatewayUrl,
    gatewayToken: "mlk_test_token",
  };
}

function writeRemoteEnv(cwd) {
  fs.writeFileSync(
    path.join(cwd, ".memorylayer-hook.env"),
    [
      "MEMORYLAYER_GATEWAY_URL=https://gw.example.com",
      "MEMORYLAYER_AUTHOR=Alice",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

test("checkEnvFile accepts a hosted env without CONTEXT_REPO_URL", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-doc-"));
  try {
    writeRemoteEnv(tmp);
    const result = checkEnvFile(tmp, {});
    assert.equal(result.status, "ok");
    assert.match(result.message, /hosted/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDoctor passes for a healthy hosted member and skips git checks", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-doc-"));
  try {
    writeRemoteEnv(tmp);
    const lines = [];
    const code = await runDoctor({
      cwd: tmp,
      config: remoteCfg(),
      gitRunner: async () => {
        throw new Error("git must not run in gateway-only mode");
      },
      fetchImpl: async (url, init) => {
        assert.match(String(url), /\/hook\/read\?/);
        assert.equal(init.headers.authorization, "Bearer mlk_test_token");
        return new Response("briefing", { status: 200 });
      },
      write: (line) => lines.push(line),
      setExitCode: false,
    });
    const out = lines.join("\n");
    assert.equal(code, 0);
    assert.match(out, /\[ok\] gateway/);
    assert.match(out, /\[ok\] perms/);
    assert.doesNotMatch(out, /clone|remote:|sync/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDoctor fails when the gateway rejects the session", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-doc-"));
  try {
    writeRemoteEnv(tmp);
    const lines = [];
    const code = await runDoctor({
      cwd: tmp,
      config: remoteCfg(),
      fetchImpl: async () => new Response("nope", { status: 401 }),
      write: (line) => lines.push(line),
      setExitCode: false,
    });
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /wayform login/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDoctor fails with wayform login when hosted and not logged in", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-doc-"));
  try {
    writeRemoteEnv(tmp);
    const lines = [];
    const code = await runDoctor({
      cwd: tmp,
      config: { ...remoteCfg(), gatewayToken: undefined },
      fetchImpl: async () => {
        throw new Error("must not fetch without a token");
      },
      write: (line) => lines.push(line),
      setExitCode: false,
    });
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /wayform login/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDoctor warns on loose secret-file perms", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-doc-"));
  try {
    writeRemoteEnv(tmp);
    fs.chmodSync(path.join(tmp, ".memorylayer-hook.env"), 0o644);
    const lines = [];
    const code = await runDoctor({
      cwd: tmp,
      config: remoteCfg(),
      fetchImpl: async () => new Response("ok", { status: 200 }),
      write: (line) => lines.push(line),
      setExitCode: false,
    });
    assert.equal(code, 0); // warn, not fail
    assert.match(lines.join("\n"), /\[warn\] perms.*chmod 600/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("runDoctor fails when clone origin does not match config", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-doc-"));
  try {
    writeEnv(tmp);
    const clone = path.join(tmp, "clone");
    fs.mkdirSync(path.join(clone, ".git"), { recursive: true });
    const runner = async (_cwd, args) => {
      const command = args.join(" ");
      if (command === "remote get-url origin") {
        return "https://github.com/other/repo.git\n";
      }
      if (command.startsWith("ls-remote")) return "abc\tHEAD\n";
      if (command === "rev-parse --abbrev-ref HEAD") return "main\n";
      if (command === "rev-list --left-right --count origin/main...HEAD") {
        return "0\t0\n";
      }
      throw new Error(`unexpected git ${command}`);
    };

    const code = await runDoctor({
      cwd: tmp,
      config: cfg(clone),
      gitRunner: runner,
      write: () => undefined,
      setExitCode: false,
    });

    assert.equal(code, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
