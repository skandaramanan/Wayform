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

test("playbook forces search before clarifying questions and recommendations, and stores agent conclusions", () => {
  const text = invocationPlaybook("memorylayer");
  assert.match(text, /BEFORE asking the user a clarifying question/);
  assert.match(text, /never ask for information you could have retrieved/i);
  assert.match(text, /BEFORE recommending an action/);
  assert.match(text, /already recommended or already done/);
  assert.match(text, /conclusions YOU produced/);
  assert.match(text, /condensed summary/);
});

test("mcpInstructions mirrors the new invocation rules", () => {
  const text = mcpInstructions("memorylayer");
  assert.match(text, /before asking the user a clarifying question/);
  assert.match(text, /before recommending an action/);
  assert.match(text, /durable conclusion you produced/);
});

test("supersedes amend guidance appears only when the plane supports it", () => {
  const withIt = invocationPlaybook("memorylayer", { supersedes: true });
  assert.match(withIt, /UPDATE or CORRECT a recorded decision/);
  assert.match(withIt, /supersedes: \[<old fact id from search results>\]/);
  const without = invocationPlaybook("memorylayer");
  assert.ok(
    !/supersedes/.test(without),
    "local playbook must not name supersedes",
  );

  const mcpWith = mcpInstructions("memorylayer", { supersedes: true });
  assert.match(mcpWith, /supersedes:\[old fact id from search results\]/);
  const mcpWithout = mcpInstructions("memorylayer");
  assert.ok(!/supersedes/.test(mcpWithout));

  const composed = composeSessionStartText("memorylayer", "body", {
    supersedes: true,
  });
  assert.match(composed, /UPDATE or CORRECT a recorded decision/);
});
