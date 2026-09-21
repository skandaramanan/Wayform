#!/usr/bin/env node
// Phase 2 exit gate (plan #11): for each case, produce a COLD plan (no wayform
// MCP) and a WAYFORM plan (plan_brief first), side by side, for a human to
// read. No LLM judge: the gate is "would you rather start from this one".
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
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

// The cold arm must be genuinely cold, and --strict-mcp-config is NOT enough:
// it drops MCP servers but NOT hooks, and `.claude/settings.json` wires
// `wayform hook` into SessionStart and UserPromptSubmit. The 2026-09-21 first
// run proved it — every cold plan quoted recorded decisions ("no REST endpoint
// until Phase 3"), so the baseline was Wayform against itself. The cold arm
// therefore runs in a throwaway git worktree of HEAD with `.claude/` removed:
// same source, same CLAUDE.md, no hooks, no MCP config, and no `.wayform/`
// plan mirror (git-ignored, so a worktree never has it).
//
// The wayform arm must be explicitly allowed the tool. A headless session
// cannot answer a permission prompt, and plan_brief is new, so it is not in
// anyone's permissions.allow yet: the 2026-09-21 first run silently produced
// five "I couldn't call plan_brief" transcripts that looked like plans.
const ALLOWED = ["mcp__wayform__plan_brief", "mcp__wayform__read_plan"].join(
  ",",
);
const repo = join(here, "..", "..");

function coldWorktree() {
  const dir = join(tmpdir(), `wayform-bakeoff-cold-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  execFileSync("git", ["worktree", "add", "--detach", dir, "HEAD"], {
    cwd: repo,
    stdio: "inherit",
  });
  rmSync(join(dir, ".claude"), { recursive: true, force: true });
  return dir;
}

function removeWorktree(dir) {
  execFileSync("git", ["worktree", "remove", "--force", dir], {
    cwd: repo,
    stdio: "inherit",
  });
}

const run = (prompt, allowWayform, cwd) =>
  execFileSync(
    "claude",
    [
      "-p",
      prompt,
      ...(allowWayform
        ? ["--allowedTools", ALLOWED]
        : ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']),
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    },
  );

const only =
  process.argv[2] && process.argv[2] !== "all" ? process.argv[2] : null;
const onlyArm = process.argv[3] ?? null; // "cold" | "wayform" — re-run one arm
const cold = onlyArm === "wayform" ? null : coldWorktree();
for (const c of cases) {
  if (only && c.id !== only) continue;
  for (const [label, prompt, mcp] of [
    ["cold", COLD(c.prompt), false],
    ["wayform", WARM(c.prompt), true],
  ]) {
    if (onlyArm && label !== onlyArm) continue;
    process.stderr.write(`${c.id} · ${label}…\n`);
    const started = Date.now();
    let body;
    try {
      body = run(prompt, mcp, mcp ? repo : cold);
    } catch (e) {
      body = `RUN FAILED\n\n${e.stdout ?? ""}\n${e.stderr ?? e.message}`;
    }
    // The tell is store-only content: a fact id (8 hex + #suffix) or briefing
    // phrasing. NOT the words "fact id" or "plan #N" — those appear in the
    // repo's own source comments and schemas, and flagged two clean runs.
    const LEAKED =
      /[0-9a-f]{8}#[a-z0-9]{4,}|recorded decision|already-known context|session-start briefing/i;
    if (!mcp && LEAKED.test(body)) {
      body = `RUN INVALID — the cold arm quoted the store; hooks or the plan mirror leaked in.\n\n${body}`;
      process.exitCode = 1;
    }
    if (
      mcp &&
      /couldn.t (run|call)|blocked because|permission/i.test(body.slice(0, 600))
    ) {
      body = `RUN INVALID — plan_brief was not callable; this arm measured nothing.\n\n${body}`;
      process.exitCode = 1;
    }
    writeFileSync(
      join(out, `${c.id}-${label}.md`),
      `<!-- ${label} · ${Math.round((Date.now() - started) / 1000)}s -->\n\n${body}`,
    );
  }
}
if (cold) removeWorktree(cold);
process.stderr.write(`\nWrote ${out}. Read the pairs. Score in README.md.\n`);
