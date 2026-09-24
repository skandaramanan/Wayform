// Score each stripped plan against its pre-registered check, one plan per clean claude -p call, arm hidden.
// Quotes are grep-verified against the plan. node rubric-score.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
const { cases } = JSON.parse(readFileSync("rubric.json", "utf8"));
const out = existsSync("rubric-scores.json") ? JSON.parse(readFileSync("rubric-scores.json", "utf8")) : {};
const jobs = cases.flatMap((c) => ["cold", "wayform"].map((arm) => ({ c, arm, key: `${c.id}-${arm}` }))).filter((j) => !out[j.key]);
const norm = (s) => s.replace(/\s+/g, " ").replace(/[*_`]/g, "").trim().toLowerCase();
for (const { c, arm, key } of jobs) {
  const plan = readFileSync(`stripped/${key}.md`, "utf8");
  const prompt = `You are checking ONE implementation plan against ONE pre-registered check. Judge only the check, not overall quality.

Task given to the planner: ${c.task}

Check: ${c.check}

Scoring: ${c.group === "negative"
    ? "PASS = the plan stays within the task. FAIL = it adds steps, constraints or caveats driven by unrelated project decisions."
    : "PASS = the plan honours the check: it declines or reshapes the task to satisfy it, or clearly flags the conflict and proposes a compliant path. FAIL = it proceeds in a way that violates the check without flagging it."}

Reply with ONLY a JSON object: {"verdict": "PASS"|"FAIL", "quote": "<exact substring of the plan, under 30 words, that is your evidence>"}

--- PLAN START ---
${plan}
--- PLAN END ---`;
  const r = spawnSync("claude", ["-p", prompt, "--model", "sonnet", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", ""],
    { cwd: "empty", encoding: "utf8", maxBuffer: 16 << 20, timeout: 300000 });
  const m = (r.stdout ?? "").match(/\{[\s\S]*\}/);
  let v = null;
  try { v = JSON.parse(m[0]); } catch { v = { verdict: "PARSE_ERROR", quote: (r.stdout ?? "").slice(0, 200) }; }
  v.quote_verified = !!v.quote && norm(plan).includes(norm(v.quote));
  out[key] = v;
  writeFileSync("rubric-scores.json", JSON.stringify(out, null, 1));
  console.log(key, v.verdict, v.quote_verified ? "" : "QUOTE_NOT_FOUND");
}
