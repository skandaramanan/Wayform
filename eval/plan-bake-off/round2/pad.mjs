// Padded twins for the calibration probe: same plan, ~40% more words, no new content. node pad.mjs
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
mkdirSync("padded", { recursive: true });
for (const f of ["check-prod-kv-value-cold.md", "commit-personal-editor-settings-wayform.md"]) {
  const src = readFileSync(`stripped/${f}`, "utf8");
  const words = src.split(/\s+/).length;
  const r = spawnSync("claude", ["-p", `Rewrite the plan below so it is about 40% longer (target ${Math.round(words * 1.4)} words). Only restate, elaborate and add transitions for points it already makes. Do NOT add any new step, file, risk, decision, alternative, test or fact, and do not remove anything. Keep its structure and headings. Output only the rewritten plan.\n\n${src}`,
    "--model", "sonnet", "--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--tools", ""],
    { cwd: "empty", encoding: "utf8", maxBuffer: 16 << 20, timeout: 300000 });
  writeFileSync(`padded/${f}`, r.stdout.trim() + "\n");
  console.log(f, words, "->", r.stdout.split(/\s+/).length, "words");
}
