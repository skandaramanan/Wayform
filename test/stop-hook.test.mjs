import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  assert.match(out, /Wayform end-of-turn review/);
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

test("throttle: with a session_id, only every 4th stop fires the review", () => {
  const session_id = randomUUID();
  const payload = JSON.stringify({ session_id });
  for (let i = 1; i <= 3; i++) {
    assert.equal(runStopHook("claude-code", payload).trim(), "{}");
  }
  const out = JSON.parse(runStopHook("claude-code", payload));
  assert.match(out.hookSpecificOutput.additionalContext, /write_context/);
  // Counter resets: the 5th stop is throttled again.
  assert.equal(runStopHook("claude-code", payload).trim(), "{}");
});

test("cursor throttles by conversation_id and gates aborted turns without counting them", () => {
  const conversation_id = randomUUID();
  const completed = JSON.stringify({ conversation_id, status: "completed" });
  // Aborted turns are gated and must not advance the counter.
  assert.equal(
    runStopHook(
      "cursor",
      JSON.stringify({ conversation_id, status: "aborted" }),
    ).trim(),
    "{}",
  );
  for (let i = 1; i <= 3; i++) {
    assert.equal(runStopHook("cursor", completed).trim(), "{}");
  }
  const out = JSON.parse(runStopHook("cursor", completed));
  assert.match(out.followup_message, /write_context/);
});

test("codex: empty last_assistant_message is gated even on a firing turn", () => {
  const session_id = randomUUID();
  const withText = JSON.stringify({ session_id, last_assistant_message: "hi" });
  for (let i = 1; i <= 3; i++) {
    assert.equal(runStopHook("codex", withText).trim(), "{}");
  }
  assert.equal(
    runStopHook(
      "codex",
      JSON.stringify({ session_id, last_assistant_message: null }),
    ).trim(),
    "{}",
  );
});

test("claude-code: write_context already called this turn gates the firing stop", () => {
  const transcript = join(tmpdir(), `wayform-test-transcript-${randomUUID()}`);
  const entry = (type, blocks) =>
    JSON.stringify({ type, message: { content: blocks } });
  writeFileSync(
    transcript,
    [
      entry("user", [{ type: "text", text: "record that decision" }]),
      entry("assistant", [
        { type: "tool_use", name: "mcp__memorylayer-remote__write_context" },
      ]),
      entry("user", [{ type: "tool_result", content: "ok" }]),
      entry("assistant", [{ type: "text", text: "recorded." }]),
    ].join("\n"),
  );
  const session_id = randomUUID();
  const payload = JSON.stringify({ session_id, transcript_path: transcript });
  for (let i = 1; i <= 3; i++) {
    assert.equal(runStopHook("claude-code", payload).trim(), "{}");
  }
  // 4th stop would fire, but the turn already wrote — gated.
  assert.equal(runStopHook("claude-code", payload).trim(), "{}");
});

test("claude-code: a write_context BEFORE the last user message does not gate", () => {
  const transcript = join(tmpdir(), `wayform-test-transcript-${randomUUID()}`);
  const entry = (type, blocks) =>
    JSON.stringify({ type, message: { content: blocks } });
  writeFileSync(
    transcript,
    [
      entry("assistant", [
        { type: "tool_use", name: "mcp__memorylayer-remote__write_context" },
      ]),
      entry("user", [{ type: "text", text: "next question" }]),
      entry("assistant", [{ type: "text", text: "answered." }]),
    ].join("\n"),
  );
  const session_id = randomUUID();
  const payload = JSON.stringify({ session_id, transcript_path: transcript });
  for (let i = 1; i <= 3; i++) {
    assert.equal(runStopHook("claude-code", payload).trim(), "{}");
  }
  const out = JSON.parse(runStopHook("claude-code", payload));
  assert.match(out.hookSpecificOutput.additionalContext, /write_context/);
});
