import { test } from "node:test";
import assert from "node:assert/strict";
import {
  step,
  PlanError,
  serializeEvent,
  parseEvent,
  foldEvents,
  eventPath,
  planDocBody,
} from "../dist/gateway/src/plan-core.js";

const create = {
  op: "create",
  plan: "p1",
  rev: 1,
  author: "ada",
  ts: "2026-09-18T00:00:00.000Z",
  project: "proj",
  seq: 1,
  title: "Auth rework",
  body: "- [ ] step",
  inherits: ["e1#a"],
};
const at = (rev, extra) => ({
  plan: "p1",
  rev,
  author: "ada",
  ts: `2026-09-18T00:00:0${rev}.000Z`,
  ...extra,
});

test("create → draft v1 with inherited links", () => {
  const s = step(null, create);
  assert.equal(s.meta.state, "draft");
  assert.equal(s.meta.version, 1);
  assert.equal(s.meta.rev, 1);
  assert.deepEqual(s.body, {
    version: 1,
    markdown: "- [ ] step",
    author: "ada",
    ts: create.ts,
  });
  assert.deepEqual(s.links, [{ factId: "e1#a", role: "inherited" }]);
  assert.throws(() => step(s.meta, create), PlanError);
});

test("every body edit is a new version; title-only edits are not", () => {
  const m = step(null, create).meta;
  const e = step(m, at(2, { op: "edit", body: "- [x] step" }));
  assert.equal(e.meta.version, 2);
  assert.equal(e.body.version, 2);
  const t = step(e.meta, at(3, { op: "edit", title: "Auth v2" }));
  assert.equal(t.meta.version, 2);
  assert.equal(t.body, undefined);
  assert.equal(t.meta.title, "Auth v2");
  assert.equal(t.meta.updated, at(3).ts);
});

test("lifecycle is forward-only and runs open/close", () => {
  let m = step(null, create).meta;
  assert.throws(
    () => step(m, at(2, { op: "transition", to: "building" })),
    /illegal transition draft → building/,
  );
  m = step(m, at(2, { op: "transition", to: "active" })).meta;
  const b = step(
    m,
    at(3, { op: "transition", to: "building", agent: "claude-code" }),
  );
  assert.deepEqual(b.runStart, { run: 1, agent: "claude-code", ts: at(3).ts });
  const s = step(
    b.meta,
    at(4, {
      op: "transition",
      to: "shipped",
      commitSha: "abc",
      produced: ["e9#x"],
    }),
  );
  assert.equal(s.meta.state, "shipped");
  assert.deepEqual(s.runEnd, {
    run: 1,
    ts: at(4).ts,
    outcome: "shipped",
    commitSha: "abc",
  });
  assert.deepEqual(s.links, [{ factId: "e9#x", role: "produced" }]);
  assert.throws(() => step(s.meta, at(5, { op: "edit", body: "x" })), /frozen/);
  assert.throws(
    () => step(s.meta, at(5, { op: "transition", to: "active" })),
    PlanError,
  );
});

test("supersede from any live state, never twice, never by itself", () => {
  const m = step(null, create).meta;
  assert.throws(() => step(m, at(2, { op: "supersede", by: "p1" })), PlanError);
  const s = step(m, at(2, { op: "supersede", by: "p2" }));
  assert.equal(s.meta.state, "superseded");
  assert.equal(s.meta.supersededBy, "p2");
  assert.equal(s.runEnd, undefined);
  assert.throws(
    () => step(s.meta, at(3, { op: "supersede", by: "p3" })),
    PlanError,
  );
});

test("superseding a building plan closes its open run", () => {
  let m = step(null, create).meta;
  m = step(m, at(2, { op: "transition", to: "active" })).meta;
  m = step(m, at(3, { op: "transition", to: "building" })).meta;
  const s = step(m, at(4, { op: "supersede", by: "p2" }));
  assert.deepEqual(s.runEnd, {
    run: 1,
    ts: at(4).ts,
    outcome: "superseded",
    commitSha: null,
  });
});

test("a stale rev is rejected (the optimistic lock)", () => {
  const m = step(null, create).meta;
  assert.throws(() => step(m, at(3, { op: "edit", body: "x" })), /rev/);
  assert.throws(() => step(m, at(1, { op: "edit", body: "x" })), /rev/);
});

test("event files round-trip; the body stays readable markdown", () => {
  const raw = serializeEvent(create);
  assert.match(raw, /^---\nevent: \{.*\}\n---\n\n- \[ \] step\n$/);
  assert.deepEqual(parseEvent(raw), create);
  const multiline = { ...create, body: "# T\n\n- a\n- b\n\n" };
  assert.deepEqual(parseEvent(serializeEvent(multiline)), multiline);
  const noBody = at(2, { op: "edit", title: "T" });
  assert.deepEqual(parseEvent(serializeEvent(noBody)), noBody);
  assert.equal(parseEvent("garbage"), null);
  assert.equal(parseEvent("---\nevent: {not json\n---\n\n"), null);
});

test("event paths sort in rev order under the plan's directory", () => {
  const p = eventPath(at(12, { op: "edit", body: "x" }), "My Proj");
  assert.match(
    p,
    /^plans\/my-proj\/p1\/00012-2026-09-18T00-00-012-000Z-[a-z0-9]{4}\.md$/,
  );
});

test("fold replays in path order and skips raced or garbage events", () => {
  const evs = [
    create,
    at(2, { op: "edit", body: "v2" }),
    at(2, { op: "edit", body: "loser" }),
  ];
  const files = evs.map((ev, i) => ({
    path: `plans/proj/p1/${String(ev.rev).padStart(5, "0")}-x-${i}.md`,
    raw: serializeEvent(ev),
  }));
  files.push({ path: "plans/proj/p1/00003-junk.md", raw: "junk" });
  const { meta, steps, skipped } = foldEvents([...files].reverse());
  assert.equal(meta.version, 2);
  assert.equal(steps.length, 2);
  assert.equal(steps[1].body.markdown, "v2");
  assert.deepEqual(skipped.sort(), [
    "plans/proj/p1/00002-x-2.md",
    "plans/proj/p1/00003-junk.md",
  ]);
});

test("plan doc body leads with number, state and title, capped", () => {
  const m = step(null, create).meta;
  assert.equal(
    planDocBody(m, "- [ ] step"),
    "Plan #1 [draft] Auth rework\n\n- [ ] step",
  );
  assert.equal(planDocBody(m, "x".repeat(10_000)).length, 4000);
});
