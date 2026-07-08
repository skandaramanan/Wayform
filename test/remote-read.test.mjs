import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteApiRead, remoteHookRead } from "../dist/remote-read.js";

const CFG = { gatewayUrl: "https://gw.example.com", gatewayToken: "mlk_t" };

test("remoteApiRead builds the URL, sends the bearer token, parses JSON", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url: String(url), init };
    return Response.json({ text: "ranked", total: 5, matched: 2 });
  };
  const out = await remoteApiRead(
    CFG,
    {
      project: "memorylayer",
      query: "cursor config",
      budgetTokens: 1000,
      trigger: "mcp_read",
    },
    fetchImpl,
  );
  assert.deepEqual(out, { text: "ranked", total: 5, matched: 2 });
  const u = new URL(seen.url);
  assert.equal(u.pathname, "/api/read");
  assert.equal(u.searchParams.get("project"), "memorylayer");
  assert.equal(u.searchParams.get("query"), "cursor config");
  assert.equal(u.searchParams.get("budget"), "1000");
  assert.equal(u.searchParams.get("trigger"), "mcp_read");
  assert.equal(seen.init.headers.authorization, "Bearer mlk_t");
});

test("remoteApiRead returns null on non-200, bad JSON, thrown fetch, or missing config", async () => {
  assert.equal(await remoteApiRead({}, { project: "p" }), null);
  assert.equal(
    await remoteApiRead(
      CFG,
      { project: "p" },
      async () => new Response("x", { status: 500 }),
    ),
    null,
  );
  assert.equal(
    await remoteApiRead(
      CFG,
      { project: "p" },
      async () => new Response("not json"),
    ),
    null,
  );
  assert.equal(
    await remoteApiRead(CFG, { project: "p" }, async () => {
      throw new Error("net");
    }),
    null,
  );
});

test("remoteHookRead returns the body text (empty string preserved), null on failure", async () => {
  assert.equal(
    await remoteHookRead(
      CFG,
      "p",
      4000,
      async () => new Response("injected text"),
    ),
    "injected text",
  );
  assert.equal(
    await remoteHookRead(CFG, "p", 4000, async () => new Response("")),
    "",
  );
  assert.equal(
    await remoteHookRead(
      CFG,
      "p",
      4000,
      async () => new Response("x", { status: 401 }),
    ),
    null,
  );
  assert.equal(await remoteHookRead({}, "p", 4000), null);
});
