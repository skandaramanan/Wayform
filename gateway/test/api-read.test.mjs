import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import { handleRequest } from "../dist/gateway/src/router.js";
import { makeEnv, ghFetch, fakeEmbed, seedGithubMember } from "./helpers.mjs";

const MEMBER = {
  space: "s1",
  installationId: 7,
  owner: "o",
  repo: "r",
  branch: "main",
  author: "Skanda",
  authorEmail: "s@x.com",
  githubId: 101,
  githubLogin: "skanda",
  role: "admin",
};

async function authedEnv(indexDb, ghRoutes = []) {
  const env = makeEnv(ghFetch([], ghRoutes), { indexDb, embedder: fakeEmbed });
  await seedGithubMember(env, MEMBER);
  env.oauthProps = {
    githubId: MEMBER.githubId,
    githubLogin: MEMBER.githubLogin,
  };
  return env;
}

const get = (env, qs) =>
  handleRequest(new Request(`https://gw/mcp/api/read?${qs}`), env);

test("query path returns ranked JSON and logs with the api_read trigger", async () => {
  const db = new MemoryIndexDb();
  const [vec] = await fakeEmbed(["Cursor MCP config is project-scoped."]);
  await db.upsertDocs([
    {
      id: "cursor-fact",
      space: "s1",
      project: "memorylayer",
      kind: "decision",
      tier: "normal",
      body: "Cursor MCP config is project-scoped.",
      sourceFile: "context/memorylayer/skanda/a.md",
      sourceAuthor: "Skanda",
      sourceTs: "2026-06-01T00:00:00Z",
      embedding: vec,
      supersededBy: null,
      createdAt: "2026-07-08T00:00:00Z",
    },
  ]);
  const env = await authedEnv(db);
  const res = await get(env, "project=memorylayer&query=cursor%20mcp%20config");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.match(body.text, /project-scoped/);
  assert.equal(body.total, 1);
  assert.equal(body.matched, 1);
  assert.equal(db.logged[0].trigger, "api_read");
});

test("no query falls back to the recency read", async () => {
  const env = await authedEnv(new MemoryIndexDb(), [
    [
      "/app/installations/",
      () =>
        Response.json({
          token: "ghs_test",
          expires_at: "2099-01-01T00:00:00Z",
        }),
    ],
    ["/git/trees/main", () => Response.json({ tree: [] })],
  ]);
  const res = await get(env, "project=memorylayer");
  const body = await res.json();
  assert.equal(body.total, 0);
  assert.match(body.text, /# Shared context: memorylayer/);
});

test("401 without a token; 400 without a project", async () => {
  const env = await authedEnv(new MemoryIndexDb());
  const saved = env.oauthProps;
  delete env.oauthProps;
  const noAuth = await handleRequest(
    new Request("https://gw/mcp/api/read?project=x"),
    env,
  );
  assert.equal(noAuth.status, 401);
  env.oauthProps = saved;
  assert.equal((await get(env, "query=x")).status, 400);
});
