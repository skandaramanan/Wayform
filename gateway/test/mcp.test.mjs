import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import { makeEnv, ghFetch } from "./helpers.mjs";

const MEMBER_A = {
  space: "team-a",
  installationId: 777,
  owner: "acme",
  repo: "team-a-memory",
  author: "Ada",
  authorEmail: "ada@acme.io",
};
const MEMBER_B = {
  space: "team-b",
  installationId: 888,
  owner: "acme",
  repo: "team-b-memory",
  author: "Bo",
  authorEmail: "bo@acme.io",
};

async function setup(routes) {
  const calls = [];
  const env = makeEnv(ghFetch(calls, routes));
  const tokens = {};
  for (const m of [MEMBER_A, MEMBER_B]) {
    const res = await handleRequest(
      new Request("https://gw.test/admin/members", {
        method: "POST",
        headers: { "x-admin-secret": "test-admin-secret" },
        body: JSON.stringify(m),
      }),
      env,
    );
    tokens[m.space] = (await res.json()).token;
  }
  return { env, calls, tokens };
}

function rpc(token, body) {
  return new Request("https://gw.test/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const TOKEN_ROUTES = [
  [
    "/app/installations/777/access_tokens",
    () => Response.json({ token: "ghs_a" }, { status: 201 }),
  ],
  [
    "/app/installations/888/access_tokens",
    () => Response.json({ token: "ghs_b" }, { status: 201 }),
  ],
];

test("unauthenticated POST /mcp is 401; GET /mcp is 405", async () => {
  const { env } = await setup(TOKEN_ROUTES);
  const post = await handleRequest(
    new Request("https://gw.test/mcp", { method: "POST", body: "{}" }),
    env,
  );
  assert.equal(post.status, 401);
  const get = await handleRequest(new Request("https://gw.test/mcp"), env);
  assert.equal(get.status, 405);
});

test("initialize and tools/list expose the stdio-identical contract", async () => {
  const { env, tokens } = await setup(TOKEN_ROUTES);
  const init = await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26" },
    }),
    env,
  );
  const initBody = await init.json();
  assert.equal(initBody.result.serverInfo.name, "memorylayer");
  assert.ok(initBody.result.capabilities.tools);

  const list = await handleRequest(
    rpc(tokens["team-a"], { jsonrpc: "2.0", id: 2, method: "tools/list" }),
    env,
  );
  const names = (await list.json()).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["read_context", "write_context"]);
});

test("tools/call write_context writes to the member repo and reports like stdio", async () => {
  const { env, tokens, calls } = await setup([
    ...TOKEN_ROUTES,
    ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
  ]);
  const res = await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "write_context",
        arguments: {
          project: "roadmap",
          type: "decision",
          payload: "We decided X because Y.",
          author: "Mallory",
        },
      },
    }),
    env,
  );
  const body = await res.json();
  assert.equal(body.result.isError, undefined);
  assert.match(
    body.result.content[0].text,
    /^Recorded decision in 'roadmap' as Ada at /,
  );
  // author argument is IGNORED: authenticated identity wins over client-declared
  const put = calls.find((c) => c.init.method === "PUT");
  assert.match(put.url, /team-a-memory/);
  assert.match(
    Buffer.from(JSON.parse(put.init.body).content, "base64").toString(),
    /author: Ada/,
  );
});

test("tools/call read_context renders the shared projection", async () => {
  const md =
    "---\nauthor: Ada\ntype: decision\ntimestamp: 2026-07-01T00:00:00.000Z\nid: x1\nproject: roadmap\n---\n\nships";
  const { env, tokens } = await setup([
    ...TOKEN_ROUTES,
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
    ["x1.md", () => new Response(md)],
  ]);
  const res = await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "read_context", arguments: { project: "roadmap" } },
    }),
    env,
  );
  const text = (await res.json()).result.content[0].text;
  assert.match(text, /# Shared context: roadmap/);
  assert.match(text, /decision — Ada — 2026-07-01T00:00:00\.000Z/);
});

test("ISOLATION: team-a token only ever touches team-a's repo", async () => {
  const { env, tokens, calls } = await setup([
    ...TOKEN_ROUTES,
    ["/git/trees/", () => Response.json({ tree: [] })],
    ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
  ]);
  await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "read_context", arguments: { project: "roadmap" } },
    }),
    env,
  );
  await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "write_context",
        arguments: { project: "roadmap", type: "context", payload: "p" },
      },
    }),
    env,
  );
  const repoCalls = calls.filter((c) => c.url.includes("/repos/"));
  assert.ok(repoCalls.length >= 2);
  for (const c of repoCalls) {
    assert.match(c.url, /\/repos\/acme\/team-a-memory\//);
    assert.doesNotMatch(c.url, /team-b-memory/);
  }
});

test("storage failure surfaces as an MCP tool error, not a crash", async () => {
  const { env, tokens } = await setup([
    ...TOKEN_ROUTES,
    ["/contents/", () => new Response("boom", { status: 500 })],
  ]);
  const res = await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "write_context",
        arguments: { project: "r", type: "context", payload: "p" },
      },
    }),
    env,
  );
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /write failed: 500/);
});

test("unknown method -> -32601; parse error -> -32700; batch -> -32600", async () => {
  const { env, tokens } = await setup(TOKEN_ROUTES);
  const unknown = await handleRequest(
    rpc(tokens["team-a"], { jsonrpc: "2.0", id: 8, method: "resources/list" }),
    env,
  );
  assert.equal((await unknown.json()).error.code, -32601);
  const bad = await handleRequest(
    new Request("https://gw.test/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${tokens["team-a"]}` },
      body: "{nope",
    }),
    env,
  );
  assert.equal((await bad.json()).error.code, -32700);
  const batch = await handleRequest(
    rpc(tokens["team-a"], [{ jsonrpc: "2.0", id: 9, method: "ping" }]),
    env,
  );
  assert.equal((await batch.json()).error.code, -32600);
});
