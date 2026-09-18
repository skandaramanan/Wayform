import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPlan,
  readPlan,
  listProjectPlans,
  editPlan,
  transitionPlan,
  rebuildPlans,
  MAX_PLAN_BODY_CHARS,
  MAX_LINKED_FACTS,
} from "../dist/gateway/src/plans.js";
import {
  PlanError,
  parseEvent,
  foldEvents,
  serializeEvent,
  step,
} from "../dist/gateway/src/plan-core.js";
import * as pdb from "../dist/gateway/src/plan-db.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import { sqliteD1 } from "./sqlite-d1.mjs";
import { makeEnv, ghFetch, fakeEmbed, fakeLedger } from "./helpers.mjs";

const MEMBER = {
  space: "team-a",
  installationId: 777,
  owner: "acme",
  repo: "team-a-memory",
  branch: "main",
  author: "Ada",
  authorEmail: "ada@acme.io",
};

function planCtx(extraRoutes = []) {
  const ledger = fakeLedger();
  const env = makeEnv(ghFetch([], [...extraRoutes, ...ledger.routes]));
  const c = {
    env,
    member: MEMBER,
    db: sqliteD1(),
    idx: new MemoryIndexDb(),
    embed: fakeEmbed,
    gen: null,
    fetchImpl: env.githubFetch,
  };
  return { c, ledger };
}

const TABLES = [
  "plan",
  "plan_body",
  "plan_decision",
  "plan_run",
  "plan_counter",
];
function snapshot(db) {
  return Object.fromEntries(
    TABLES.map((t) => [
      t,
      db.raw.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all(),
    ]),
  );
}
function wipe(db) {
  for (const t of TABLES) db.raw.exec(`DELETE FROM ${t}`);
}
const planFiles = (ledger, id) =>
  [...ledger.files.keys()].filter((p) => p.includes(`/${id}/`)).sort();

test("create writes one ledger event and projects draft v1 as #1", async () => {
  const { c, ledger } = planCtx();
  const v = await createPlan(c, "Proj", {
    title: " Auth rework ",
    body: "- [ ] step one",
    repo: "acme/app",
    branch: "main",
  });
  assert.match(v.meta.id, /^p[0-9a-f]{7}$/);
  assert.equal(v.meta.seq, 1);
  assert.equal(v.meta.state, "draft");
  assert.equal(v.meta.title, "Auth rework");
  assert.equal(v.body.markdown, "- [ ] step one");
  const files = planFiles(ledger, v.meta.id);
  assert.equal(files.length, 1);
  assert.match(files[0], new RegExp(`^plans/proj/${v.meta.id}/00001-`));
  const ev = parseEvent(ledger.files.get(files[0]));
  assert.equal(ev.op, "create");
  assert.equal(ev.author, "Ada");
  assert.equal(ev.body, "- [ ] step one");
  const two = await createPlan(c, "proj", { title: "Second", body: "x" });
  assert.equal(two.meta.seq, 2);
});

test("every body edit is a new version; old versions stay readable", async () => {
  const { c, ledger } = planCtx();
  const { meta } = await createPlan(c, "proj", { title: "T", body: "v1" });
  await editPlan(c, "proj", "#1", { body: "v2" });
  const v3 = await editPlan(c, "proj", meta.id, { body: "v3" });
  assert.equal(v3.meta.version, 3);
  const renamed = await editPlan(c, "proj", "1", { title: "T2" });
  assert.equal(renamed.meta.version, 3);
  assert.equal(renamed.meta.title, "T2");
  assert.equal(planFiles(ledger, meta.id).length, 4);
  assert.equal((await readPlan(c, "proj", "#1", 1)).body.markdown, "v1");
  assert.equal((await readPlan(c, "proj", "#1", 2)).body.markdown, "v2");
  assert.equal((await readPlan(c, "proj", "#1")).body.markdown, "v3");
  await assert.rejects(readPlan(c, "proj", "#1", 9), /no version 9/);
  await assert.rejects(editPlan(c, "proj", "#1", {}), /title or body/);
});

test("reads are scoped: unknown refs, other projects and other spaces are not found", async () => {
  const { c } = planCtx();
  await createPlan(c, "proj", { title: "T", body: "b" });
  await assert.rejects(readPlan(c, "proj", "#9"), PlanError);
  await assert.rejects(readPlan(c, "other", "#1"), /not found/);
  const otherSpace = { ...c, member: { ...MEMBER, space: "team-b" } };
  await assert.rejects(readPlan(otherSpace, "proj", "#1"), /not found/);
  assert.equal((await listProjectPlans(otherSpace, "proj")).length, 0);
  assert.equal((await listProjectPlans(c, "proj")).length, 1);
});

test("invalid input is rejected before anything is written", async () => {
  const { c, ledger } = planCtx();
  const bad = [
    { title: "  ", body: "b" },
    { title: "T", body: "" },
    { title: "x".repeat(201), body: "b" },
    { title: "T", body: "x".repeat(MAX_PLAN_BODY_CHARS + 1) },
    {
      title: "T",
      body: "b",
      inherits: Array.from(
        { length: MAX_LINKED_FACTS + 1 },
        (_, i) => `e#${i}`,
      ),
    },
  ];
  for (const a of bad)
    await assert.rejects(createPlan(c, "proj", a), PlanError);
  assert.equal(ledger.files.size, 0);
  assert.equal(
    (await createPlan(c, "proj", { title: "T", body: "b" })).meta.seq,
    1,
  );
});

test("inherits links known facts and reports unknown ids", async () => {
  const { c } = planCtx();
  await c.idx.upsertDocs([
    {
      id: "e1#aa",
      space: "team-a",
      project: "proj",
      kind: "decision",
      tier: "normal",
      body: "Use D1 because it is free",
      sourceFile: "context/proj/ada/x.md",
      sourceAuthor: "Ada",
      sourceTs: "2026-09-01T00:00:00Z",
      embedding: [],
      supersededBy: null,
      createdAt: "2026-09-01T00:00:00Z",
      sourceId: "e1",
      entities: [],
    },
  ]);
  const v = await createPlan(c, "proj", {
    title: "T",
    body: "b",
    inherits: ["e1#aa", "gone#zz"],
  });
  assert.deepEqual(v.unknownInherits, ["gone#zz"]);
  assert.equal(v.links.length, 1);
  assert.equal(v.links[0].role, "inherited");
  assert.equal(v.links[0].body, "Use D1 because it is free");
});

test("the index is rebuildable: wipe D1, rebuild from the ledger, identical rows", async () => {
  const { c } = planCtx();
  await createPlan(c, "proj", { title: "A", body: "a1" });
  await editPlan(c, "proj", "#1", { body: "a2" });
  await createPlan(c, "other", { title: "B", body: "b1" });
  await editPlan(c, "other", "#1", { title: "B2" });
  const before = snapshot(c.db);
  wipe(c.db);
  const r = await rebuildPlans(
    c.env,
    c.db,
    c.idx,
    c.embed,
    MEMBER,
    c.fetchImpl,
  );
  assert.deepEqual(r, { rebuilt: 2, total: 2, nextOffset: null });
  assert.deepEqual(snapshot(c.db), before);
  assert.equal(
    (await createPlan(c, "proj", { title: "C", body: "c" })).meta.seq,
    2,
  );
});

test("rebuildPlans pages through plans", async () => {
  const { c } = planCtx();
  for (const t of ["A", "B", "C"])
    await createPlan(c, "proj", { title: t, body: t });
  wipe(c.db);
  const p1 = await rebuildPlans(
    c.env,
    c.db,
    c.idx,
    c.embed,
    MEMBER,
    c.fetchImpl,
    { offset: 0, limit: 2 },
  );
  assert.deepEqual(p1, { rebuilt: 2, total: 3, nextOffset: 2 });
  const p2 = await rebuildPlans(
    c.env,
    c.db,
    c.idx,
    c.embed,
    MEMBER,
    c.fetchImpl,
    { offset: 2, limit: 2 },
  );
  assert.deepEqual(p2, { rebuilt: 1, total: 3, nextOffset: null });
  assert.equal((await listProjectPlans(c, "proj")).length, 3);
});

test("a concurrent edit: the loser rebuilds from the ledger and is told to retry", async () => {
  let raced = false;
  let ctx;
  const racer = [
    "/contents/plans/",
    async (url, init) => {
      if (init.method === "PUT" && url.includes("/00002-") && !raced) {
        raced = true;
        // Another writer lands rev 2 between our read and our projection.
        const prev = await pdb.getPlan(ctx.c.db, "team-a", "proj", "#1");
        const ev = {
          op: "edit",
          plan: prev.id,
          rev: 2,
          author: "Bo",
          ts: new Date().toISOString(),
          body: "theirs",
        };
        ctx.ledger.files.set(
          `plans/proj/${prev.id}/00002-0000-zzzz.md`,
          serializeEvent(ev),
        );
        await pdb.applyStep(ctx.c.db, "team-a", 1, step(prev, ev));
      }
      return ctx.ledger.routes[2][1](url, init);
    },
  ];
  ctx = planCtx([racer]);
  const { c, ledger } = ctx;
  const { meta } = await createPlan(c, "proj", { title: "T", body: "v1" });
  await assert.rejects(
    editPlan(c, "proj", "#1", { body: "mine" }),
    /changed concurrently/,
  );
  const files = planFiles(ledger, meta.id).map((path) => ({
    path,
    raw: ledger.files.get(path),
  }));
  const replay = foldEvents(files);
  assert.equal(replay.skipped.length, 1);
  assert.deepEqual(
    await pdb.getPlan(c.db, "team-a", "proj", "#1"),
    replay.meta,
  );
  assert.equal(
    (await readPlan(c, "proj", "#1")).body.markdown,
    replay.steps.at(-1).body.markdown,
  );
});

function oldFact(id, body) {
  return {
    id,
    space: "team-a",
    project: "proj",
    kind: "decision",
    tier: "normal",
    body,
    sourceFile: `context/proj/ada/${id}.md`,
    sourceAuthor: "Ada",
    sourceTs: "2026-09-01T00:00:00Z",
    embedding: [],
    supersededBy: null,
    createdAt: "2026-09-01T00:00:00Z",
    sourceId: id.split("#")[0],
    entities: [],
  };
}

async function toBuilding(c, ref = "#1") {
  await transitionPlan(c, "proj", ref, { to: "active" });
  return transitionPlan(c, "proj", ref, {
    to: "building",
    agent: "claude-code",
  });
}

test("ship: decisions become a writer-split entry, linked as produced, with no extraction", async () => {
  const { c, ledger } = planCtx();
  const calls = [];
  c.gen = async (prompt, opts) => {
    calls.push(opts?.purpose);
    throw new Error("no model in this test");
  };
  await c.idx.upsertDocs([oldFact("old1#aa", "Store plans in Notion")]);
  await createPlan(c, "proj", {
    title: "Plans in the ledger",
    body: "- [ ] move plans",
  });
  const b = await toBuilding(c);
  assert.equal(b.runs[0].agent, "claude-code");
  assert.equal(b.runs[0].ended, null);

  const v = await transitionPlan(c, "proj", "#1", {
    to: "shipped",
    commitSha: "abc123",
    decisions: [
      {
        kind: "decision",
        body: "Plans live in the git ledger because it is the source of truth",
      },
      {
        kind: "decision",
        body: "Plan bodies leave search when shipped because checklists go stale",
      },
    ],
    supersedes: ["old1#aa"],
  });
  assert.equal(v.meta.state, "shipped");
  assert.equal(v.warning, undefined);
  assert.match(v.entry.file, /^context\/proj\/ada\//);
  assert.match(ledger.files.get(v.entry.file), /facts: \[/);
  const produced = v.links.filter((l) => l.role === "produced");
  assert.equal(produced.length, 2);
  assert.deepEqual(
    produced.map((l) => l.factId).sort(),
    (await c.idx.idsBySource("team-a", v.entry.id)).sort(),
  );
  assert.ok(produced.every((l) => l.body && !l.supersededBy));
  assert.ok((await c.idx.getDoc("team-a", "old1#aa")).supersededBy);
  assert.equal(v.runs[0].outcome, "shipped");
  assert.equal(v.runs[0].commitSha, "abc123");
  assert.equal(calls.filter((p) => p === "extract").length, 0);
});

test("ship can link existing facts; shipping with none warns but succeeds", async () => {
  const { c } = planCtx();
  await c.idx.upsertDocs([
    oldFact("e5#bb", "Use D1 for plans because it is free"),
  ]);
  await createPlan(c, "proj", { title: "A", body: "a" });
  await toBuilding(c);
  const a = await transitionPlan(c, "proj", "#1", {
    to: "shipped",
    producedFactIds: ["e5#bb", "nope#1"],
  });
  assert.deepEqual(
    a.links.map((l) => [l.factId, l.role]),
    [["e5#bb", "produced"]],
  );
  assert.match(a.warning, /not linked.*nope#1/i);

  await createPlan(c, "proj", { title: "B", body: "b" });
  await toBuilding(c, "#2");
  const b = await transitionPlan(c, "proj", "#2", { to: "shipped" });
  assert.equal(b.meta.state, "shipped");
  assert.match(b.warning, /no decisions recorded/);
});

test("illegal transitions write nothing — not even the decisions entry", async () => {
  const { c, ledger } = planCtx();
  await createPlan(c, "proj", { title: "T", body: "b" });
  const before = ledger.files.size;
  await assert.rejects(
    transitionPlan(c, "proj", "#1", {
      to: "shipped",
      decisions: [{ body: "x because y" }],
    }),
    /illegal transition draft → shipped/,
  );
  await assert.rejects(
    transitionPlan(c, "proj", "#1", { to: "bogus" }),
    /to must be one of/,
  );
  await assert.rejects(
    transitionPlan(c, "proj", "#1", {
      to: "active",
      decisions: [{ body: "x" }],
    }),
    /only when shipping/,
  );
  assert.equal(ledger.files.size, before);
  assert.equal((await readPlan(c, "proj", "#1")).meta.state, "draft");
});

test("supersede: #2 replaces #1; audit row logged; #1's produced facts stay live", async () => {
  const { c } = planCtx();
  await createPlan(c, "proj", { title: "Old plan", body: "old" });
  await toBuilding(c);
  const shipped = await transitionPlan(c, "proj", "#1", {
    to: "shipped",
    decisions: [
      {
        kind: "decision",
        body: "Keep the gateway on the free tier because cost",
      },
    ],
  });
  const n2 = await createPlan(c, "proj", { title: "New plan", body: "new" });

  await assert.rejects(
    transitionPlan(c, "proj", "#1", { to: "superseded" }),
    /superseded_by/,
  );
  await assert.rejects(
    transitionPlan(c, "proj", "#1", { to: "superseded", supersededBy: "#9" }),
    /not found/,
  );
  await assert.rejects(
    transitionPlan(c, "proj", "#1", { to: "superseded", supersededBy: "#1" }),
    /itself/,
  );

  const v = await transitionPlan(c, "proj", "#1", {
    to: "superseded",
    supersededBy: "#2",
  });
  assert.equal(v.meta.state, "superseded");
  assert.equal(v.meta.supersededBy, n2.meta.id);
  const log = c.idx.supersessionLogged.at(-1);
  assert.equal(log.oldFactId, `plan:${shipped.meta.id}`);
  assert.equal(log.newFactId, `plan:${n2.meta.id}`);
  assert.equal(log.reason, "plan-supersedes");
  const produced = shipped.links.find((l) => l.role === "produced").factId;
  assert.equal((await c.idx.getDoc("team-a", produced)).supersededBy, null);

  await createPlan(c, "proj", { title: "Newer", body: "n" });
  await transitionPlan(c, "proj", "#2", {
    to: "superseded",
    supersededBy: "#3",
  });
  await assert.rejects(
    transitionPlan(c, "proj", "#3", { to: "superseded", supersededBy: "#2" }),
    /is itself superseded/,
  );
});

test("rebuild after the full lifecycle reproduces D1 exactly", async () => {
  const { c } = planCtx();
  await createPlan(c, "proj", { title: "A", body: "a" });
  await toBuilding(c);
  await transitionPlan(c, "proj", "#1", {
    to: "shipped",
    commitSha: "c0ffee",
    decisions: [
      {
        kind: "decision",
        body: "Replay is deterministic because paths sort by rev",
      },
    ],
  });
  await createPlan(c, "proj", { title: "B", body: "b" });
  await transitionPlan(c, "proj", "#2", { to: "active" });
  await transitionPlan(c, "proj", "#2", { to: "building" });
  await createPlan(c, "proj", { title: "C", body: "c" });
  await transitionPlan(c, "proj", "#2", {
    to: "superseded",
    supersededBy: "#3",
  });
  const before = snapshot(c.db);
  wipe(c.db);
  await rebuildPlans(c.env, c.db, c.idx, c.embed, MEMBER, c.fetchImpl);
  assert.deepEqual(snapshot(c.db), before);
  const runs = before.plan_run;
  assert.deepEqual(
    runs.map((r) => r.outcome).sort(),
    ["shipped", "superseded"],
  );
});
