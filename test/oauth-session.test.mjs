import { test } from "node:test";
import assert from "node:assert/strict";
import { loadStoredOAuth, saveStoredOAuth } from "../dist/keychain.js";

function memoryStore() {
  const values = new Map();
  return {
    get: (account) => values.get(account) ?? null,
    set: (account, value) => values.set(account, value),
    delete: (account) => values.delete(account),
  };
}

function expiredSession() {
  return {
    client_id: "cli-1",
    access_token: "expired",
    refresh_token: "refresh-1",
    expires_at: 1,
    token_endpoint: "https://gw.test/oauth/token",
    resource: "https://gw.test/mcp",
  };
}

test("expired OAuth session refreshes and stores rotated credentials", async () => {
  const { getValidAccessToken } = await import("../dist/oauth-session.js");
  const store = memoryStore();
  saveStoredOAuth("https://gw.test", expiredSession(), store);

  const token = await getValidAccessToken("https://gw.test", {
    store,
    now: () => 10_000,
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://gw.test/oauth/token");
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "refresh-1");
      assert.equal(body.get("client_id"), "cli-1");
      assert.equal(body.get("resource"), "https://gw.test/mcp");
      return Response.json({
        access_token: "fresh",
        refresh_token: "refresh-2",
        expires_in: 3600,
      });
    },
  });

  assert.equal(token, "fresh");
  const stored = loadStoredOAuth("https://gw.test", store);
  assert.equal(stored?.refresh_token, "refresh-2");
  assert.equal(stored?.expires_at, 3_610_000);
});

test("authenticated fetch refreshes and retries once after a 401", async () => {
  const { oauthFetch } = await import("../dist/oauth-session.js");
  const store = memoryStore();
  saveStoredOAuth(
    "https://gw.test",
    { ...expiredSession(), access_token: "first", expires_at: 100_000 },
    store,
  );
  const seen = [];

  const response = await oauthFetch(
    "https://gw.test",
    "https://gw.test/mcp/hook/read?project=p",
    {},
    {
      store,
      now: () => 10_000,
      fetchImpl: async (url, init = {}) => {
        if (String(url).endsWith("/oauth/token")) {
          return Response.json({
            access_token: "second",
            refresh_token: "refresh-2",
            expires_in: 3600,
          });
        }
        seen.push(new Headers(init.headers).get("authorization"));
        return seen.length === 1
          ? new Response("expired", { status: 401 })
          : new Response("ok");
      },
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(seen, ["Bearer first", "Bearer second"]);
});

test("terminal refresh failure preserves the session for race-safe re-login", async () => {
  const { getValidAccessToken } = await import("../dist/oauth-session.js");
  const store = memoryStore();
  saveStoredOAuth("https://gw.test", expiredSession(), store);

  await assert.rejects(
    getValidAccessToken("https://gw.test", {
      store,
      now: () => 10_000,
      fetchImpl: async () =>
        Response.json({ error: "invalid_grant" }, { status: 400 }),
    }),
    /wayform login/,
  );
  assert.equal(
    loadStoredOAuth("https://gw.test", store)?.refresh_token,
    "refresh-1",
  );
});

test("concurrent refreshes share one rotating credential exchange", async () => {
  const { getValidAccessToken } = await import("../dist/oauth-session.js");
  const store = memoryStore();
  saveStoredOAuth("https://gw.test", expiredSession(), store);
  let exchanges = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const options = {
    store,
    now: () => 10_000,
    fetchImpl: async () => {
      exchanges += 1;
      await gate;
      return Response.json({
        access_token: "fresh",
        refresh_token: "refresh-2",
        expires_in: 3600,
      });
    },
  };
  const first = getValidAccessToken("https://gw.test", options);
  const second = getValidAccessToken("https://gw.test", options);
  await Promise.resolve();
  release();
  assert.deepEqual(await Promise.all([first, second]), ["fresh", "fresh"]);
  assert.equal(exchanges, 1);
});

test("a stale invalid_grant cannot delete a concurrently rotated session", async () => {
  const { getValidAccessToken } = await import("../dist/oauth-session.js");
  const store = memoryStore();
  saveStoredOAuth("https://gw.test", expiredSession(), store);
  const token = await getValidAccessToken("https://gw.test", {
    store,
    now: () => 10_000,
    fetchImpl: async () => {
      saveStoredOAuth(
        "https://gw.test",
        {
          ...expiredSession(),
          access_token: "newer",
          refresh_token: "refresh-2",
          expires_at: 3_610_000,
        },
        store,
      );
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    },
  });
  assert.equal(token, "newer");
  assert.equal(
    loadStoredOAuth("https://gw.test", store)?.refresh_token,
    "refresh-2",
  );
});

test("authenticated fetch applies its timeout signal to OAuth refresh", async () => {
  const { oauthFetch } = await import("../dist/oauth-session.js");
  const store = memoryStore();
  saveStoredOAuth("https://gw.test", expiredSession(), store);
  const controller = new AbortController();
  let refreshSignal;
  const response = await oauthFetch(
    "https://gw.test",
    "https://gw.test/mcp",
    { signal: controller.signal },
    {
      store,
      now: () => 10_000,
      fetchImpl: async (url, init = {}) => {
        if (String(url).endsWith("/oauth/token")) {
          refreshSignal = init.signal;
          return Response.json({
            access_token: "fresh",
            refresh_token: "refresh-2",
            expires_in: 3600,
          });
        }
        return new Response("ok");
      },
    },
  );
  assert.equal(response.status, 200);
  assert.equal(refreshSignal, controller.signal);
});
