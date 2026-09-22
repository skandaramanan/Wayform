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
      doc(
        "f1#a",
        "decision",
        "we cap writes at 60/min because D1 rows are the cost",
      ),
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
  const out = renderBrief(
    "MemoryLayer",
    "dispatch",
    [],
    [doc("plan:p1", "plan", "Plan #6 [draft] Phase 4 — dispatch")],
  );
  assert.match(out, /Related plans/);
  assert.match(out, /Plan #6/);
});

test("an empty store still returns a usable skeleton", () => {
  const out = renderBrief("MemoryLayer", "anything", [], []);
  assert.match(out, /## Goal/);
  assert.doesNotMatch(out, /Decisions that constrain/);
});

// The canon section is a DUMP, not a ranked selection: a standing rule that
// shares no token with the prompt is never a retrieval candidate, so ranking
// can never reach it. This is the assertion that fails if canon is ever
// quietly turned back into a query-ranked top-N.
const canonDoc = (id, body) => ({
  id,
  kind: "constraint",
  tier: "canon",
  body,
  entities: [],
  sourceTs: "2026-09-18T00:00:00.000Z",
  sourceAuthor: "Ada",
});

test("a standing rule with zero overlap with the prompt still appears, with its id", () => {
  const out = renderBrief(
    "MemoryLayer",
    "add roles so a space can have read-only members",
    [],
    [],
    [canonDoc("c1#a", "Never put policy checks in a transport")],
  );
  assert.match(out, /## Standing rules/);
  assert.match(out, /Never put policy checks in a transport[^\n]*id: c1#a/);
  // Shown, but not pre-filled into inherits — 47 pasted ids is not curation.
  assert.doesNotMatch(out, /inherits=\[[^\]]*c1#a/);
});

test("a canon fact that also ranked is not printed twice", () => {
  const out = renderBrief(
    "MemoryLayer",
    "transport",
    [doc("c1#a", "constraint", "Never put policy checks in a transport")],
    [],
    [canonDoc("c1#a", "Never put policy checks in a transport")],
  );
  assert.equal(out.match(/c1#a/g).length, 1);
});

test("canon past the cap collapses into a count", () => {
  const many = Array.from({ length: 70 }, (_, i) =>
    canonDoc(`c${i}#x`, `Standing rule number ${i}`),
  );
  const out = renderBrief("MemoryLayer", "anything", [], [], many);
  assert.match(out, /10 more standing rules/);
});

// plan_brief runs two retrieve() passes over the SAME prompt. Each used to
// embed it separately — two Workers AI calls for one vector on every brief.
import { planBrief } from "../dist/gateway/src/plan-brief.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import { fakeEmbed } from "./helpers.mjs";

test("plan_brief embeds the prompt exactly once", async () => {
  const seen = [];
  const counting = async (texts) => {
    seen.push(...texts);
    return fakeEmbed(texts);
  };
  const env = { indexDb: new MemoryIndexDb(), embedder: counting };
  await planBrief(
    { env, member: { space: "s", author: "Ada" } },
    { project: "p", prompt: "add a rate limiter" },
  );
  assert.deepEqual(seen, ["add a rate limiter"]);
});

test("plan_brief still answers when the embedder throws", async () => {
  const env = {
    indexDb: new MemoryIndexDb(),
    embedder: async () => {
      throw new Error("workers ai down");
    },
  };
  const out = await planBrief(
    { env, member: { space: "s", author: "Ada" } },
    { project: "p", prompt: "anything" },
  );
  assert.match(out, /# Plan brief: p/);
});
