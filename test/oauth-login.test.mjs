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
  hydrateGatewayTokenFromKeychain,
} from "../dist/keychain.js";
import { runLogin } from "../dist/oauth-login.js";

test("file keychain stores and returns secrets without printing them", () => {
  const file = path.join(os.tmpdir(), `wayform-kc-${Date.now()}.json`);
  const prev = process.env.WAYFORM_KEYCHAIN_FILE;
  process.env.WAYFORM_KEYCHAIN_FILE = file;
  try {
    keychainSet("https://gw.test", "secret-value");
    assert.equal(keychainGet("https://gw.test"), "secret-value");
    saveStoredOAuth("https://gw.test", { access_token: "tok_abc" });
    const stored = loadStoredOAuth("https://gw.test");
    assert.equal(stored?.access_token, "tok_abc");
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /mlk_/);
  } finally {
    if (prev === undefined) delete process.env.WAYFORM_KEYCHAIN_FILE;
    else process.env.WAYFORM_KEYCHAIN_FILE = prev;
    fs.rmSync(file, { force: true });
  }
});

test("hydrateGatewayTokenFromKeychain injects the access token into env", () => {
  const file = path.join(os.tmpdir(), `wayform-kc-${Date.now()}.json`);
  const prev = process.env.WAYFORM_KEYCHAIN_FILE;
  process.env.WAYFORM_KEYCHAIN_FILE = file;
  const env = { MEMORYLAYER_GATEWAY_URL: "https://gw.test" };
  try {
    saveStoredOAuth("https://gw.test", { access_token: "from-keychain" });
    hydrateGatewayTokenFromKeychain(env);
    assert.equal(env.MEMORYLAYER_GATEWAY_TOKEN, "from-keychain");
  } finally {
    if (prev === undefined) delete process.env.WAYFORM_KEYCHAIN_FILE;
    else process.env.WAYFORM_KEYCHAIN_FILE = prev;
    fs.rmSync(file, { force: true });
  }
});

test("wayform login stores tokens in the keychain and never prints them", async () => {
  const file = path.join(os.tmpdir(), `wayform-kc-${Date.now()}.json`);
  const prev = process.env.WAYFORM_KEYCHAIN_FILE;
  process.env.WAYFORM_KEYCHAIN_FILE = file;
  const logs = [];
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
      },
      listen: async (handler) => {
        const server = http.createServer(handler);
        await new Promise((r) => server.listen(0, "127.0.0.1", r));
        const { port } = server.address();
        queueMicrotask(() => {
          fetch(`http://127.0.0.1:${port}/callback?code=gh-code`).catch(
            () => undefined,
          );
        });
        return { port, close: () => server.close() };
      },
    });
    const stored = loadStoredOAuth("https://gw.test");
    assert.equal(stored?.access_token, "at_secret");
    assert.equal(stored?.refresh_token, "rt_secret");
    const out = logs.join("\n");
    assert.match(out, /Logged in/);
    assert.doesNotMatch(out, /at_secret|rt_secret|mlk_/);
    assert.match(opened, /https:\/\/gw\.test\/authorize/);
  } finally {
    if (prev === undefined) delete process.env.WAYFORM_KEYCHAIN_FILE;
    else process.env.WAYFORM_KEYCHAIN_FILE = prev;
    fs.rmSync(file, { force: true });
  }
});
