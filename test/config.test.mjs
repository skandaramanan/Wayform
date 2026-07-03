import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { loadConfig, loadHookEnv } from "../dist/config.js";

const MEMORYLAYER_VARS = [
  "CONTEXT_REPO_URL",
  "CONTEXT_REPO_PATH",
  "MEMORYLAYER_AUTHOR",
  "MEMORYLAYER_AUTHOR_EMAIL",
  "MEMORYLAYER_AUTO_PUSH",
];

/** Run `fn` with a clean, fully-controlled MemoryLayer env, then restore. */
function withEnv(overrides, fn) {
  const saved = {};
  for (const k of MEMORYLAYER_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, overrides);
  try {
    return fn();
  } finally {
    for (const k of MEMORYLAYER_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test("throws when MEMORYLAYER_AUTHOR is missing", () => {
  withEnv({ CONTEXT_REPO_URL: "https://example/repo.git" }, () => {
    assert.throws(() => loadConfig(), /MEMORYLAYER_AUTHOR/);
  });
});

test("throws when CONTEXT_REPO_URL is missing", () => {
  withEnv({ MEMORYLAYER_AUTHOR: "Skanda" }, () => {
    assert.throws(() => loadConfig(), /CONTEXT_REPO_URL/);
  });
});

test("derives author email from a multi-word author name", () => {
  withEnv({ MEMORYLAYER_AUTHOR: "Skanda Test", CONTEXT_REPO_URL: "u" }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.authorEmail, "skanda.test@memorylayer.local");
  });
});

test("honors an explicit MEMORYLAYER_AUTHOR_EMAIL over the derived one", () => {
  withEnv(
    {
      MEMORYLAYER_AUTHOR: "Skanda",
      CONTEXT_REPO_URL: "u",
      MEMORYLAYER_AUTHOR_EMAIL: "skanda@real.com",
    },
    () => {
      assert.equal(loadConfig().authorEmail, "skanda@real.com");
    },
  );
});

test("autoPush defaults to true and only 'false' disables it", () => {
  withEnv({ MEMORYLAYER_AUTHOR: "S", CONTEXT_REPO_URL: "u" }, () => {
    assert.equal(loadConfig().autoPush, true);
  });
  withEnv(
    {
      MEMORYLAYER_AUTHOR: "S",
      CONTEXT_REPO_URL: "u",
      MEMORYLAYER_AUTO_PUSH: "false",
    },
    () => {
      assert.equal(loadConfig().autoPush, false);
    },
  );
  withEnv(
    {
      MEMORYLAYER_AUTHOR: "S",
      CONTEXT_REPO_URL: "u",
      MEMORYLAYER_AUTO_PUSH: "yes",
    },
    () => {
      assert.equal(loadConfig().autoPush, true);
    },
  );
});

test("repoPath defaults under ~/.memorylayer and honors CONTEXT_REPO_PATH", () => {
  withEnv({ MEMORYLAYER_AUTHOR: "S", CONTEXT_REPO_URL: "u" }, () => {
    assert.equal(
      loadConfig().repoPath,
      path.join(os.homedir(), ".memorylayer", "context-store"),
    );
  });
  withEnv(
    {
      MEMORYLAYER_AUTHOR: "S",
      CONTEXT_REPO_URL: "u",
      CONTEXT_REPO_PATH: "/tmp/store",
    },
    () => {
      assert.equal(loadConfig().repoPath, "/tmp/store");
    },
  );
});

test("loadHookEnv loads KEY=VALUE lines from .memorylayer-hook.env, skips comments/blanks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-env-"));
  fs.writeFileSync(
    path.join(dir, ".memorylayer-hook.env"),
    "# a comment\n\nMEMORYLAYER_AUTHOR=Ada\nCONTEXT_REPO_URL=https://example/x.git\n",
  );
  const saved = { ...process.env };
  delete process.env.MEMORYLAYER_AUTHOR;
  delete process.env.CONTEXT_REPO_URL;
  try {
    loadHookEnv(dir);
    assert.equal(process.env.MEMORYLAYER_AUTHOR, "Ada");
    assert.equal(process.env.CONTEXT_REPO_URL, "https://example/x.git");
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadHookEnv does NOT override an already-set env var", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-env-"));
  fs.writeFileSync(
    path.join(dir, ".memorylayer-hook.env"),
    "MEMORYLAYER_AUTHOR=FromFile\n",
  );
  const saved = { ...process.env };
  process.env.MEMORYLAYER_AUTHOR = "FromEnv";
  try {
    loadHookEnv(dir);
    assert.equal(process.env.MEMORYLAYER_AUTHOR, "FromEnv");
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadHookEnv is a silent no-op when the file is absent (fail-open)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-env-"));
  assert.doesNotThrow(() => loadHookEnv(dir));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("loadHookEnv ignores keys outside the allowlist (no env injection / RCE)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ml-env-"));
  fs.writeFileSync(
    path.join(dir, ".memorylayer-hook.env"),
    [
      "MEMORYLAYER_AUTHOR=Ada",
      "NODE_OPTIONS=--require=/tmp/evil.js",
      "PATH=/evil/bin",
      "GIT_SSH_COMMAND=touch /tmp/pwned",
      "LD_PRELOAD=/evil.so",
    ].join("\n"),
  );
  const saved = { ...process.env };
  delete process.env.MEMORYLAYER_AUTHOR;
  const beforeNode = process.env.NODE_OPTIONS;
  const beforePath = process.env.PATH;
  try {
    loadHookEnv(dir);
    // allowlisted key loaded
    assert.equal(process.env.MEMORYLAYER_AUTHOR, "Ada");
    // dangerous keys never touched
    assert.equal(process.env.NODE_OPTIONS, beforeNode);
    assert.equal(process.env.PATH, beforePath);
    assert.equal(process.env.GIT_SSH_COMMAND, saved.GIT_SSH_COMMAND);
    assert.equal(process.env.LD_PRELOAD, saved.LD_PRELOAD);
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
