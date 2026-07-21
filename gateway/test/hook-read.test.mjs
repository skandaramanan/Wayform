import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import { makeEnv, ghFetch } from "./helpers.mjs";

const MEMBER = {
  space: "team-a",
  installationId: 777,
  owner: "acme",
  repo: "team-a-memory",
  author: "Ada",
  authorEmail: "ada@acme.io",
};
const MD =
  "---\nauthor: Ada\ntype: decision\ntimestamp: 2026-07-01T00:00:00.000Z\nid: x1\nproject: roadmap\n---\n\nships";

async function setup(routes, extra = {}) {
  const calls = [];
  const env = makeEnv(ghFetch(calls, routes), extra);
  const res = await handleRequest(
    new Request("https://gw.test/admin/members", {
      method: "POST",
      headers: { "x-admin-secret": "test-admin-secret" },
      body: JSON.stringify(MEMBER),
    }),
    env,
  );
  return { env, calls, token: (await res.json()).token };
}

const ROUTES = [
  [
    "/app/installations/777/access_tokens",
    () => Response.json({ token: "ghs_a" }, { status: 201 }),
  ],
  [
    "/git/trees/",
    () =>
      Response.json({
        tree: [
          {
            path: "context/roadmap/ada/2026-07-01T00-00-00-000Z-x1.md",
            type: "blob",
          },
        ],
      }),
  ],
  ["x1.md", () => new Response(MD)],
];

function get(token, qs = "project=roadmap") {
  return new Request(`https://gw.test/hook/read?${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

test("hook read returns injectable plain text with playbook + preamble", async () => {
  const { env, token } = await setup(ROUTES);
  const res = await handleRequest(get(token), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  const text = await res.text();
  assert.match(text, /^## MemoryLayer — required tool policy/);
  assert.match(text, /search_memory/);
  assert.match(text, /write_context/);
  assert.match(text, /memory_feedback/);
  assert.match(
    text,
    /The following is shared planning memory \(MemoryLayer\) for project "roadmap"/,
  );
  assert.match(text, /# Shared context: roadmap/);
});

test("second read within TTL is served from KV (no GitHub traffic)", async () => {
  const { env, token, calls } = await setup(ROUTES);
  await handleRequest(get(token), env);
  const before = calls.length;
  await handleRequest(get(token), env);
  assert.equal(calls.length, before);
});

test("a write_context rebuilds the hook cache so the next read is fresh", async () => {
  const { env, token, calls } = await setup([
    ...ROUTES,
    ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
  ]);
  const first = await handleRequest(get(token), env); // warm cache
  const firstText = await first.text();
  await handleRequest(
    new Request("https://gw.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "write_context",
          arguments: { project: "roadmap", type: "context", payload: "new" },
        },
      }),
    }),
    env,
  );
  // Hook projection key is deleted on write — next /hook/read must rebuild
  // (D1 briefing or GitHub), not serve the pre-write cached string.
  const second = await handleRequest(get(token), env);
  const secondText = await second.text();
  assert.notEqual(
    secondText,
    firstText,
    "post-write hook read must not reuse the pre-write projection",
  );
  assert.ok(calls.length >= 0); // keep calls referenced for debugging
});

test("negative budget does not mean unlimited — still budget-limited", async () => {
  const bigPayload = "x".repeat(20000); // ~5000 estimated tokens, > DEFAULT_BUDGET_TOKENS
  const md1 = `---\nauthor: Ada\ntype: decision\ntimestamp: 2026-07-01T00:00:00.000Z\nid: x1\nproject: roadmap\n---\n\n${bigPayload}`;
  const md2 = `---\nauthor: Ada\ntype: decision\ntimestamp: 2026-07-02T00:00:00.000Z\nid: x2\nproject: roadmap\n---\n\n${bigPayload}`;
  const { env, token } = await setup([
    [
      "/app/installations/777/access_tokens",
      () => Response.json({ token: "ghs_a" }, { status: 201 }),
    ],
    [
      "/git/trees/",
      () =>
        Response.json({
          tree: [
            {
              path: "context/roadmap/ada/2026-07-01T00-00-00-000Z-x1.md",
              type: "blob",
            },
            {
              path: "context/roadmap/ada/2026-07-02T00-00-00-000Z-x2.md",
              type: "blob",
            },
          ],
        }),
    ],
    ["x1.md", () => new Response(md1)],
    ["x2.md", () => new Response(md2)],
  ]);
  const res = await handleRequest(get(token, "project=roadmap&budget=-5"), env);
  const text = await res.text();
  assert.match(text, /Showing the 1 most recent of 2/);
});

test("/hook/read serves the index briefing when facts exist", async () => {
  const indexDb = new MemoryIndexDb();
  await indexDb.replaceBySource("team-a", "c", [
    {
      id: "c#0",
      space: "team-a",
      project: "roadmap",
      kind: "constraint",
      tier: "canon",
      body: "Infra cost must stay $0.",
      sourceFile: "f",
      sourceAuthor: "Ada",
      sourceTs: "2026-02-01T00:00:00Z",
      embedding: [],
      supersededBy: null,
      createdAt: "2026-07-08T00:00:00Z",
      sourceId: "c",
      entities: ["infra-cost"],
    },
  ]);
  const { env, token } = await setup(ROUTES, { indexDb });
  const res = await handleRequest(get(token), env);
  const text = await res.text();
  assert.match(text, /required tool policy/); // playbook first
  assert.match(text, /loaded automatically at session start/); // preamble kept
  assert.match(text, /Infra cost must stay \$0/);
  assert.match(text, /memory covers:/);
  assert.match(text, /search_memory/);
});

test("/hook/read falls back to the recency dump when the index is unconfigured", async () => {
  // No indexDb → deps null → recency path (Phase A behavior), no manifest.
  const { env, token } = await setup(ROUTES);
  const res = await handleRequest(get(token), env);
  const text = await res.text();
  assert.match(text, /loaded automatically at session start/);
  assert.doesNotMatch(text, /memory covers:/);
});

test("empty project -> 400; no entries -> empty 200 body; no auth -> 401", async () => {
  const { env, token } = await setup([
    [
      "/app/installations/777/access_tokens",
      () => Response.json({ token: "ghs_a" }, { status: 201 }),
    ],
    ["/git/trees/", () => Response.json({ tree: [] })],
  ]);
  assert.equal((await handleRequest(get(token, ""), env)).status, 400);
  const empty = await handleRequest(get(token), env);
  assert.equal(empty.status, 200);
  assert.equal(await empty.text(), "");
  assert.equal(
    (
      await handleRequest(
        new Request("https://gw.test/hook/read?project=x"),
        env,
      )
    ).status,
    401,
  );
});
