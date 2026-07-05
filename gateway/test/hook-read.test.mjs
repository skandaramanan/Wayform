import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
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

async function setup(routes) {
  const calls = [];
  const env = makeEnv(ghFetch(calls, routes));
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

test("hook read returns injectable plain text with the session-start preamble", async () => {
  const { env, token } = await setup(ROUTES);
  const res = await handleRequest(get(token), env);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  const text = await res.text();
  assert.match(
    text,
    /^The following is shared planning memory \(MemoryLayer\) for project "roadmap"/,
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

test("a write_context invalidates the cache so the next read is fresh", async () => {
  const { env, token, calls } = await setup([
    ...ROUTES,
    ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
  ]);
  await handleRequest(get(token), env); // warm cache
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
  const before = calls.length;
  await handleRequest(get(token), env);
  assert.ok(calls.length > before, "post-write read must hit GitHub again");
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
