// Plan mirror: an admin-set per-project toggle exposed as GET /mcp/api/plans
// and the set_plan_mirror MCP tool. Plans only; memories never flow through
// here. Space-scoped like every other plan surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import {
  makeEnv,
  ghFetch,
  fakeEmbed,
  fakeLedger,
  seedGithubMember,
} from "./helpers.mjs";
import { sqliteD1 } from "./sqlite-d1.mjs";

const A = {
  space: "team-a",
  installationId: 777,
  owner: "acme",
  repo: "team-a-memory",
  author: "Ada",
  authorEmail: "ada@acme.io",
  githubId: 101,
  githubLogin: "ada",
  role: "admin",
};
const M = {
  space: "team-a",
  installationId: 777,
  owner: "acme",
  repo: "team-a-memory",
  author: "Max",
  authorEmail: "max@acme.io",
  githubId: 103,
  githubLogin: "max",
  role: "member",
};
const B = {
  space: "team-b",
  installationId: 888,
  owner: "acme",
  repo: "team-b-memory",
  author: "Bo",
  authorEmail: "bo@acme.io",
  githubId: 102,
  githubLogin: "bo",
  role: "member",
};

async function setup() {
  const la = fakeLedger({ repo: "acme/team-a-memory" });
  const lb = fakeLedger({ repo: "acme/team-b-memory" });
  const env = makeEnv(ghFetch([], [...la.routes, ...lb.routes]), {
    DB: sqliteD1(),
    embedder: fakeEmbed,
  });
  for (const m of [A, M, B]) await seedGithubMember(env, m);
  let id = 0;
  const call = async (who, name, args) => {
    env.oauthProps = { githubId: who.githubId, githubLogin: who.githubLogin };
    const res = await handleRequest(
      new Request("https://gw.test/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      env,
    );
    const r = (await res.json()).result;
    return { text: r.content[0].text, isError: r.isError === true };
  };
  return { env, call, la, lb };
}

const getPlans = (env, who, qs) => {
  env.oauthProps = { githubId: who.githubId, githubLogin: who.githubLogin };
  return handleRequest(new Request(`https://gw.test/mcp/api/plans?${qs}`), env);
};

test("mirror is off by default and returns no plans", async () => {
  const { env, call } = await setup();
  await call(A, "create_plan", { project: "P", title: "One", body: "- [ ] a" });
  const body = await (await getPlans(env, A, "project=P")).json();
  assert.deepEqual(body, { enabled: false, plans: [] });
});

test("only a space admin can flip the toggle", async () => {
  const { call } = await setup();
  const r = await call(M, "set_plan_mirror", { project: "P", enabled: true });
  assert.equal(r.isError, true);
  assert.match(r.text, /space admin/);
});

test("enabled: in-flight plans come back rendered; shipped ones do not", async () => {
  const { env, call } = await setup();
  await call(A, "create_plan", {
    project: "P",
    title: "Live plan",
    body: "- [ ] a",
  });
  await call(A, "create_plan", {
    project: "P",
    title: "Done",
    body: "- [x] b",
  });
  await call(A, "transition_plan", { project: "P", plan: "2", to: "active" });
  await call(A, "transition_plan", {
    project: "P",
    plan: "2",
    to: "building",
    agent: "claude-code",
  });
  const shipped = await call(A, "transition_plan", {
    project: "P",
    plan: "2",
    to: "shipped",
    commit_sha: "abc",
    decisions: [{ kind: "decision", body: "Done is done because tests pass" }],
  });
  assert.equal(shipped.isError, false, shipped.text);
  const on = await call(A, "set_plan_mirror", { project: "P", enabled: true });
  assert.equal(on.isError, false, on.text);
  const body = await (await getPlans(env, M, "project=P")).json();
  assert.equal(body.enabled, true);
  assert.deepEqual(
    body.plans.map((p) => p.file),
    ["1-live-plan.md"],
  );
  assert.match(body.plans[0].markdown, /^# Plan #1 — Live plan/);
  assert.match(body.plans[0].markdown, /- \[ \] a/);
});

test("toggle and plans are space-scoped", async () => {
  const { env, call } = await setup();
  await call(A, "set_plan_mirror", { project: "P", enabled: true });
  const body = await (await getPlans(env, B, "project=P")).json();
  assert.equal(body.enabled, false);
});

test("turning it off again returns enabled:false", async () => {
  const { env, call } = await setup();
  await call(A, "set_plan_mirror", { project: "P", enabled: true });
  await call(A, "set_plan_mirror", { project: "P", enabled: false });
  const body = await (await getPlans(env, A, "project=P")).json();
  assert.deepEqual(body, { enabled: false, plans: [] });
});

test("mirrorPlans costs about one D1 query per plan, not one per readPlan", async () => {
  const { env, call } = await setup();
  for (let i = 0; i < 5; i++) {
    await call(A, "create_plan", {
      project: "P",
      title: `Plan ${i}`,
      body: "- [ ] x",
    });
  }
  await call(A, "set_plan_mirror", { project: "P", enabled: true });
  let queries = 0;
  const rawPrepare = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    queries++;
    return rawPrepare(sql);
  };
  const body = await (await getPlans(env, A, "project=P")).json();
  assert.equal(body.plans.length, 5);
  // listProjectPlans (1) + getBody per plan (5) — readPlan's ~3+ queries/plan
  // would blow past 50 queries/invocation around 10 plans on Workers Free.
  assert.ok(queries <= 8, `expected ~1 query/plan, got ${queries} for 5 plans`);
});

test("set_plan_mirror rejects a non-boolean enabled instead of treating it as false", async () => {
  const { call } = await setup();
  const r = await call(A, "set_plan_mirror", {
    project: "P",
    enabled: "true",
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /enabled must be true or false/);
});

test("401 without a member, 400 without a project", async () => {
  const { env } = await setup();
  env.oauthProps = undefined;
  assert.equal(
    (
      await handleRequest(
        new Request("https://gw.test/mcp/api/plans?project=P"),
        env,
      )
    ).status,
    401,
  );
  assert.equal((await getPlans(env, A, "")).status, 400);
});
