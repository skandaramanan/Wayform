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
