import { test } from "node:test";
import assert from "node:assert/strict";
import { registerClaudeCodeMcp } from "../dist/init-remote.js";

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
  assert.match(res.command, /Authorization: Bearer mlk_x/);
});
