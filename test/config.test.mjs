import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../dist/config.js";

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
