import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveClient,
  renderContext,
  renderEmpty,
} from "../dist/hook-clients.js";

test("resolveClient defaults to cursor for unset/blank/unknown", () => {
  assert.equal(resolveClient(undefined), "cursor");
  assert.equal(resolveClient(""), "cursor");
  assert.equal(resolveClient("   "), "cursor");
  assert.equal(resolveClient("something-new"), "cursor");
});

test("resolveClient recognizes claude-code aliases and raw, case-insensitively", () => {
  assert.equal(resolveClient("claude-code"), "claude-code");
  assert.equal(resolveClient("claude_code"), "claude-code");
  assert.equal(resolveClient("ClaudeCode"), "claude-code");
  assert.equal(resolveClient(" RAW "), "raw");
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
