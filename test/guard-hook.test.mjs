import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  GUARDED_TOOLS,
  guardEnabled,
  summarizeAction,
} from "../dist/guard-hook.js";

const run = promisify(execFile);

test("only mutating tools are guarded", () => {
  assert.ok(GUARDED_TOOLS.has("Edit"));
  assert.ok(GUARDED_TOOLS.has("Write"));
  assert.ok(GUARDED_TOOLS.has("Bash"));
  for (const t of ["Read", "Grep", "Glob", "WebFetch", "TodoWrite"]) {
    assert.equal(GUARDED_TOOLS.has(t), false, t);
  }
});

test("guardEnabled is on by default and off only for WAYFORM_GUARD=off", () => {
  assert.equal(guardEnabled({}), true);
  assert.equal(guardEnabled({ WAYFORM_GUARD: "ask" }), true);
  assert.equal(guardEnabled({ WAYFORM_GUARD: "off" }), false);
  assert.equal(guardEnabled({ WAYFORM_GUARD: " OFF " }), false);
});

test("summarizeAction describes an edit by path and new content", () => {
  const s = summarizeAction("Edit", {
    file_path: "/repo/docker-compose.yml",
    new_string: "image: postgres:16",
  });
  assert.match(s, /Edit/);
  assert.match(s, /docker-compose\.yml/);
  assert.match(s, /postgres:16/);
});

test("summarizeAction describes a bash command", () => {
  const s = summarizeAction("Bash", { command: "npm i pg" });
  assert.match(s, /Bash/);
  assert.match(s, /npm i pg/);
});

test("summarizeAction is bounded so a huge edit cannot blow the request", () => {
  const s = summarizeAction("Write", {
    file_path: "/repo/big.ts",
    content: "x".repeat(50_000),
  });
  assert.ok(s.length <= 2000, `got ${s.length}`);
});

test("summarizeAction is empty for an unusable payload", () => {
  assert.equal(summarizeAction("Edit", null), "");
  assert.equal(summarizeAction("Edit", {}), "");
});

/** Feed stdin to `node dist/guard-hook.js` and capture stdout. */
async function runHook(payload, env = {}) {
  const child = run("node", ["dist/guard-hook.js"], {
    env: { ...process.env, MEMORYLAYER_HOOK_CLIENT: "claude-code", ...env },
  });
  child.child.stdin.end(JSON.stringify(payload));
  const { stdout } = await child;
  return stdout;
}

test("a non-mutating tool is a silent no-op", async () => {
  const out = await runHook({ tool_name: "Read", tool_input: { file_path: "a.ts" } });
  assert.equal(out.trim(), "{}");
});

test("WAYFORM_GUARD=off is a silent no-op", async () => {
  const out = await runHook(
    { tool_name: "Edit", tool_input: { file_path: "a.ts", new_string: "x" } },
    { WAYFORM_GUARD: "off" },
  );
  assert.equal(out.trim(), "{}");
});

test("an unconfigured gateway fails open to a no-op", async () => {
  const out = await runHook(
    { tool_name: "Edit", tool_input: { file_path: "a.ts", new_string: "x" } },
    { MEMORYLAYER_GATEWAY_URL: "" },
  );
  assert.equal(out.trim(), "{}");
});

test("unparseable stdin fails open to a no-op", async () => {
  const child = run("node", ["dist/guard-hook.js"], {
    env: { ...process.env, MEMORYLAYER_HOOK_CLIENT: "claude-code" },
  });
  child.child.stdin.end("not json");
  const { stdout } = await child;
  assert.equal(stdout.trim(), "{}");
});
