import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

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
