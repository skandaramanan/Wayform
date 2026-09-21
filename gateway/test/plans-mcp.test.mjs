// The plan tools end to end through the router: auth, space scoping, the
// ledger commit and the D1 projection, as a client would call them.
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
  for (const m of [A, B]) await seedGithubMember(env, m);
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

test("tools/list advertises the plan tools with required args", async () => {
  const { env } = await setup();
  env.oauthProps = { githubId: 101, githubLogin: "ada" };
  const res = await handleRequest(
    new Request("https://gw.test/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
    env,
  );
  const tools = (await res.json()).result.tools;
  const req = Object.fromEntries(
    tools.map((t) => [t.name, t.inputSchema.required]),
  );
  assert.deepEqual(req.create_plan, ["project", "title", "body"]);
  assert.deepEqual(req.read_plan, ["project"]);
  assert.deepEqual(req.edit_plan, ["project", "plan"]);
});

test("create → list → edit → read versions, over MCP", async () => {
  const { call, la } = await setup();
  const created = await call(A, "create_plan", {
    project: "MemoryLayer",
    title: "Plan object",
    body: "- [ ] schema",
    repo: "acme/app",
  });
  assert.equal(created.isError, false, created.text);
  assert.match(
    created.text,
    /Created plan #1 "Plan object" \(id p[0-9a-f]{7}, draft, v1\)\./,
  );
  assert.equal(
    [...la.files.keys()].filter((p) => p.startsWith("plans/memorylayer/"))
      .length,
    1,
  );

  const list = await call(A, "read_plan", { project: "MemoryLayer" });
  assert.match(list.text, /- #1 \[draft\] Plan object — v1/);

  const edited = await call(A, "edit_plan", {
    project: "MemoryLayer",
    plan: "#1",
    body: "- [x] schema",
  });
  assert.match(edited.text, /is now v2/);

  const latest = await call(A, "read_plan", {
    project: "MemoryLayer",
    plan: "1",
  });
  assert.match(latest.text, /^# Plan #1 — Plan object/);
  assert.match(latest.text, /state: draft · v2 of 2 · acme\/app · by Ada/);
  assert.match(latest.text, /- \[x\] schema$/);
  const v1 = await call(A, "read_plan", {
    project: "MemoryLayer",
    plan: "#1",
    version: 1,
  });
  assert.match(v1.text, /v1 of 2 \(older version\)/);
  assert.match(v1.text, /- \[ \] schema$/);
});

test("plan errors come back as tool errors, not crashes", async () => {
  const { call } = await setup();
  assert.match(
    (await call(A, "read_plan", { plan: "#1" })).text,
    /missing required argument: project/,
  );
  const missing = await call(A, "read_plan", { project: "p", plan: "#4" });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /not found/);
  const bad = await call(A, "create_plan", {
    project: "p",
    title: "",
    body: "b",
  });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /title/);
  assert.match(
    (await call(A, "edit_plan", { project: "p" })).text,
    /missing required argument: plan/,
  );
});

test("a plan in one space is invisible to another space", async () => {
  const { call, lb } = await setup();
  await call(A, "create_plan", {
    project: "shared",
    title: "A's plan",
    body: "secret",
  });
  const read = await call(B, "read_plan", { project: "shared", plan: "#1" });
  assert.equal(read.isError, true);
  assert.match(
    (await call(B, "read_plan", { project: "shared" })).text,
    /No plans/,
  );
  const edit = await call(B, "edit_plan", {
    project: "shared",
    plan: "#1",
    body: "pwned",
  });
  assert.equal(edit.isError, true);
  assert.equal(lb.files.size, 0);
  // B's own numbering starts at #1 in B's space.
  assert.match(
    (await call(B, "create_plan", { project: "shared", title: "B", body: "b" }))
      .text,
    /#1/,
  );
});

test("admin {plans:true} rebuilds from the ledger and is operator-only", async () => {
  const { env, call } = await setup();
  await call(A, "create_plan", { project: "p", title: "T", body: "b" });
  await call(A, "edit_plan", { project: "p", plan: "#1", body: "b2" });
  const before = env.DB.raw
    .prepare("SELECT * FROM plan_body ORDER BY version")
    .all();
  env.DB.raw.exec("DELETE FROM plan; DELETE FROM plan_body;");
  const admin = (props) => {
    env.oauthProps = props;
    return handleRequest(
      new Request("https://gw.test/mcp/admin/reindex", {
        method: "POST",
        body: JSON.stringify({ plans: true, repo: "acme/team-a-memory" }),
      }),
      env,
    );
  };
  assert.equal(
    (await admin({ githubId: 101, githubLogin: "ada" })).status,
    403,
  );
  const res = await admin({ githubId: 4242, githubLogin: "operator" });
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).plans, {
    "team-a": { rebuilt: 1, total: 1, nextOffset: null },
  });
  assert.deepEqual(
    env.DB.raw.prepare("SELECT * FROM plan_body ORDER BY version").all(),
    before,
  );
});

test("transition_plan walks the lifecycle and ships decisions into search", async () => {
  const { call, la } = await setup();
  await call(A, "create_plan", {
    project: "p",
    title: "Ledger plans",
    body: "- [ ] do it",
  });
  assert.match(
    (
      await call(A, "transition_plan", {
        project: "p",
        plan: "#1",
        to: "active",
      })
    ).text,
    /is now active/,
  );
  await call(A, "transition_plan", {
    project: "p",
    plan: "#1",
    to: "building",
    agent: "claude-code",
  });
  const shipped = await call(A, "transition_plan", {
    project: "p",
    plan: "#1",
    to: "shipped",
    commit_sha: "abc",
    decisions: [
      {
        kind: "decision",
        body: "Plans are event logs in the ledger because append-only avoids races",
      },
    ],
  });
  assert.equal(shipped.isError, false, shipped.text);
  assert.match(
    shipped.text,
    /is now shipped\. Produced decisions: [0-9a-f]{8}#\w+\./,
  );
  assert.ok([...la.files.keys()].some((f) => f.startsWith("context/p/ada/")));
  const search = await call(A, "search_memory", {
    project: "p",
    query: "append-only ledger races",
  });
  assert.match(search.text, /event logs in the ledger/);
  const read = await call(A, "read_plan", { project: "p", plan: "#1" });
  assert.match(read.text, /state: shipped/);
  assert.match(read.text, /- \[produced\] Plans are event logs/);
  assert.match(read.text, /run 1 · claude-code · .* · shipped · abc/);
  const again = await call(A, "transition_plan", {
    project: "p",
    plan: "#1",
    to: "active",
  });
  assert.equal(again.isError, true);
  assert.match(again.text, /illegal transition shipped → active/);
});

test("transition_plan supersedes with superseded_by and requires `to`", async () => {
  const { call } = await setup();
  await call(A, "create_plan", { project: "p", title: "One", body: "1" });
  await call(A, "create_plan", { project: "p", title: "Two", body: "2" });
  const r = await call(A, "transition_plan", {
    project: "p",
    plan: "#1",
    to: "superseded",
    superseded_by: "#2",
  });
  assert.match(r.text, /is now superseded/);
  const list = await call(A, "read_plan", { project: "p" });
  assert.match(list.text, /#1 \[superseded\] One/);
  assert.equal(
    (await call(A, "transition_plan", { project: "p", plan: "#2" })).isError,
    true,
  );
});

test("plan_brief returns the team's decisions and the skeleton", async () => {
  const { call } = await setup();
  const fact =
    "We rate limit writes at 60/min because D1 row writes are the cost driver.";
  await call(A, "write_context", {
    project: "apollo",
    payload: "Rate limiting, settled.",
    facts: [{ kind: "decision", body: fact }],
  });
  const out = await call(A, "plan_brief", {
    project: "apollo",
    prompt: "add a rate limiter to the gateway",
  });
  assert.equal(out.isError, false, out.text);
  assert.match(out.text, /# Plan brief: apollo/);
  assert.match(out.text, /rate limit writes at 60\/min/);
  assert.match(out.text, /create_plan/);
  assert.match(out.text, /## Goal/);
});

test("plan_brief surfaces an in-flight plan as prior art", async () => {
  const { call } = await setup();
  await call(A, "create_plan", {
    project: "apollo",
    title: "Rate limiting the write path",
    body: "- [ ] token bucket in KV",
  });
  const out = await call(A, "plan_brief", {
    project: "apollo",
    prompt: "rate limiting the write path",
  });
  assert.match(out.text, /Related plans/);
  assert.match(out.text, /Rate limiting the write path/);
});

test("plan_brief is scoped to the caller's space", async () => {
  const { call } = await setup();
  await call(A, "write_context", {
    project: "apollo",
    payload: "Rate limiting, settled.",
    facts: [
      {
        kind: "decision",
        body: "We rate limit writes at 60/min because D1 row writes are the cost driver.",
      },
    ],
  });
  const out = await call(B, "plan_brief", {
    project: "apollo",
    prompt: "add a rate limiter to the gateway",
  });
  assert.doesNotMatch(out.text, /60\/min/);
});

test("plan_brief requires a prompt", async () => {
  const { call } = await setup();
  const out = await call(A, "plan_brief", { project: "apollo" });
  assert.equal(out.isError, true);
  assert.match(out.text, /missing required argument: prompt/);
});
