import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveClient,
  renderContext,
  renderEmpty,
  renderStopReview,
  renderStopNoop,
} from "../dist/hook-clients.js";

test("resolveClient defaults to cursor for unset/blank/unknown", () => {
  assert.equal(resolveClient(undefined), "cursor");
  assert.equal(resolveClient(""), "cursor");
  assert.equal(resolveClient("   "), "cursor");
  assert.equal(resolveClient("something-new"), "cursor");
});

test("resolveClient recognizes claude-code aliases, raw, and codex, case-insensitively", () => {
  assert.equal(resolveClient("claude-code"), "claude-code");
  assert.equal(resolveClient("claude_code"), "claude-code");
  assert.equal(resolveClient("ClaudeCode"), "claude-code");
  assert.equal(resolveClient(" RAW "), "raw");
  assert.equal(resolveClient("codex"), "codex");
  assert.equal(resolveClient(" CODEX "), "codex");
});

test("cursor envelope uses additional_context", () => {
  const out = JSON.parse(renderContext("cursor", "hello"));
  assert.deepEqual(Object.keys(out), ["additional_context"]);
  assert.equal(out.additional_context, "hello");
});

test("claude-code envelope nests additionalContext under the SessionStart event", () => {
  const out = JSON.parse(renderContext("claude-code", "hello"));
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(out.hookSpecificOutput.additionalContext, "hello");
});

test("raw envelope is the text verbatim (no JSON)", () => {
  assert.equal(renderContext("raw", "hello"), "hello");
});

test("empty no-op is valid per client: {} for JSON clients, empty for raw", () => {
  assert.equal(renderEmpty("cursor"), "{}");
  assert.equal(renderEmpty("claude-code"), "{}");
  assert.equal(renderEmpty("raw"), "");
  // The JSON no-op must parse and carry no injected context.
  assert.deepEqual(JSON.parse(renderEmpty("cursor")), {});
});

test("claude-code Stop review nests additionalContext under the Stop event", () => {
  const out = JSON.parse(renderStopReview("claude-code", "review please"));
  assert.equal(out.hookSpecificOutput.hookEventName, "Stop");
  assert.equal(out.hookSpecificOutput.additionalContext, "review please");
});

test("raw Stop review is the text verbatim", () => {
  assert.equal(renderStopReview("raw", "review please"), "review please");
});

test("cursor Stop review re-engages via followup_message", () => {
  const out = JSON.parse(renderStopReview("cursor", "review please"));
  assert.deepEqual(Object.keys(out), ["followup_message"]);
  assert.equal(out.followup_message, "review please");
});

test("Stop no-op is valid per client: {} for JSON clients, empty for raw", () => {
  assert.equal(renderStopNoop("claude-code"), "{}");
  assert.equal(renderStopNoop("cursor"), "{}");
  assert.equal(renderStopNoop("raw"), "");
  assert.deepEqual(JSON.parse(renderStopNoop("claude-code")), {});
});

test("codex read envelope matches the claude-code SessionStart shape", () => {
  const out = JSON.parse(renderContext("codex", "hello"));
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(out.hookSpecificOutput.additionalContext, "hello");
});

test("codex Stop review re-engages via decision:block with reason", () => {
  const out = JSON.parse(renderStopReview("codex", "review please"));
  assert.equal(out.decision, "block");
  assert.equal(out.reason, "review please");
});

test("codex empty and Stop no-ops are valid {} JSON", () => {
  assert.equal(renderEmpty("codex"), "{}");
  assert.equal(renderStopNoop("codex"), "{}");
  assert.deepEqual(JSON.parse(renderStopNoop("codex")), {});
});
