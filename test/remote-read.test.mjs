import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteApiRead, remoteHookRead } from "../dist/remote-read.js";

const CFG = { gatewayUrl: "https://gw.example.com" };

test("remoteApiRead uses the OAuth fetch boundary and parses JSON", async () => {
  let seen;
  const fetchImpl = async (gatewayUrl, url, init) => {
    seen = { gatewayUrl, url: String(url), init };
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
  assert.equal(seen.gatewayUrl, "https://gw.example.com");
  const u = new URL(seen.url);
  assert.equal(u.pathname, "/mcp/api/read");
  assert.equal(u.searchParams.get("project"), "memorylayer");
  assert.equal(u.searchParams.get("query"), "cursor config");
  assert.equal(u.searchParams.get("budget"), "1000");
  assert.equal(u.searchParams.get("trigger"), "mcp_read");
  assert.equal(new Headers(seen.init.headers).has("authorization"), false);
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
  let pathname;
  assert.equal(
    await remoteHookRead(CFG, "p", 4000, async (_gatewayUrl, url) => {
      pathname = new URL(url).pathname;
      return new Response("injected text");
    }),
    "injected text",
  );
  assert.equal(pathname, "/mcp/hook/read");
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
