#!/usr/bin/env node
// Phase 2 exit gate (plan #11): for each case, produce a COLD plan (no wayform
// MCP) and a WAYFORM plan (plan_brief first), side by side, for a human to
// read. No LLM judge: the gate is "would you rather start from this one".
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
mkdirSync(out, { recursive: true });
const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));

const COLD = (p) =>
  `Write an implementation plan for this task in this repo. ` +
  `Goal, approach, and a checklist of steps with files and tests.\n\nTask: ${p}`;
const WARM = (p) =>
  `Call plan_brief(project="MemoryLayer", prompt=<the task>) first, then write ` +
  `the implementation plan it asks for. Do not call create_plan.\n\nTask: ${p}`;

// The cold arm must be genuinely cold: --strict-mcp-config with an empty
// server set drops the project's own wayform MCP config, which would
// otherwise inject the session-start briefing and contaminate the baseline.
const run = (prompt, allowWayform) =>
  execFileSync(
    "claude",
    [
      "-p",
      prompt,
      ...(allowWayform
        ? []
        : ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']),
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 15 * 60 * 1000 },
  );

const only = process.argv[2];
for (const c of cases) {
  if (only && c.id !== only) continue;
  for (const [label, prompt, mcp] of [
    ["cold", COLD(c.prompt), false],
    ["wayform", WARM(c.prompt), true],
  ]) {
    process.stderr.write(`${c.id} · ${label}…\n`);
    const started = Date.now();
    let body;
    try {
      body = run(prompt, mcp);
    } catch (e) {
      body = `RUN FAILED\n\n${e.stdout ?? ""}\n${e.stderr ?? e.message}`;
    }
    writeFileSync(
      join(out, `${c.id}-${label}.md`),
      `<!-- ${label} · ${Math.round((Date.now() - started) / 1000)}s -->\n\n${body}`,
    );
  }
}
process.stderr.write(`\nWrote ${out}. Read the pairs. Score in README.md.\n`);
