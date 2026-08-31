import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveClient,
  renderContext,
  renderEmpty,
  renderPromptContext,
  renderGuardDecision,
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

test("codex read envelope matches the claude-code SessionStart shape", () => {
  const out = JSON.parse(renderContext("codex", "hello"));
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.equal(out.hookSpecificOutput.additionalContext, "hello");
});

test("codex empty no-op is valid {} JSON", () => {
  assert.equal(renderEmpty("codex"), "{}");
  assert.deepEqual(JSON.parse(renderEmpty("codex")), {});
});

test("renderPromptContext injects UserPromptSubmit context for claude-code only", () => {
  const out = JSON.parse(renderPromptContext("claude-code", "relevant memory"));
  assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.equal(out.hookSpecificOutput.additionalContext, "relevant memory");
  assert.equal(renderPromptContext("cursor", "x").trim(), "{}");
  assert.equal(renderPromptContext("raw", "x"), "");
});

test("renderGuardDecision emits Claude Code's PreToolUse ask envelope", () => {
  const out = JSON.parse(
    renderGuardDecision(
      "claude-code",
      "ask",
      "Second datastore was ruled out.",
    ),
  );
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "ask");
  assert.match(
    out.hookSpecificOutput.permissionDecisionReason,
    /Second datastore was ruled out/,
  );
});

test("renderGuardDecision never emits deny", () => {
  for (const d of ["ask", "allow"]) {
    assert.doesNotMatch(renderGuardDecision("claude-code", d, "r"), /deny/);
  }
});

test("renderGuardDecision is a silent no-op on allow", () => {
  assert.equal(renderGuardDecision("claude-code", "allow", "r"), "{}");
});

test("renderGuardDecision is a no-op for clients without a guard hook", () => {
  for (const c of ["cursor", "codex"]) {
    assert.equal(renderGuardDecision(c, "ask", "r"), "{}");
  }
  assert.equal(renderGuardDecision("raw", "ask", "r"), "");
});
