import { test } from "node:test";
import assert from "node:assert/strict";
import { sqliteD1 } from "./sqlite-d1.mjs";

test("0007 creates the plan tables with their keys", async () => {
  const db = sqliteD1();
  const names = db.raw
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plan%'",
    )
    .all()
    .map((r) => r.name)
    .sort();
  assert.deepEqual(names, [
    "plan",
    "plan_body",
    "plan_counter",
    "plan_decision",
    "plan_run",
  ]);
  const ins =
    "INSERT INTO plan (space,id,project,seq,title,author,state,version,rev,runs,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)";
  db.raw
    .prepare(ins)
    .run("s", "p1", "proj", 1, "t", "a", "draft", 1, 1, 0, "x", "x");
  assert.throws(
    () =>
      db.raw
        .prepare(ins)
        .run("s", "p2", "proj", 1, "t", "a", "draft", 1, 1, 0, "x", "x"),
    /UNIQUE/,
  );
  assert.throws(
    () =>
      db.raw
        .prepare(ins)
        .run("s", "p3", "proj", 2, "t", "a", "bogus", 1, 1, 0, "x", "x"),
    /CHECK/,
  );
});

import { step } from "../dist/gateway/src/plan-core.js";
import * as pdb from "../dist/gateway/src/plan-db.js";

const ev = (rev, x) => ({
  plan: "p1",
  rev,
  author: "ada",
  ts: `2026-09-18T00:00:0${rev}.000Z`,
  ...x,
});
const create = {
  op: "create",
  plan: "p1",
  rev: 1,
  author: "ada",
  ts: "2026-09-18T00:00:01.000Z",
  project: "Proj",
  seq: 7,
  title: "T",
  repo: "acme/app",
  body: "v1",
  inherits: ["e#1"],
};

test("seq is per project and monotonic; bumpCounter never lowers it", async () => {
  const db = sqliteD1();
  assert.equal(await pdb.nextSeq(db, "s", "a"), 1);
  assert.equal(await pdb.nextSeq(db, "s", "a"), 2);
  assert.equal(await pdb.nextSeq(db, "s", "b"), 1);
  assert.equal(await pdb.nextSeq(db, "t", "a"), 1);
  await pdb.bumpCounter(db, "s", "a", 10);
  await pdb.bumpCounter(db, "s", "a", 3);
  assert.equal(await pdb.nextSeq(db, "s", "a"), 11);
});

test("applyStep projects create/edit/runs; reads by #seq, seq or id", async () => {
  const db = sqliteD1();
  let s = step(null, create);
  assert.equal(await pdb.applyStep(db, "s", null, s), true);
  s = step(s.meta, ev(2, { op: "edit", body: "v2" }));
  assert.equal(await pdb.applyStep(db, "s", 1, s), true);
  s = step(s.meta, ev(3, { op: "transition", to: "active" }));
  assert.equal(await pdb.applyStep(db, "s", 2, s), true);
  s = step(s.meta, ev(4, { op: "transition", to: "building", agent: "cc" }));
  assert.equal(await pdb.applyStep(db, "s", 3, s), true);
  for (const ref of ["#7", "7", "p1"]) {
    const m = await pdb.getPlan(db, "s", "proj", ref);
    assert.equal(m.state, "building", ref);
    assert.equal(m.repo, "acme/app");
    assert.equal(m.branch, null);
    assert.equal(m.rev, 4);
  }
  assert.deepEqual(await pdb.getPlan(db, "s", "proj", "p1"), s.meta);
  assert.equal((await pdb.getBody(db, "s", "p1")).markdown, "v2");
  assert.equal((await pdb.getBody(db, "s", "p1", 1)).markdown, "v1");
  assert.equal(await pdb.getBody(db, "s", "p1", 9), null);
  assert.deepEqual(await pdb.listLinks(db, "s", "p1"), [
    { factId: "e#1", role: "inherited" },
  ]);
  const runs = await pdb.listRuns(db, "s", "p1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].agent, "cc");
  assert.equal(runs[0].ended, null);
  s = step(
    s.meta,
    ev(5, {
      op: "transition",
      to: "shipped",
      commitSha: "abc",
      produced: ["f#2"],
    }),
  );
  await pdb.applyStep(db, "s", 4, s);
  assert.equal((await pdb.listRuns(db, "s", "p1"))[0].commitSha, "abc");
  assert.equal((await pdb.listRuns(db, "s", "p1"))[0].outcome, "shipped");
  assert.equal((await pdb.listLinks(db, "s", "p1")).length, 2);
});

test("plans are scoped by space and project", async () => {
  const db = sqliteD1();
  await pdb.applyStep(db, "s", null, step(null, create));
  assert.equal(await pdb.getPlan(db, "other", "proj", "#7"), null);
  assert.equal(await pdb.getPlan(db, "other", "proj", "p1"), null);
  assert.equal(await pdb.getPlan(db, "s", "elsewhere", "p1"), null);
  assert.equal(await pdb.getPlan(db, "s", "proj", "nope"), null);
  assert.equal((await pdb.listPlans(db, "s", "proj")).length, 1);
  assert.equal((await pdb.listPlans(db, "s", "elsewhere")).length, 0);
});

test("a stale prevRev loses the race and writes nothing", async () => {
  const db = sqliteD1();
  const c = step(null, create);
  await pdb.applyStep(db, "s", null, c);
  assert.equal(await pdb.applyStep(db, "s", null, c), false);
  await pdb.applyStep(
    db,
    "s",
    1,
    step(c.meta, ev(2, { op: "edit", body: "winner" })),
  );
  const loser = step(c.meta, ev(2, { op: "edit", body: "loser", title: "L" }));
  assert.equal(await pdb.applyStep(db, "s", 1, loser), false);
  assert.equal((await pdb.getBody(db, "s", "p1")).markdown, "winner");
  assert.equal((await pdb.getPlan(db, "s", "proj", "p1")).title, "T");
});

test("clearPlan removes every row of one plan only", async () => {
  const db = sqliteD1();
  await pdb.applyStep(db, "s", null, step(null, create));
  await pdb.applyStep(
    db,
    "s",
    null,
    step(null, { ...create, plan: "p2", seq: 8 }),
  );
  await pdb.clearPlan(db, "s", "p1");
  assert.equal(await pdb.getPlan(db, "s", "proj", "p1"), null);
  assert.equal(await pdb.getBody(db, "s", "p1"), null);
  assert.deepEqual(await pdb.listLinks(db, "s", "p1"), []);
  assert.ok(await pdb.getPlan(db, "s", "proj", "p2"));
});
