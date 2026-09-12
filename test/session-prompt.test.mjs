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
  assert.match(text, /condensed/);
});

test("playbook forces soft-write phrasing and remote MCP plane", () => {
  const text = invocationPlaybook("memorylayer");
  assert.match(text, /log this for the team/);
  assert.match(text, /remote MCP/);
  assert.match(text, /soft team-log phrasing/);
});

test("mcpInstructions mirrors soft-write and remote-only rules", () => {
  const text = mcpInstructions("memorylayer");
  assert.match(text, /remote MCP/);
  assert.match(text, /log this for the team/);
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

test("mcpInstructions never offers the space name as a project default", () => {
  // Regression for 2026-09-13: it said `Default project if unsure: "<space>"`,
  // and mcp.ts passed member.space. An agent with no briefing then wrote five
  // real decisions into project "skandaramanan-memorylayer-memory" (18 entries)
  // while every hook read "memorylayer" (423) — invisible at session start,
  // with nothing reporting an error. No test covered this string.
  const text = mcpInstructions("skandaramanan-memorylayer-memory");

  assert.doesNotMatch(
    text,
    /default project[^.]*"/i,
    "must not name any default project — the server cannot know the caller's",
  );
  // The space may be mentioned, but only as a space and never as a project.
  assert.match(text, /space/i);
  assert.doesNotMatch(
    text,
    /project[^.]{0,40}"skandaramanan-memorylayer-memory"/i,
    "the space name must never appear where a project name belongs",
  );
  // It must send the agent somewhere real for the answer.
  assert.match(text, /session-start briefing/i);
  assert.match(text, /ask/i);
});

test("the briefing and the MCP instructions agree on where project comes from", () => {
  // The hook side already spells the project out; the MCP twin must point at
  // it rather than inventing its own answer.
  const briefing = invocationPlaybook("MemoryLayer");
  assert.match(briefing, /write_context\(project="MemoryLayer"/);
  assert.match(
    mcpInstructions("some-space"),
    /briefing/i,
    "instructions must defer to the briefing the hook injects",
  );
});
