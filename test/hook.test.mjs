import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { ContextStore } from "../dist/store.js";

const hookPath = fileURLToPath(new URL("../dist/hook.js", import.meta.url));

/**
 * Run the built hook with a controlled env (deliberately WITHOUT the required
 * MEMORYLAYER_AUTHOR/CONTEXT_REPO_URL so loadConfig throws), capturing stdout.
 * execFileSync throws on a non-zero exit — so a passing call already proves the
 * hook exited 0, the load-bearing half of the fail-open contract.
 */
function runHook(client) {
  return execFileSync(process.execPath, [hookPath], {
    input: "",
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      MEMORYLAYER_HOOK_CLIENT: client,
    },
  });
}

test("fail-open: cursor client emits the {} no-op and exits 0", () => {
  assert.equal(runHook("cursor").trim(), "{}");
});

test("fail-open: claude-code client emits the {} no-op and exits 0", () => {
  assert.equal(runHook("claude-code").trim(), "{}");
});

test("fail-open: raw client emits nothing and exits 0", () => {
  assert.equal(runHook("raw"), "");
});

test("fail-open: unknown client defaults to cursor's {} no-op", () => {
  assert.equal(runHook("something-new").trim(), "{}");
});

test("fail-open: codex client emits the {} no-op and exits 0", () => {
  assert.equal(runHook("codex").trim(), "{}");
});

/** Bare "remote" seeded with a main branch and one commit (mirrors integration). */
function freshRemote() {
  const g = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ml-hookmetrics-"));
  const bare = path.join(tmp, "remote.git");
  g(tmp, "init", "--bare", "--initial-branch=main", bare);
  const seed = path.join(tmp, "seed");
  g(tmp, "clone", bare, seed);
  fs.writeFileSync(path.join(seed, "README.md"), "shared\n");
  g(seed, "add", ".");
  g(
    seed,
    "-c",
    "user.email=s@x",
    "-c",
    "user.name=seed",
    "commit",
    "-m",
    "init",
  );
  g(seed, "push", "origin", "main");
  return { tmp, bare };
}

test('end-to-end: the read hook appends a source:"hook" metric line', async () => {
  const { tmp, bare } = freshRemote();
  try {
    const clone = path.join(tmp, "clone");
    const cfg = {
      repoUrl: bare,
      repoPath: clone,
      author: "Alice",
      authorEmail: "alice@memorylayer.local",
      autoPush: true,
    };
    // Seed one entry so the hook injects context (and a read happens).
    const store = new ContextStore(cfg);
    await store.ensure();
    await store.write("memorylayer", {
      author: "Alice",
      type: "decision",
      payload: "Seed decision.",
    });

    // Spawn the built hook with a full valid env pointing at the same clone.
    execFileSync(process.execPath, [hookPath], {
      input: "",
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        MEMORYLAYER_HOOK_CLIENT: "claude-code",
        MEMORYLAYER_AUTHOR: "Alice",
        MEMORYLAYER_PROJECT: "memorylayer",
        CONTEXT_REPO_URL: bare,
        CONTEXT_REPO_PATH: clone,
      },
    });

    const metricsFile = path.join(clone, "metrics", "alice.jsonl");
    assert.ok(fs.existsSync(metricsFile), "hook wrote a metrics line");
    const rec = JSON.parse(
      fs.readFileSync(metricsFile, "utf8").trim().split("\n").pop(),
    );
    assert.equal(rec.source, "hook");
    assert.equal(rec.event, "read");
    assert.equal(rec.project, "memorylayer");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("remote-first: an unreachable gateway falls back to the local clone read", async () => {
  const { tmp, bare } = freshRemote();
  try {
    const clone = path.join(tmp, "clone");
    const cfg = {
      repoUrl: bare,
      repoPath: clone,
      author: "Alice",
      authorEmail: "alice@memorylayer.local",
      autoPush: true,
    };
    const store = new ContextStore(cfg);
    await store.ensure();
    await store.write("memorylayer", {
      author: "Alice",
      type: "decision",
      payload: "Local fallback decision.",
    });

    // Gateway configured but unreachable (connection refused → remote read
    // returns null → local clone serves the read). Proves fail-open wiring.
    const out = execFileSync(process.execPath, [hookPath], {
      input: "",
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        MEMORYLAYER_HOOK_CLIENT: "raw",
        MEMORYLAYER_AUTHOR: "Alice",
        MEMORYLAYER_PROJECT: "memorylayer",
        CONTEXT_REPO_URL: bare,
        CONTEXT_REPO_PATH: clone,
        MEMORYLAYER_GATEWAY_URL: "http://127.0.0.1:1",
        MEMORYLAYER_GATEWAY_TOKEN: "mlk_unreachable",
      },
    });
    assert.match(out, /Local fallback decision\./);
    assert.match(out, /required tool policy/);
    assert.match(out, /search_memory/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
