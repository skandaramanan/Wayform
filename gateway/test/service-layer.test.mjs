// Phase 0.3 exit: MCP and plain HTTP are two transports over ONE service
// layer (memory.ts). Same input → same text, whichever door it came through.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import { recencyCacheKey } from "../dist/gateway/src/github-store.js";
import {
  makeEnv,
  ghFetch,
  fakeEmbed,
  fakeLedger,
  seedGithubMember,
} from "./helpers.mjs";
import { sqliteD1 } from "./sqlite-d1.mjs";

const M = {
  space: "s1",
  installationId: 7,
  owner: "o",
  repo: "r",
  branch: "main",
  author: "Ada",
  authorEmail: "ada@x.io",
  githubId: 101,
  githubLogin: "ada",
  role: "member",
};

async function setup(extra = {}) {
  const ledger = fakeLedger({ repo: "o/r" });
  const env = makeEnv(ghFetch([], ledger.routes), {
    embedder: fakeEmbed,
    ...extra,
  });
  await seedGithubMember(env, M);
  env.oauthProps = { githubId: M.githubId, githubLogin: M.githubLogin };
  const mcp = async (name, args) => {
    const res = await handleRequest(
      new Request("https://gw/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      }),
      env,
    );
    return (await res.json()).result.content[0].text;
  };
  const http = async (qs) =>
    (
      await handleRequest(new Request(`https://gw/mcp/api/read?${qs}`), env)
    ).json();
  return { env, ledger, mcp, http };
}

test("read_context over MCP and /mcp/api/read over HTTP return identical text", async () => {
  const idx = new MemoryIndexDb();
  const { mcp, http } = await setup({ indexDb: idx });
  await mcp("write_context", {
    project: "proj",
    payload: "We host plans in the ledger because it is the source of truth.",
    facts: [
      {
        kind: "decision",
        body: "Plans live in the git ledger because it is the source of truth",
      },
    ],
  });
  const query = "plans git ledger";
  const viaMcp = await mcp("read_context", { project: "proj", query });
  const viaHttp = await http(`project=proj&query=${encodeURIComponent(query)}`);
  assert.match(viaMcp, /Plans live in the git ledger/);
  assert.equal(viaHttp.text, viaMcp);

  const recentMcp = await mcp("read_context", { project: "proj" });
  const recentHttp = await http("project=proj");
  assert.match(recentMcp, /source of truth/);
  assert.equal(recentHttp.text, recentMcp);
});

test("shipping a plan warms the recency cache with its decisions entry (service, not transport)", async () => {
  const { env, mcp } = await setup({ DB: sqliteD1() });
  await mcp("create_plan", { project: "proj", title: "T", body: "b" });
  for (const to of ["active", "building"])
    await mcp("transition_plan", { project: "proj", plan: "#1", to });
  const out = await mcp("transition_plan", {
    project: "proj",
    plan: "#1",
    to: "shipped",
    decisions: [
      {
        kind: "decision",
        body: "Warm caches in the service because every transport needs it",
      },
    ],
  });
  assert.match(out, /is now shipped/);
  const line = JSON.parse(await env.ROUTING.get(recencyCacheKey("s1", "proj")));
  assert.ok(
    line.entries.some((e) => /Warm caches in the service/.test(e.payload)),
  );
});

test("membership changes are enforced by the service: a non-admin is refused", async () => {
  const { mcp } = await setup();
  assert.match(
    await mcp("invite_member", { github_username: "eve" }),
    /only a space admin/,
  );
});
