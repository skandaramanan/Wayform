/**
 * Client-path verification for token-free OAuth onboarding.
 *
 * Live Cursor Connect / `claude mcp login` / `codex mcp login` still need a
 * browser against the hosted gateway; this suite locks the artifacts those
 * clients consume so a regression cannot put mlk_/wfi_ back into files or CLI.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  mergeCursorRemoteMcp,
  mergeDevinRemoteMcp,
  mergeAntigravityRemoteMcp,
  codexRemoteConfigToml,
} from "../dist/init-configs.js";
import { registerClaudeCodeMcp } from "../dist/init-remote.js";
import { saveStoredOAuth } from "../dist/keychain.js";

const hookPath = fileURLToPath(new URL("../dist/hook.js", import.meta.url));
const cliPath = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

test("Cursor Connect config is URL-only (no Authorization header)", () => {
  const cfg = mergeCursorRemoteMcp(
    undefined,
    "https://memorylayer-gateway.memory-layer.workers.dev",
  );
  assert.deepEqual(cfg.mcpServers.wayform, {
    url: "https://memorylayer-gateway.memory-layer.workers.dev/mcp",
  });
  assert.equal(JSON.stringify(cfg).includes("mlk_"), false);
  assert.equal(JSON.stringify(cfg).includes("headers"), false);
});

test("Codex config is url + auth=oauth (codex mcp login wayform)", () => {
  const toml = codexRemoteConfigToml(
    "https://memorylayer-gateway.memory-layer.workers.dev",
  );
  assert.match(toml, /auth = "oauth"/);
  assert.doesNotMatch(toml, /http_headers|mlk_|Bearer /);
});

test("Claude Code project scope is --scope project, never --scope user", () => {
  const res = registerClaudeCodeMcp(
    "https://memorylayer-gateway.memory-layer.workers.dev",
    () => undefined,
  );
  assert.match(res.command, /--scope project/);
  assert.doesNotMatch(res.command, /--scope user|--scope local|--header/);
  assert.doesNotMatch(res.command, /mlk_/);
});

test("Devin and Antigravity project files are URL-only HTTP", () => {
  const gw = "https://memorylayer-gateway.memory-layer.workers.dev";
  const devin = mergeDevinRemoteMcp(undefined, gw);
  assert.equal(devin.mcpServers.wayform.url, `${gw}/mcp`);
  assert.doesNotMatch(JSON.stringify(devin), /headers|mlk_/);
  const agy = mergeAntigravityRemoteMcp(undefined, gw);
  assert.equal(agy.mcpServers.wayform.serverUrl, `${gw}/mcp`);
  assert.doesNotMatch(JSON.stringify(agy), /headers|mlk_/);
});

test("session hook after wayform login sends the keychain Bearer, not a file token", async () => {
  const kc = path.join(os.tmpdir(), `wayform-kc-${Date.now()}.json`);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "wayform-hook-login-"));
  const prevKc = process.env.WAYFORM_KEYCHAIN_FILE;
  process.env.WAYFORM_KEYCHAIN_FILE = kc;
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url, auth: req.headers.authorization ?? "" });
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("BRIEFING FROM KEYCHAIN SESSION");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const gatewayUrl = `http://127.0.0.1:${port}`;
  try {
    saveStoredOAuth(gatewayUrl, { access_token: "oauth_access_from_login" });
    fs.writeFileSync(
      path.join(cwd, ".memorylayer-hook.env"),
      [
        `MEMORYLAYER_GATEWAY_URL=${gatewayUrl}`,
        "MEMORYLAYER_AUTHOR=Dana",
        "MEMORYLAYER_PROJECT=acme-eng",
        "",
      ].join("\n"),
    );
    const stdout = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [hookPath], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "",
          MEMORYLAYER_HOOK_CLIENT: "raw",
          MEMORYLAYER_AUTHOR: "Dana",
          MEMORYLAYER_PROJECT: "acme-eng",
          MEMORYLAYER_GATEWAY_URL: gatewayUrl,
          WAYFORM_KEYCHAIN_FILE: kc,
        },
      });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => {
        out += d;
      });
      child.stderr.on("data", (d) => {
        err += d;
      });
      child.on("error", reject);
      child.on("close", () => {
        if (err) reject(new Error(`hook stderr: ${err}`));
        else resolve(out);
      });
    });
    assert.equal(hits[0]?.auth, "Bearer oauth_access_from_login");
    assert.match(stdout, /BRIEFING FROM KEYCHAIN SESSION/);
    const envFile = fs.readFileSync(
      path.join(cwd, ".memorylayer-hook.env"),
      "utf8",
    );
    assert.doesNotMatch(envFile, /MEMORYLAYER_GATEWAY_TOKEN|mlk_|oauth_access/);
  } finally {
    server.close();
    if (prevKc === undefined) delete process.env.WAYFORM_KEYCHAIN_FILE;
    else process.env.WAYFORM_KEYCHAIN_FILE = prevKc;
    fs.rmSync(kc, { force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("wayform CLI lists login; init --remote never accepts --token/--invite", () => {
  const help = execFileSync(process.execPath, [cliPath, "init", "--help"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });
  assert.doesNotMatch(help, /--token|--invite|mlk_|wfi_/);
  const unknown = (() => {
    try {
      execFileSync(process.execPath, [cliPath, "not-a-command"], {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "" },
      });
      return "";
    } catch (err) {
      return String(err.stderr || err.stdout || err.message);
    }
  })();
  assert.match(unknown, /login/);
});
