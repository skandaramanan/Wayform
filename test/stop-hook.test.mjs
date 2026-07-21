import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const hookPath = fileURLToPath(
  new URL("../dist/stop-hook.js", import.meta.url),
);

/** Run the built Stop hook with a controlled client + stdin payload; capture stdout. */
function runStopHook(client, stdin) {
  return execFileSync(process.execPath, [hookPath], {
    input: stdin,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", MEMORYLAYER_HOOK_CLIENT: client },
  });
}

test("stop-hook always no-ops (re-engagement removed)", () => {
  for (const client of ["claude-code", "cursor", "codex"]) {
    assert.equal(
      runStopHook(client, JSON.stringify({ session_id: randomUUID() })).trim(),
      "{}",
    );
  }
  assert.equal(runStopHook("raw", "{}"), "");
});

test("stop-hook fail-open: unparseable stdin still exits 0 with no-op", () => {
  assert.equal(runStopHook("claude-code", "not json").trim(), "{}");
});

test("stop-hook loop-guard payloads also no-op", () => {
  assert.equal(
    runStopHook(
      "claude-code",
      JSON.stringify({ stop_hook_active: true }),
    ).trim(),
    "{}",
  );
  assert.equal(
    runStopHook("cursor", JSON.stringify({ loop_count: 1 })).trim(),
    "{}",
  );
});
