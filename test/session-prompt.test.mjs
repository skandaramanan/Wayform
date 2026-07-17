import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composeSessionStartText,
  invocationPlaybook,
  mcpInstructions,
  sessionPreamble,
} from "../dist/session-prompt.js";

test("invocationPlaybook names every MemoryLayer tool and key anti-patterns", () => {
  const text = invocationPlaybook("memorylayer");
  for (const name of [
    "search_memory",
    "read_context",
    "write_context",
    "memory_feedback",
  ]) {
    assert.match(text, new RegExp(name));
  }
  assert.match(text, /MUST call/);
  assert.match(text, /MUST NOT/);
  assert.match(text, /queryless/);
  assert.match(text, /memorylayer/);
});

test("composeSessionStartText puts policy before data and keeps the preamble", () => {
  const text = composeSessionStartText(
    "roadmap",
    "# Shared context: roadmap\n\nhello",
  );
  const policyAt = text.indexOf("required tool policy");
  const dataAt = text.indexOf("shared planning memory (MemoryLayer)");
  const bodyAt = text.indexOf("# Shared context: roadmap");
  assert.ok(policyAt >= 0 && dataAt > policyAt && bodyAt > dataAt);
  assert.match(text, /search_memory/);
  assert.equal(sessionPreamble("roadmap").includes("roadmap"), true);
});

test("mcpInstructions mirrors the forcing rules for initialize", () => {
  const text = mcpInstructions("team-a");
  assert.match(text, /search_memory/);
  assert.match(text, /write_context/);
  assert.match(text, /memory_feedback/);
  assert.match(text, /team-a/);
  assert.match(text, /MUST:/);
});
