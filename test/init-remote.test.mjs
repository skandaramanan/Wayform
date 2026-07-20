import { test } from "node:test";
import assert from "node:assert/strict";
import { registerClaudeCodeMcp, joinGateway } from "../dist/init-remote.js";

test("registerClaudeCodeMcp invokes claude mcp add with scope local + bearer header", () => {
  let seen;
  const run = (cmd, args) => {
    seen = { cmd, args };
  };
  const res = registerClaudeCodeMcp("https://gw.example.com", "mlk_x", run);
  assert.equal(res.ok, true);
  assert.equal(seen.cmd, "claude");
  assert.deepEqual(seen.args, [
    "mcp",
    "add",
    "--transport",
    "http",
    "--scope",
    "local",
    "wayform",
    "https://gw.example.com/mcp",
    "--header",
    "Authorization: Bearer mlk_x",
  ]);
});

test("registerClaudeCodeMcp fails open to a printable command when claude is absent", () => {
  const run = () => {
    const e = new Error("spawn claude ENOENT");
    e.code = "ENOENT";
    throw e;
  };
  const res = registerClaudeCodeMcp("https://gw", "mlk_x", run);
  assert.equal(res.ok, false);
  assert.match(res.command, /^claude mcp add --transport http --scope local /);
  // Header must be shell-quoted or the printed command splits into three args on paste.
  assert.match(res.command, /--header "Authorization: Bearer mlk_x"/);
});

test("runInitRemote hard-fails outside a git repo before writing anything", async (t) => {
  const { runInitRemote } = await import("../dist/init-remote.js");
  const { mkdtempSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "wayform-nogit-"));
  const prev = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(
    runInitRemote(["--gateway", "https://gw", "--token", "mlk_x"]),
    /Not a git repository/,
  );
  assert.deepEqual(readdirSync(dir), []);
});

test("joinGateway exchanges an invite for a token via POST /join", async () => {
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), body: JSON.parse(init.body) };
    return new Response(
      JSON.stringify({ token: "mlk_fresh", member: { space: "team-a" } }),
      { status: 200 },
    );
  };
  const token = await joinGateway(
    "https://gw.test",
    "wfi_abc",
    "David",
    "d@spear.ai",
    fetchImpl,
  );
  assert.equal(token, "mlk_fresh");
  assert.equal(captured.url, "https://gw.test/join");
  assert.deepEqual(captured.body, {
    invite: "wfi_abc",
    author: "David",
    authorEmail: "d@spear.ai",
  });
});

test("joinGateway surfaces the gateway's error body", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ error: "invalid or expired invite" }), {
      status: 400,
    });
  await assert.rejects(
    () => joinGateway("https://gw.test", "wfi_bad", "A", "a@x.io", fetchImpl),
    /invite join failed \(400\)/,
  );
});
