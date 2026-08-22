import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  keychainSet,
  keychainGet,
  saveStoredOAuth,
  loadStoredOAuth,
} from "../dist/keychain.js";
import { LOGIN_TIMEOUT_MS, runLogin } from "../dist/oauth-login.js";

function memoryStore() {
  const values = new Map();
  return {
    values,
    get: (account) => values.get(account) ?? null,
    set: (account, value) => values.set(account, value),
    delete: (account) => values.delete(account),
  };
}

test("CLI listener outlives the ten-minute guided setup window", () => {
  assert.ok(LOGIN_TIMEOUT_MS > 10 * 60 * 1000);
});

test("file keychain stores and returns secrets without printing them", () => {
  const file = path.join(os.tmpdir(), `wayform-kc-${Date.now()}.json`);
  const prev = process.env.WAYFORM_KEYCHAIN_FILE;
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.WAYFORM_KEYCHAIN_FILE = file;
  process.env.NODE_ENV = "test";
  try {
    keychainSet("https://gw.test", "secret-value");
    assert.equal(keychainGet("https://gw.test"), "secret-value");
    saveStoredOAuth("https://gw.test", {
      client_id: "cli-1",
      access_token: "tok_abc",
      expires_at: Date.now() + 60_000,
      token_endpoint: "https://gw.test/oauth/token",
      resource: "https://gw.test/mcp",
    });
    const stored = loadStoredOAuth("https://gw.test");
    assert.equal(stored?.access_token, "tok_abc");
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /mlk_/);
  } finally {
    if (prev === undefined) delete process.env.WAYFORM_KEYCHAIN_FILE;
    else process.env.WAYFORM_KEYCHAIN_FILE = prev;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    fs.rmSync(file, { force: true });
  }
});

test("stored OAuth sessions use an injected credential store", () => {
  const file = path.join(os.tmpdir(), `wayform-kc-${Date.now()}.json`);
  const prev = process.env.WAYFORM_KEYCHAIN_FILE;
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.WAYFORM_KEYCHAIN_FILE = file;
  process.env.NODE_ENV = "test";
  const store = memoryStore();
  try {
    saveStoredOAuth(
      "https://gw.test",
      {
        client_id: "cli-1",
        access_token: "from-keychain",
        refresh_token: "refresh",
        expires_at: 123,
        token_endpoint: "https://gw.test/oauth/token",
        resource: "https://gw.test/mcp",
      },
      store,
    );
    assert.equal(store.values.size, 1);
    assert.equal(loadStoredOAuth("https://gw.test", store)?.client_id, "cli-1");
  } finally {
    if (prev === undefined) delete process.env.WAYFORM_KEYCHAIN_FILE;
    else process.env.WAYFORM_KEYCHAIN_FILE = prev;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    fs.rmSync(file, { force: true });
  }
});

test("wayform login stores tokens in the keychain and never prints them", async () => {
  const file = path.join(os.tmpdir(), `wayform-kc-${Date.now()}.json`);
  const prev = process.env.WAYFORM_KEYCHAIN_FILE;
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.WAYFORM_KEYCHAIN_FILE = file;
  process.env.NODE_ENV = "test";
  const logs = [];
  const store = memoryStore();
  let opened;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith("/oauth/register")) {
      return new Response(JSON.stringify({ client_id: "cli-1" }), {
        status: 201,
      });
    }
    if (u.endsWith("/oauth/token")) {
      const body = String(init.body);
      assert.match(body, /grant_type=authorization_code/);
      assert.match(body, /code=gh-code/);
      return Response.json({
        access_token: "at_secret",
        refresh_token: "rt_secret",
        expires_in: 3600,
      });
    }
    return new Response("nope", { status: 404 });
  };
  try {
    await runLogin(["--gateway", "https://gw.test"], {
      fetchImpl,
      log: (m) => logs.push(m),
      openUrl: (url) => {
        opened = url;
        const authorize = new URL(url);
        const redirectUri = authorize.searchParams.get("redirect_uri");
        const state = authorize.searchParams.get("state");
        queueMicrotask(() => {
          fetch(`${redirectUri}?code=gh-code&state=${state}`).catch(
            () => undefined,
          );
        });
      },
      listen: async (handler) => {
        const server = http.createServer(handler);
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const { port } = server.address();
        return { port, close: () => server.close() };
      },
      credentialStore: store,
    });
    const stored = loadStoredOAuth("https://gw.test", store);
    assert.equal(stored?.access_token, "at_secret");
    assert.equal(stored?.refresh_token, "rt_secret");
    assert.equal(stored?.client_id, "cli-1");
    assert.equal(stored?.resource, "https://gw.test/mcp");
    const out = logs.join("\n");
    assert.match(out, /Logged in/);
    assert.doesNotMatch(out, /at_secret|rt_secret|mlk_/);
    assert.match(opened, /https:\/\/gw\.test\/authorize/);
  } finally {
    if (prev === undefined) delete process.env.WAYFORM_KEYCHAIN_FILE;
    else process.env.WAYFORM_KEYCHAIN_FILE = prev;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    fs.rmSync(file, { force: true });
  }
});

test("wayform login rejects a mismatched localhost OAuth state", async () => {
  const store = memoryStore();
  let tokenExchangeCalled = false;

  await assert.rejects(
    runLogin(["--gateway", "https://gw.test"], {
      credentialStore: store,
      log: () => undefined,
      fetchImpl: async (url) => {
        if (String(url).endsWith("/oauth/register")) {
          return Response.json({ client_id: "cli-1" }, { status: 201 });
        }
        tokenExchangeCalled = true;
        return Response.json({ access_token: "must-not-save" });
      },
      listen: async (handler) => {
        const server = http.createServer(handler);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address();
        return { port, close: () => server.close() };
      },
      openUrl: (url) => {
        const redirectUri = new URL(url).searchParams.get("redirect_uri");
        queueMicrotask(() => {
          fetch(`${redirectUri}?code=gh-code&state=wrong`).catch(
            () => undefined,
          );
        });
      },
    }),
    /state mismatch/,
  );
  assert.equal(tokenExchangeCalled, false);
  assert.equal(loadStoredOAuth("https://gw.test", store), null);
});
