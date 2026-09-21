// renderBrief is pure: given retrieved docs it must produce a brief that
// names every fact id (create_plan inherits them) and carries the skeleton.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBrief } from "../dist/gateway/src/plan-brief.js";

const doc = (id, kind, body, ts = "2026-09-01T00:00:00.000Z") => ({
  doc: {
    id,
    kind,
    body,
    entities: [],
    sourceTs: ts,
    sourceAuthor: "Ada",
    tier: "normal",
  },
  score: 0.5,
});

test("brief lists decisions with their fact ids and asks for inherits", () => {
  const out = renderBrief(
    "MemoryLayer",
    "add a rate limiter to the gateway",
    [
      doc("f1#a", "decision", "we cap writes at 60/min because D1 rows are the cost"),
      doc("f2#b", "constraint", "stay on the $0 free tier"),
    ],
    [],
  );
  assert.match(out, /f1#a/);
  assert.match(out, /f2#b/);
  assert.match(out, /add a rate limiter to the gateway/);
  assert.match(out, /create_plan/);
  assert.match(out, /inherits/);
  assert.match(out, /## Goal/);
  assert.match(out, /## Approach/);
  assert.match(out, /## Checklist/);
  // Retrieval is recall-biased: the agent must be told to prune the list,
  // not to paste it (live 2026-09-21: 3 of 12 ids were near-misses).
  assert.match(out, /does not actually bind this work/);
  // Each fact line carries its own id: the agent must never have to map ids to
  // facts by position, which two bake-off plans admitted doing.
  assert.match(out, /cap writes at 60\/min[^\n]*id: f1#a/);
  assert.match(out, /\$0 free tier[^\n]*id: f2#b/);
});

test("open questions are called out separately from decisions", () => {
  const out = renderBrief(
    "MemoryLayer",
    "dispatch",
    [doc("q1#a", "question", "does the hook timeout survive human latency?")],
    [],
  );
  assert.match(out, /Open questions/);
  assert.match(out, /does the hook timeout survive human latency\?/);
  // A question is not a constraint: it must not be offered as an inherit.
  // (The prose mentions `inherits`; what must be absent is the id list.)
  assert.doesNotMatch(out, /inherits=\[/);
});

test("related plans are shown as prior art, not as constraints", () => {
  const out = renderBrief("MemoryLayer", "dispatch", [], [
    doc("plan:p1", "plan", "Plan #6 [draft] Phase 4 — dispatch"),
  ]);
  assert.match(out, /Related plans/);
  assert.match(out, /Plan #6/);
});

test("an empty store still returns a usable skeleton", () => {
  const out = renderBrief("MemoryLayer", "anything", [], []);
  assert.match(out, /## Goal/);
  assert.doesNotMatch(out, /Decisions that constrain/);
});
