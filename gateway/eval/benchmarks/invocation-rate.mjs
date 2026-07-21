#!/usr/bin/env node
/**
 * Invocation-rate harness driver (remote MCP).
 *
 * Preferred: headless `claude -p` with Wayform remote MCP attached (see
 * recorded method 16fa6187). This script prints the prompt set and, when
 * CLAUDE_BIN is set and executable, runs each should_trigger / should_not
 * prompt once and greps the transcript for tool names (best-effort).
 *
 * Usage:
 *   node gateway/eval/benchmarks/invocation-rate.mjs
 *   CLAUDE_BIN=claude node gateway/eval/benchmarks/invocation-rate.mjs --runs 3
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const root = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(
  readFileSync(join(root, "invocation-prompts.json"), "utf8"),
);
const runs = Number(
  process.argv.includes("--runs")
    ? process.argv[process.argv.indexOf("--runs") + 1]
    : "1",
);

console.log(
  JSON.stringify(
    {
      method:
        "Headless client with remote MCP attached; ≥3 runs per prompt; trigger rate",
      fixture_count: {
        should_trigger: fixtures.should_trigger.length,
        should_not_trigger: fixtures.should_not_trigger.length,
      },
      note: "Soft-write phrasing is the measured weak spot (~64% baseline).",
    },
    null,
    2,
  ),
);

const claude = process.env.CLAUDE_BIN;
if (!claude) {
  console.log(
    JSON.stringify({
      status: "fixtures_only",
      hint: "Set CLAUDE_BIN to a headless CLI with remote Wayform MCP to auto-run.",
    }),
  );
  process.exit(0);
}

function ranTool(output, name) {
  return (
    output.includes(name) ||
    output.includes(`"name":"${name}"`) ||
    output.includes(`'${name}'`)
  );
}

const results = [];
for (const item of [
  ...fixtures.should_trigger.map((x) => ({ ...x, kind: "should_trigger" })),
  ...fixtures.should_not_trigger.map((x) => ({
    ...x,
    kind: "should_not_trigger",
  })),
]) {
  let hits = 0;
  for (let i = 0; i < runs; i++) {
    const r = spawnSync(claude, ["-p", item.prompt], {
      encoding: "utf8",
      env: process.env,
      timeout: 180_000,
    });
    const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
    const expect = item.expect ?? [];
    const none = item.expect_none_of ?? [];
    const ok =
      item.kind === "should_trigger"
        ? expect.some((t) => ranTool(out, t))
        : none.every((t) => !ranTool(out, t));
    if (ok) hits++;
  }
  results.push({
    id: item.id,
    kind: item.kind,
    trigger_rate: hits / runs,
    runs,
  });
}
console.log(JSON.stringify({ results }, null, 2));
