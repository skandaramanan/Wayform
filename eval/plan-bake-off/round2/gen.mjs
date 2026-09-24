// Round 2 plan generation: cold vs wayform, claude -p (sonnet), 4 at a time. node gen.mjs [id]
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
const repo = "/Users/skandaramanan/Documents/MemoryLayer";
const here = process.cwd(); // run from eval/plan-bake-off/round2
mkdirSync(join(here, "plans"), { recursive: true });
mkdirSync(join(here, "transcripts"), { recursive: true });
const { cases } = JSON.parse(readFileSync("rubric.json", "utf8"));
const COLD = (p) => `Write an implementation plan for this task in this repo. Goal, approach, and a checklist of steps with files and tests.\n\nTask: ${p}`;
const WARM = (p) => `Call plan_brief(project="MemoryLayer", prompt=<the task>) first, then write the implementation plan it asks for. Do not call create_plan.\n\nTask: ${p}`;
const cold = join(here, "cold-worktree");
if (!existsSync(cold)) {
  execFileSync("git", ["worktree", "add", "--detach", cold, "HEAD"], { cwd: repo, stdio: "inherit" });
  rmSync(join(cold, ".claude"), { recursive: true, force: true });
}
const LEAK = /[0-9a-f]{8}#[a-z0-9]{4,}|recorded decision|already-known context|session-start briefing|planning memory/i;
const jobs = [];
for (const c of cases) {
  if (process.argv[2] && !process.argv[2].split(",").includes(c.id)) continue;
  jobs.push({ c, arm: "cold" }, { c, arm: "wayform" });
}
const runOne = ({ c, arm }) => new Promise((resolve) => {
  const args = ["-p", arm === "cold" ? COLD(c.task) : WARM(c.task), "--model", "sonnet", "--permission-mode", "plan", "--output-format", "stream-json", "--verbose",
    // Headless -p ends before background agents report back (2026-09-23 first run), so both arms explore inline.
    "--disallowedTools", "Agent,Task",
    ...(arm === "cold" ? ["--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}'] : ["--allowedTools", "mcp__wayform__plan_brief,mcp__wayform__read_plan"])];
  const p = spawn("claude", args, { cwd: arm === "cold" ? cold : repo, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  const t = setTimeout(() => p.kill("SIGTERM"), 15 * 60 * 1000);
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (err += d));
  p.on("close", () => {
    clearTimeout(t);
    writeFileSync(join(here, "transcripts", `${c.id}-${arm}.jsonl`), out);
    const lines = out.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const res = lines.find((l) => l.type === "result");
    // Plan mode writes the full plan to ~/.claude/plans/<slug>.md; the result text is often only a summary.
    const planFiles = lines.flatMap((l) => l.type === "assistant" ? (l.message?.content ?? []) : [])
      .filter((x) => x.type === "tool_use" && ["Write", "Edit"].includes(x.name) && /\/\.claude\/plans\/.+\.md$/.test(x.input?.file_path ?? ""))
      .map((x) => x.input.file_path);
    const pf = planFiles.at(-1);
    let plan = pf && existsSync(pf) ? readFileSync(pf, "utf8") : res?.result ?? `RUN FAILED\n${err.slice(-2000)}`;
    if (pf) writeFileSync(join(here, "transcripts", `${c.id}-${arm}.planfile`), pf);
    const calledBrief = lines.some((l) => l.type === "assistant" && l.message?.content?.some?.((x) => x.type === "tool_use" && x.name === "mcp__wayform__plan_brief"));
    const flags = [];
    if (arm === "cold" && LEAK.test(plan)) flags.push("COLD_LEAK");
    if (arm === "wayform" && !calledBrief) flags.push("NO_PLAN_BRIEF");
    if (!res || res.is_error) flags.push("ERROR");
    writeFileSync(join(here, "plans", `${c.id}-${arm}.md`), plan);
    const cost = res?.total_cost_usd ?? 0;
    console.log(`${c.id} ${arm} ${Math.round((res?.duration_ms ?? 0) / 1000)}s $${cost.toFixed(2)} ${flags.join(",")}`);
    resolve(cost);
  });
});
const costs = [];
const q = [...jobs];
await Promise.all(Array.from({ length: 4 }, async () => { while (q.length) costs.push(await runOne(q.shift())); }));
console.log(`done ${jobs.length} runs, cost-equivalent $${costs.reduce((a, b) => a + b, 0).toFixed(2)}`);
