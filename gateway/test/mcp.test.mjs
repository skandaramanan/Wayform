import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db.js";
import { makeEnv, ghFetch, fakeEmbed } from "./helpers.mjs";

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

async function setup(routes, extra = {}) {
  const calls = [];
  const env = makeEnv(ghFetch(calls, routes), extra);
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
  assert.deepEqual(names, [
    "memory_feedback",
    "read_context",
    "search_memory",
    "write_context",
  ]);
});

function docFor(space, project, id, body, embedding) {
  return {
    id,
    space,
    project,
    kind: "decision",
    tier: "normal",
    body,
    sourceFile: `context/${project}/ada/${id}.md`,
    sourceAuthor: "Ada",
    sourceTs: "2026-06-01T00:00:00Z",
    embedding,
    supersededBy: null,
    createdAt: "2026-07-08T00:00:00Z",
  };
}

test("read_context.query is advertised in the schema", async () => {
  const { env, tokens } = await setup(TOKEN_ROUTES);
  const list = await handleRequest(
    rpc(tokens["team-a"], { jsonrpc: "2.0", id: 20, method: "tools/list" }),
    env,
  );
  const tools = (await list.json()).result.tools;
  const rc = tools.find((t) => t.name === "read_context");
  assert.ok(rc.inputSchema.properties.query);
  const sm = tools.find((t) => t.name === "search_memory");
  assert.deepEqual(sm.inputSchema.required, ["query"]);
});

test("read_context with query returns ranked matches from the index", async () => {
  const indexDb = new MemoryIndexDb();
  const [vec] = await fakeEmbed([
    "Cursor MCP config is project-scoped, not global.",
  ]);
  await indexDb.upsertDocs([
    docFor(
      "team-a",
      "memorylayer",
      "cursor-fact",
      "Cursor MCP config is project-scoped, not global.",
      vec,
    ),
  ]);
  const { env, tokens } = await setup(TOKEN_ROUTES, {
    indexDb,
    embedder: fakeEmbed,
  });
  const res = await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "read_context",
        arguments: { project: "memorylayer", query: "cursor mcp config" },
      },
    }),
    env,
  );
  const text = (await res.json()).result.content[0].text;
  assert.match(text, /Memory search: "cursor mcp config"/);
  assert.match(text, /project-scoped/);
  assert.equal(indexDb.logged[0].trigger, "mcp_read");
});

test("read_context with query but no index falls back to the recency read", async () => {
  const md =
    "---\nauthor: Ada\ntype: decision\ntimestamp: 2026-07-01T00:00:00.000Z\nid: x1\nproject: memorylayer\n---\n\nships";
  const { env, tokens } = await setup([
    ...TOKEN_ROUTES,
    [
      "/git/trees/",
      () =>
        Response.json({
          tree: [
            {
              path: "context/memorylayer/ada/2026-07-01T00-00-00-000Z-x1.md",
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
      id: 22,
      method: "tools/call",
      params: {
        name: "read_context",
        arguments: { project: "memorylayer", query: "cursor" },
      },
    }),
    env,
  );
  assert.match(
    (await res.json()).result.content[0].text,
    /# Shared context: memorylayer/,
  );
});

test("search_memory searches the space, honors kinds, and requires query", async () => {
  const indexDb = new MemoryIndexDb();
  const [v1, v2] = await fakeEmbed([
    "Cursor MCP config is project-scoped, not global.",
    "background: the pilot has two spaces",
  ]);
  await indexDb.upsertDocs([
    docFor(
      "team-a",
      "memorylayer",
      "cursor-fact",
      "Cursor MCP config is project-scoped, not global.",
      v1,
    ),
    {
      ...docFor("team-a", "other", "ctx1", "background pilot spaces", v2),
      kind: "context",
    },
  ]);
  const { env, tokens } = await setup(TOKEN_ROUTES, {
    indexDb,
    embedder: fakeEmbed,
  });
  const res = await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 23,
      method: "tools/call",
      params: {
        name: "search_memory",
        arguments: { query: "cursor mcp config" },
      },
    }),
    env,
  );
  assert.match((await res.json()).result.content[0].text, /project-scoped/);

  const missing = await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: { name: "search_memory", arguments: {} },
    }),
    env,
  );
  const missingBody = (await missing.json()).result;
  assert.equal(missingBody.isError, true);
  assert.match(missingBody.content[0].text, /missing required argument: query/);
});

test("write_context ingests the new entry inline so it is immediately searchable", async () => {
  const indexDb = new MemoryIndexDb();
  const { env, tokens } = await setup(
    [
      ...TOKEN_ROUTES,
      ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
    ],
    { indexDb, embedder: fakeEmbed },
  );
  await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 25,
      method: "tools/call",
      params: {
        name: "write_context",
        arguments: {
          project: "memorylayer",
          payload: "We moved retrieval server-side.",
        },
      },
    }),
    env,
  );
  const docs = await indexDb.listDocs("team-a", "memorylayer");
  assert.equal(docs.length, 1);
  assert.equal(docs[0].body, "We moved retrieval server-side.");
});

test("write_context defers index ingest to ctx.waitUntil and still returns success", async () => {
  const indexDb = new MemoryIndexDb();
  const { env, tokens } = await setup(
    [
      ...TOKEN_ROUTES,
      ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
    ],
    {
      indexDb,
      embedder: fakeEmbed,
      genText: async () =>
        JSON.stringify([
          { kind: "decision", tier: "normal", body: "f", entities: [] },
        ]),
    },
  );
  const deferred = [];
  const ctx = { waitUntil: (p) => deferred.push(p) };
  const res = await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 26,
      method: "tools/call",
      params: {
        name: "write_context",
        arguments: { project: "memorylayer", payload: "we decided X" },
      },
    }),
    env,
    ctx,
  );
  const body = await res.json();
  assert.match(body.result.content[0].text, /Recorded decision/);
  // ingest was handed to ctx.waitUntil (deferred), not awaited inline
  assert.equal(deferred.length, 1);
  await Promise.all(deferred); // drain the background task
  assert.equal((await indexDb.listDocs("team-a", "memorylayer")).length, 1);
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

test("KV delete failure after a successful write still reports success (best-effort invalidation)", async () => {
  const { env, tokens } = await setup([
    ...TOKEN_ROUTES,
    ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
  ]);
  // Wrap the KV so delete throws AFTER the GitHub write has committed.
  const realDelete = env.ROUTING.delete.bind(env.ROUTING);
  env.ROUTING.delete = async (key) => {
    if (key.startsWith("hookread:")) throw new Error("KV unavailable");
    return realDelete(key);
  };
  const res = await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "write_context",
        arguments: { project: "roadmap", type: "decision", payload: "durable" },
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
});

test("read_context budget_tokens: 0 does not mean unlimited — still budget-limited", async () => {
  const bigPayload = "x".repeat(20000); // ~5000 estimated tokens, > DEFAULT_BUDGET_TOKENS
  const md1 = `---\nauthor: Ada\ntype: decision\ntimestamp: 2026-07-01T00:00:00.000Z\nid: x1\nproject: roadmap\n---\n\n${bigPayload}`;
  const md2 = `---\nauthor: Ada\ntype: decision\ntimestamp: 2026-07-02T00:00:00.000Z\nid: x2\nproject: roadmap\n---\n\n${bigPayload}`;
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
  const res = await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "read_context",
        arguments: { project: "roadmap", budget_tokens: 0 },
      },
    }),
    env,
  );
  const text = (await res.json()).result.content[0].text;
  assert.match(text, /Showing the 1 most recent of 2/);
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

test("memory_feedback records one row from the bearer identity", async () => {
  const db = new MemoryIndexDb();
  await db.upsertDocs([
    {
      id: "f1",
      space: "team-a",
      project: "memorylayer",
      kind: "decision",
      tier: "normal",
      body: "x",
      sourceFile: "f",
      sourceAuthor: "Ada",
      sourceTs: "2026-07-01T00:00:00Z",
      embedding: [],
      supersededBy: null,
      createdAt: "2026-07-01T00:00:00Z",
      sourceId: "f1",
      entities: [],
    },
  ]);
  const { env, tokens } = await setup(TOKEN_ROUTES, { indexDb: db });
  const res = await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "memory_feedback",
        arguments: { fact_id: "f1", verdict: "wrong" },
      },
    }),
    env,
  );
  const text = (await res.json()).result.content[0].text;
  assert.match(text, /Recorded 'wrong'/);
  assert.equal(db.feedbackLogged.length, 1);
  assert.equal(db.feedbackLogged[0].factId, "f1");
  assert.equal(db.feedbackLogged[0].member, "Ada");
});

test("memory_feedback rejects an unknown verdict", async () => {
  const db = new MemoryIndexDb();
  const { env, tokens } = await setup(TOKEN_ROUTES, { indexDb: db });
  const res = await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "memory_feedback",
        arguments: { fact_id: "f1", verdict: "bogus" },
      },
    }),
    env,
  );
  const out = (await res.json()).result;
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /verdict must be one of/);
});

test("memory_feedback fails open on a write error", async () => {
  const db = new MemoryIndexDb();
  db.recordFeedback = async () => {
    throw new Error("store down");
  };
  const { env, tokens } = await setup(TOKEN_ROUTES, { indexDb: db });
  const res = await handleRequest(
    rpc(tokens["team-a"], {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "memory_feedback",
        arguments: { fact_id: "f1", verdict: "useful" },
      },
    }),
    env,
  );
  const out = (await res.json()).result;
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /couldn't record feedback/);
});
