import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPromptInjection } from "../dist/gateway/src/hook-prompt.js";

function doc(id, body) {
  return {
    id,
    space: "s1",
    project: "memorylayer",
    kind: "decision",
    tier: "normal",
    body,
    sourceFile: `context/memorylayer/skanda/${id}.md`,
    sourceAuthor: "Skanda",
    sourceTs: "2026-07-04T11:00:00Z",
    embedding: [],
    supersededBy: null,
    createdAt: "2026-07-08T00:00:00Z",
    sourceId: id,
    entities: [],
  };
}

test("renderPromptInjection is silent on empty results", () => {
  assert.equal(renderPromptInjection("memorylayer", []), "");
});

test("renderPromptInjection frames hits as data, not a search", () => {
  const text = renderPromptInjection("memorylayer", [
    {
      doc: doc("cursor-fact", "Cursor MCP config is project-scoped."),
      score: 0.05,
    },
  ]);
  assert.match(text, /already-known context/);
  assert.match(text, /Cursor MCP config is project-scoped/);
  assert.doesNotMatch(text, /# Memory search/); // NOT the search framing
});

import { handleRequest } from "../dist/gateway/src/router.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import { makeEnv, ghFetch, fakeEmbed, seedGithubMember } from "./helpers.mjs";

const MEMBER = {
  space: "team-a",
  installationId: 777,
  owner: "acme",
  repo: "team-a-memory",
  branch: "main",
  author: "Ada",
  authorEmail: "ada@acme.io",
  githubId: 101,
  githubLogin: "ada",
  role: "admin",
};

async function setup(extra = {}) {
  const calls = [];
  const env = makeEnv(ghFetch(calls, []), extra);
  await seedGithubMember(env, MEMBER);
  env.oauthProps = { githubId: MEMBER.githubId, githubLogin: MEMBER.githubLogin };
  return { env };
}

function post(body) {
  return new Request("https://gw.test/hook/prompt", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function seed(db, docs) {
  const vecs = await fakeEmbed(docs.map((d) => d.body));
  await db.upsertDocs(docs.map((d, i) => ({ ...d, embedding: vecs[i] })));
}

test("hook prompt returns the on-topic fact for a matching prompt (Cursor regression)", async () => {
  const db = new MemoryIndexDb();
  await seed(db, [
    {
      ...doc(
        "cursor-fact",
        "Cursor MCP config is project-scoped, not global — verified 2026-07-04.",
      ),
      space: "team-a",
    },
    ...Array.from({ length: 20 }, (_, i) => ({
      ...doc(`f${i}`, `gateway auth hardening step ${i}`),
      space: "team-a",
      sourceTs: "2026-07-07T00:00:00Z",
    })),
  ]);
  const { env } = await setup({ indexDb: db, embedder: fakeEmbed });
  const res = await handleRequest(
    post({
      project: "memorylayer",
      prompt: "how is cursor mcp config scoped?",
    }),
    env,
  );
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Cursor MCP config is project-scoped/);
});

test("hook prompt is silent (empty 200) when nothing clears tau", async () => {
  const db = new MemoryIndexDb();
  await seed(db, [
    { ...doc("d1", "we chose D1 for the index plane"), space: "team-a" },
  ]);
  const { env } = await setup({ indexDb: db, embedder: null });
  const res = await handleRequest(
    post({ project: "memorylayer", prompt: "zzqx unrelated nonsense" }),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
});

test("hook prompt fails open to empty 200 when retrieval throws", async () => {
  const boomDb = new MemoryIndexDb();
  boomDb.listDocs = async () => {
    throw new Error("db down");
  };
  const { env } = await setup({ indexDb: boomDb, embedder: fakeEmbed });
  const res = await handleRequest(
    post({ project: "memorylayer", prompt: "anything at all" }),
    env,
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
});

test("hook prompt rejects an unauthenticated request", async () => {
  const { env } = await setup({ indexDb: new MemoryIndexDb() });
  delete env.oauthProps;
  const res = await handleRequest(
    new Request("https://gw.test/hook/prompt", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "memorylayer", prompt: "x" }),
    }),
    env,
  );
  assert.equal(res.status, 401);
});
