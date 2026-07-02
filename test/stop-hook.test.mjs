import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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

test("claude-code: fresh turn injects a Stop self-review naming write_context", () => {
  const out = JSON.parse(runStopHook("claude-code", "{}"));
  assert.equal(out.hookSpecificOutput.hookEventName, "Stop");
  assert.match(out.hookSpecificOutput.additionalContext, /write_context/);
});

test("loop guard: stop_hook_active=true emits the no-op (no infinite loop)", () => {
  const out = runStopHook(
    "claude-code",
    JSON.stringify({ stop_hook_active: true }),
  );
  assert.equal(out.trim(), "{}");
});

test("fail-open: unparseable stdin emits the no-op and exits 0", () => {
  // execFileSync throws on non-zero exit; a returned value already proves exit 0.
  assert.equal(runStopHook("claude-code", "not json").trim(), "{}");
});

test("raw client on a fresh turn emits the review text verbatim (no JSON)", () => {
  const out = runStopHook("raw", "{}");
  assert.match(out, /MemoryLayer end-of-turn review/);
  assert.doesNotMatch(out, /hookSpecificOutput/);
});

test("raw client with loop guard emits nothing", () => {
  assert.equal(
    runStopHook("raw", JSON.stringify({ stop_hook_active: true })),
    "",
  );
});

test("codex: fresh turn injects a decision:block Stop review naming write_context", () => {
  const out = JSON.parse(runStopHook("codex", "{}"));
  assert.equal(out.decision, "block");
  assert.match(out.reason, /write_context/);
});

test("loop guard: loop_count > 0 emits the no-op (Cursor-style continuation)", () => {
  assert.equal(
    runStopHook("cursor", JSON.stringify({ loop_count: 1 })).trim(),
    "{}",
  );
});

test("codex loop guard: stop_hook_active=true emits the no-op", () => {
  assert.equal(
    runStopHook("codex", JSON.stringify({ stop_hook_active: true })).trim(),
    "{}",
  );
});
