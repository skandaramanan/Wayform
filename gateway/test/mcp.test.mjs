import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../dist/gateway/src/router.js";
import { MemoryIndexDb } from "../dist/gateway/src/index-db-memory.js";
import { makeEnv, ghFetch, fakeEmbed, seedGithubMember } from "./helpers.mjs";

const MEMBER_A = {
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
const MEMBER_B = {
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

async function setup(routes, extra = {}) {
  const calls = [];
  const env = makeEnv(ghFetch(calls, routes), extra);
  for (const m of [MEMBER_A, MEMBER_B]) {
    await seedGithubMember(env, m);
  }
  const rpc = (space, body) => {
    const m = space === "team-b" ? MEMBER_B : MEMBER_A;
    env.oauthProps = { githubId: m.githubId, githubLogin: m.githubLogin };
    return new Request("https://gw.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  };
  return { env, calls, rpc };
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
  const { env, rpc } = await setup(TOKEN_ROUTES);
  const init = await handleRequest(
    rpc("team-a", {
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
  assert.match(initBody.result.instructions, /search_memory/);
  assert.match(initBody.result.instructions, /write_context/);
  assert.match(initBody.result.instructions, /memory_feedback/);
  assert.match(initBody.result.instructions, /MUST:/);

  const list = await handleRequest(
    rpc("team-a", { jsonrpc: "2.0", id: 2, method: "tools/list" }),
    env,
  );
  const names = (await list.json()).result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "create_plan",
    "edit_plan",
    "invite_member",
    "list_sessions",
    "memory_feedback",
    "read_context",
    "read_plan",
    "revoke_member",
    "revoke_session",
    "search_memory",
    "set_plan_mirror",
    "supersede_facts",
    "transition_plan",
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
  const { env, rpc } = await setup(TOKEN_ROUTES);
  const list = await handleRequest(
    rpc("team-a", { jsonrpc: "2.0", id: 20, method: "tools/list" }),
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
  const { env, rpc } = await setup(TOKEN_ROUTES, {
    indexDb,
    embedder: fakeEmbed,
  });
  const res = await handleRequest(
    rpc("team-a", {
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
  const { env, rpc } = await setup([
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
    rpc("team-a", {
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
  const { env, rpc } = await setup(TOKEN_ROUTES, {
    indexDb,
    embedder: fakeEmbed,
  });
  const res = await handleRequest(
    rpc("team-a", {
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
    rpc("team-a", {
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
  const { env, rpc } = await setup(
    [
      ...TOKEN_ROUTES,
      ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
    ],
    { indexDb, embedder: fakeEmbed },
  );
  await handleRequest(
    rpc("team-a", {
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
  const { env, rpc } = await setup(
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
    rpc("team-a", {
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
  // ingest + recency refresh are handed to ctx.waitUntil (deferred)
  assert.equal(deferred.length, 2);
  await Promise.all(deferred); // drain the background tasks
  assert.equal((await indexDb.listDocs("team-a", "memorylayer")).length, 1);
});

test("tools/call write_context writes to the member repo and reports like stdio", async () => {
  const { env, rpc, calls } = await setup([
    ...TOKEN_ROUTES,
    ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
  ]);
  const res = await handleRequest(
    rpc("team-a", {
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
  const { env, rpc } = await setup([
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
    rpc("team-a", {
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
  const { env, rpc, calls } = await setup([
    ...TOKEN_ROUTES,
    ["/git/trees/", () => Response.json({ tree: [] })],
    ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
  ]);
  await handleRequest(
    rpc("team-a", {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "read_context", arguments: { project: "roadmap" } },
    }),
    env,
  );
  await handleRequest(
    rpc("team-a", {
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

test("write_context warms the recency cache so the next queryless read stays a KV hit", async () => {
  const md = `---\nauthor: Ada\ntype: decision\ntimestamp: 2026-07-01T00:00:00.000Z\nid: r1\nproject: roadmap\n---\n\nsettled`;
  const { env, calls, rpc } = await setup([
    ...TOKEN_ROUTES,
    [
      "/git/trees/",
      () =>
        Response.json({
          tree: [
            {
              path: "context/roadmap/ada/2026-07-01T00-00-00-000Z-r1.md",
              type: "blob",
            },
          ],
        }),
    ],
    ["r1.md", () => new Response(md)],
    ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
  ]);
  const read = (id) =>
    handleRequest(
      rpc("team-a", {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "read_context", arguments: { project: "roadmap" } },
      }),
      env,
    );
  const treeCalls = () => calls.filter((c) => c.url.includes("/git/trees/"));

  await read(1);
  await read(2); // cache hit
  assert.equal(treeCalls().length, 1);

  await handleRequest(
    rpc("team-a", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "write_context",
        arguments: {
          project: "roadmap",
          type: "decision",
          payload: "brand new",
        },
      },
    }),
    env,
  );
  const after = await read(4);
  const body = await after.json();
  // Still a KV hit (no second tree fetch): warm prepend, not invalidate.
  assert.equal(treeCalls().length, 1);
  assert.match(body.result.content[0].text, /brand new/);
});

test("storage failure surfaces as an MCP tool error, not a crash", async () => {
  const { env, rpc } = await setup([
    ...TOKEN_ROUTES,
    ["/contents/", () => new Response("boom", { status: 500 })],
  ]);
  const res = await handleRequest(
    rpc("team-a", {
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
  const { env, rpc } = await setup([
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
    rpc("team-a", {
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
  const { env, rpc } = await setup([
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
    rpc("team-a", {
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
  const { env, rpc } = await setup(TOKEN_ROUTES);
  const unknown = await handleRequest(
    rpc("team-a", { jsonrpc: "2.0", id: 8, method: "resources/list" }),
    env,
  );
  assert.equal((await unknown.json()).error.code, -32601);
  const bad = await handleRequest(
    new Request("https://gw.test/mcp", {
      method: "POST",
      body: "{nope",
    }),
    env,
  );
  assert.equal((await bad.json()).error.code, -32700);
  const batch = await handleRequest(
    rpc("team-a", [{ jsonrpc: "2.0", id: 9, method: "ping" }]),
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
  const { env, rpc } = await setup(TOKEN_ROUTES, { indexDb: db });
  const res = await handleRequest(
    rpc("team-a", {
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
  const { env, rpc } = await setup(TOKEN_ROUTES, { indexDb: db });
  const res = await handleRequest(
    rpc("team-a", {
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
  const { env, rpc } = await setup(TOKEN_ROUTES, { indexDb: db });
  const res = await handleRequest(
    rpc("team-a", {
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

test("search_memory fails open when the index throws: recency read with project, plain notice without", async () => {
  const md =
    "---\nauthor: Ada\ntype: decision\ntimestamp: 2026-07-01T00:00:00.000Z\nid: x1\nproject: memorylayer\n---\n\nships";
  const indexDb = new MemoryIndexDb();
  indexDb.queryScan = async () => {
    throw new Error("D1 hiccup");
  };
  const { env, rpc } = await setup(
    [
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
    ],
    { indexDb, embedder: fakeEmbed },
  );

  const withProject = await handleRequest(
    rpc("team-a", {
      jsonrpc: "2.0",
      id: 40,
      method: "tools/call",
      params: {
        name: "search_memory",
        arguments: { query: "cursor config", project: "memorylayer" },
      },
    }),
    env,
  );
  const wp = (await withProject.json()).result;
  assert.notEqual(wp.isError, true, "degrade must not be an error result");
  assert.match(wp.content[0].text, /temporarily unavailable/);
  assert.match(wp.content[0].text, /ships/);

  const noProject = await handleRequest(
    rpc("team-a", {
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: { name: "search_memory", arguments: { query: "cursor config" } },
    }),
    env,
  );
  const np = (await noProject.json()).result;
  assert.notEqual(np.isError, true, "degrade must not be an error result");
  assert.match(np.content[0].text, /temporarily unavailable/);
  assert.match(np.content[0].text, /read_context/);
});

test("write_context with the dup gate ENFORCED blocks an exact duplicate and never commits", async () => {
  const payload = "Cursor MCP config is project-scoped, not global.";
  const indexDb = new MemoryIndexDb();
  const [vec] = await fakeEmbed([payload]);
  await indexDb.upsertDocs([
    docFor("team-a", "memorylayer", "dup1", payload, vec),
  ]);
  const { env, calls, rpc } = await setup(
    [
      ...TOKEN_ROUTES,
      ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
    ],
    {
      indexDb,
      embedder: fakeEmbed,
      genText: async () => '{"verdict":"relates","reason":"x"}',
      dupGateEnforce: true,
    },
  );
  const res = await handleRequest(
    rpc("team-a", {
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: {
        name: "write_context",
        arguments: { project: "memorylayer", payload },
      },
    }),
    env,
  );
  const body = (await res.json()).result;
  assert.notEqual(body.isError, true, "a blocked duplicate is not an error");
  assert.match(body.content[0].text, /not re-recorded/);
  assert.match(body.content[0].text, /dup1/);
  assert.ok(
    !calls.some((c) => c.url.includes("/contents/")),
    "no ledger commit for a blocked duplicate",
  );
});

test("write_context with explicit supersedes bypasses the enforced dup gate and commits", async () => {
  const payload = "Cursor MCP config is project-scoped, not global.";
  const indexDb = new MemoryIndexDb();
  const [vec] = await fakeEmbed([payload]);
  await indexDb.upsertDocs([
    docFor("team-a", "memorylayer", "dup1", payload, vec),
  ]);
  const { env, calls, rpc } = await setup(
    [
      ...TOKEN_ROUTES,
      ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
    ],
    {
      indexDb,
      embedder: fakeEmbed,
      genText: async () => '{"verdict":"relates","reason":"x"}',
      dupGateEnforce: true,
    },
  );
  const res = await handleRequest(
    rpc("team-a", {
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: {
        name: "write_context",
        arguments: { project: "memorylayer", payload, supersedes: ["dup1"] },
      },
    }),
    env,
  );
  const body = (await res.json()).result;
  assert.match(body.content[0].text, /Recorded/);
  assert.match(body.content[0].text, /Supersedes: dup1/);
  assert.ok(
    calls.some((c) => c.url.includes("/contents/")),
    "explicit supersedes must commit",
  );
});

test("write_context still commits when the embedder throws (gate fails open)", async () => {
  const indexDb = new MemoryIndexDb();
  const [vec] = await fakeEmbed(["existing fact"]);
  await indexDb.upsertDocs([
    docFor("team-a", "memorylayer", "dup1", "existing fact", vec),
  ]);
  const { env, calls, rpc } = await setup(
    [
      ...TOKEN_ROUTES,
      ["/contents/", () => Response.json({ ok: true }, { status: 201 })],
    ],
    {
      indexDb,
      embedder: async () => {
        throw new Error("AI down");
      },
      genText: async () => '{"verdict":"relates","reason":"x"}',
      dupGateEnforce: true,
    },
  );
  const res = await handleRequest(
    rpc("team-a", {
      jsonrpc: "2.0",
      id: 52,
      method: "tools/call",
      params: {
        name: "write_context",
        arguments: { project: "memorylayer", payload: "existing fact" },
      },
    }),
    env,
  );
  assert.match((await res.json()).result.content[0].text, /Recorded/);
  assert.ok(
    calls.some((c) => c.url.includes("/contents/")),
    "embed failure must never lose a write",
  );
});

test("write_context schema teaches amend-via-supersedes", async () => {
  const { env, rpc } = await setup(TOKEN_ROUTES);
  const list = await handleRequest(
    rpc("team-a", { jsonrpc: "2.0", id: 60, method: "tools/list" }),
    env,
  );
  const tools = (await list.json()).result.tools;
  const wc = tools.find((t) => t.name === "write_context");
  assert.match(wc.description, /UPDATE or CORRECT/);
  assert.match(
    wc.inputSchema.properties.supersedes.description,
    /updating\/amending a recorded decision/,
  );
});
