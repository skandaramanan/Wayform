// The split-on-shipped rule (docs/PLAN.md Phase 1: "the single most important
// rule in the system"): shipped plans leave their decisions in retrieval and
// take their checklists out of it. Plan tables AND the docs index both run on
// real SQLite through the production D1 code — no in-memory fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlan, transitionPlan } from "../dist/gateway/src/plans.js";
import { d1IndexDb } from "../dist/gateway/src/index-db.js";
import {
  retrieve,
  renderSearchResults,
} from "../dist/gateway/src/retrieval.js";
import { sqliteD1 } from "./sqlite-d1.mjs";
import { makeEnv, ghFetch, fakeEmbed, fakeLedger } from "./helpers.mjs";

const N = 500;
const SPACE = "team-a";
const MEMBER = {
  space: SPACE,
  installationId: 777,
  owner: "acme",
  repo: "team-a-memory",
  branch: "main",
  author: "Ada",
  authorEmail: "ada@acme.io",
};

test(`plan #${N + 1} does not retrieve ${N} stale checklists`, async () => {
  const ledger = fakeLedger();
  const env = makeEnv(ghFetch([], ledger.routes));
  const db = sqliteD1();
  const idx = d1IndexDb(db);
  const c = {
    env,
    member: MEMBER,
    db,
    idx,
    embed: fakeEmbed,
    gen: null,
    fetchImpl: env.githubFetch,
  };
  const search = async (query) =>
    (
      await retrieve(
        { db: idx, embed: fakeEmbed },
        {
          space: SPACE,
          project: "proj",
          query,
          budgetTokens: 4000,
          trigger: "test",
        },
      )
    ).results;

  for (let i = 1; i <= N; i++) {
    const p = await createPlan(c, "proj", {
      title: `Plan ${i}`,
      body: `- [ ] zebrafrost step ${i}\n- [ ] migrate table ${i}`,
    });
    for (const to of ["active", "building"])
      await transitionPlan(c, "proj", p.meta.id, { to });
    await transitionPlan(c, "proj", p.meta.id, {
      to: "shipped",
      ...(i % 50 === 0
        ? {
            decisions: [
              {
                kind: "decision",
                body: `zebrafrost decision ${i} because reason ${i}`,
              },
            ],
          }
        : {}),
    });
  }

  const live = await idx.listDocs(SPACE, "proj");
  assert.equal(
    live.filter((d) => d.kind === "plan").length,
    0,
    "no retired checklist is indexed",
  );
  assert.equal(live.length, N / 50, "only the produced decisions remain");

  const results = await search("zebrafrost step");
  assert.ok(results.length > 0);
  assert.equal(results.filter((r) => r.doc.kind === "plan").length, 0);
  assert.ok(
    results.every((r) => /^zebrafrost decision \d+ because/.test(r.doc.body)),
  );

  const next = await createPlan(c, "proj", {
    title: `Plan ${N + 1}`,
    body: `- [ ] zebrafrost step ${N + 1}`,
  });
  const again = await search("zebrafrost step");
  assert.deepEqual(
    again.filter((r) => r.doc.kind === "plan").map((r) => r.doc.id),
    [`plan:${next.meta.id}`],
    "only the plan in flight is found",
  );
  // Decisions outrank a checklist on a shared query (kind priors); on its own
  // words the in-flight plan renders as a plan.
  const own = await search(`zebrafrost step ${N + 1}`);
  assert.match(
    renderSearchResults("proj", "q", own, own.length),
    new RegExp(`\\[plan\\] Plan #${N + 1} \\[draft\\] Plan ${N + 1}`),
  );
});
