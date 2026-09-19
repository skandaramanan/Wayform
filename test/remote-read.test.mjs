import { test } from "node:test";
import assert from "node:assert/strict";
import {
  remoteApiRead,
  remoteHookRead,
  remoteGuardCheck,
  remoteApiPlans,
  GUARD_TIMEOUT_MS,
} from "../dist/remote-read.js";

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

test("remoteGuardCheck POSTs the action and parses the decision", async () => {
  let seen;
  const out = await remoteGuardCheck(
    CFG,
    "memorylayer",
    "Edit: add Postgres",
    async (gatewayUrl, url, init) => {
      seen = { url: String(url), body: JSON.parse(init.body) };
      return Response.json({
        decision: "ask",
        reason: "ruled out",
        factIds: ["f1"],
      });
    },
  );
  assert.match(seen.url, /\/mcp\/hook\/guard$/);
  assert.deepEqual(seen.body, {
    project: "memorylayer",
    action: "Edit: add Postgres",
  });
  assert.equal(out.decision, "ask");
  assert.equal(out.reason, "ruled out");
});

test("remoteGuardCheck returns null when the gateway is unconfigured", async () => {
  assert.equal(await remoteGuardCheck({}, "memorylayer", "Edit: x"), null);
});

test("remoteGuardCheck returns null on a non-ok response", async () => {
  const out = await remoteGuardCheck(
    CFG,
    "memorylayer",
    "Edit: x",
    async () => new Response("boom", { status: 500 }),
  );
  assert.equal(out, null);
});

test("remoteGuardCheck returns null when the fetch throws", async () => {
  const out = await remoteGuardCheck(
    CFG,
    "memorylayer",
    "Edit: x",
    async () => {
      throw new Error("offline");
    },
  );
  assert.equal(out, null);
});

test("remoteGuardCheck treats an unknown decision as allow", async () => {
  const out = await remoteGuardCheck(CFG, "memorylayer", "Edit: x", async () =>
    Response.json({ decision: "deny", reason: "nope" }),
  );
  assert.equal(out.decision, "allow");
});

test("guard timeout stays under the 10s PreToolUse hook wrapper", () => {
  assert.ok(GUARD_TIMEOUT_MS < 10_000);
});

test("remoteApiPlans parses the mirror payload and nulls on failure", async () => {
  const ok = async (_g, url) => {
    assert.equal(new URL(url).pathname, "/mcp/api/plans");
    assert.equal(new URL(url).searchParams.get("project"), "p");
    return Response.json({
      enabled: true,
      plans: [{ file: "1-a.md", markdown: "# A" }],
    });
  };
  assert.deepEqual(await remoteApiPlans(CFG, "p", ok), {
    enabled: true,
    plans: [{ file: "1-a.md", markdown: "# A" }],
  });
  assert.equal(
    await remoteApiPlans(
      CFG,
      "p",
      async () => new Response("x", { status: 500 }),
    ),
    null,
  );
  assert.equal(
    await remoteApiPlans(CFG, "p", async () => Response.json({ nope: 1 })),
    null,
  );
  assert.equal(await remoteApiPlans({}, "p"), null);
});
