// Strip arm provenance from plans, keep substance. Writes stripped/<file> and strip-diff.txt (the published diff).
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
mkdirSync("stripped", { recursive: true });
const RULES = [
  [/<!--[\s\S]*?-->/g, ""],
  [/\(?\b[0-9a-f]{8}#[a-z0-9]{4,}\b\)?/g, ""],                 // fact ids
  [/^.*\b(plan_brief|plan brief|the brief|briefing|Wayform MCP|wayform__|inherits?:|Inherited|Standing rules section|near-miss(es)?)\b.*$/gim, ""],
  [/\b(recorded|stored|team'?s?|logged|prior|existing|standing|past)\s+(team\s+)?(decision|rule|constraint)s?\b/gi, "$3"],
  [/\bper (the )?(team|memory|store)\b/gi, "per"],
  [/\b(team memory|planning memory|shared memory|the store|the ledger)\b/gi, "project notes"],
  [/\bApplies when:[^\n]*/g, ""],
  [/^\s*[-*]\s*$/gm, ""],
  [/\n{3,}/g, "\n\n"],
];
let diff = "";
for (const f of readdirSync("plans").sort()) {
  const src = readFileSync(`plans/${f}`, "utf8");
  let out = src;
  for (const [re, rep] of RULES) {
    out = out.replace(re, (m, ...g) => {
      const r = typeof rep === "string" ? rep.replace(/\$(\d)/g, (_, i) => g[i - 1] ?? "") : rep;
      if (m.trim()) diff += `${f}: ${JSON.stringify(m.trim().slice(0, 160))} -> ${JSON.stringify(r)}\n`;
      return r;
    });
  }
  writeFileSync(`stripped/${f}`, out.trim() + "\n");
}
writeFileSync("strip-diff.txt", diff);
// Allowlist grep: anything still naming the tool or memory is reported, not silently passed.
const LEFT = /plan_brief|brief\b|wayform__|[0-9a-f]{8}#|memory|recorded|inherit/i;
for (const f of readdirSync("stripped").sort()) {
  const hits = readFileSync(`stripped/${f}`, "utf8").split("\n").filter((l) => LEFT.test(l));
  if (hits.length) console.log(`RESIDUE ${f}:\n  ` + hits.map((h) => h.slice(0, 160)).join("\n  "));
}
console.log(`stripped ${readdirSync("stripped").length} plans; ${diff.split("\n").length - 1} edits logged in strip-diff.txt`);
