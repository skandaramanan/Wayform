#!/usr/bin/env node
/**
 * Plan-brief recall benchmark (plan #12, Task 4).
 *
 * The bake-off costs ten headless agent sessions, is length-confounded, and
 * has four of five cases at ceiling — one free parameter for seven strategies.
 * This measures the one thing that actually failed instead: given a task whose
 * correct design depends on a KNOWN recorded fact, does the brief put that
 * fact in front of the agent?
 *
 * Deterministic, no LLM judge, no agent sessions. One plan_brief call per case
 * against the DEPLOYED gateway — the same path a real client takes, because
 * five bugs in this project passed a green suite and were only caught by
 * running the tool.
 *
 *   node eval/brief-recall/run.mjs [case-id]
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHookEnv, loadConfig } from "../../dist/config.js";
import { oauthFetch } from "../../dist/oauth-session.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8"));

process.chdir(repo);
loadHookEnv();
const cfg = loadConfig();
const gw = cfg.gatewayUrl;
if (!gw) {
  console.error("no gateway configured — run `wayform init --remote` first");
  process.exit(2);
}

const PROJECT = "MemoryLayer";

async function brief(prompt) {
  const res = await oauthFetch(gw, `${gw}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "plan_brief",
        arguments: { project: PROJECT, prompt },
      },
    }),
  });
  const body = await res.json();
  if (body.result?.isError) throw new Error(body.result.content[0].text);
  const text = body.result?.content?.[0]?.text;
  if (typeof text !== "string")
    throw new Error(JSON.stringify(body).slice(0, 300));
  return text;
}

// A deploy takes a few seconds to reach every colo. The first benchmark run
// after `npm run deploy` on 2026-09-21 reported 3 false misses — the first
// three cases hit the old version — and the number looked like a retrieval
// result. Warm up and discard.
try {
  await brief("warmup");
} catch {
  /* the real calls below report their own errors */
}

const only = process.argv[2];
const rows = [];
for (const c of cases) {
  if (only && c.id !== only) continue;
  let hit = false;
  let section = "";
  let err = null;
  try {
    const text = await brief(c.prompt);
    // "a|b" — any of several facts carrying the same content counts, the
    // convention gateway/eval/cases.json already uses for duplicates.
    const found = c.mustSurface.split("|").find((id) => text.includes(id));
    hit = found !== undefined;
    if (hit) {
      // Which section carried it — a canon dump and a query match are
      // different mechanisms and the distinction is the whole experiment.
      const idx = text.indexOf(found);
      const heads = [...text.slice(0, idx).matchAll(/^## (.+)$/gm)];
      section = heads.length ? heads[heads.length - 1][1] : "(no heading)";
    }
  } catch (e) {
    err = e.message.slice(0, 80);
  }
  rows.push({ id: c.id, tier: c.tier ?? "?", hit, section, err });
  process.stderr.write(`${hit ? "HIT " : err ? "ERR " : "miss"} ${c.id}\n`);
}

const hits = rows.filter((r) => r.hit).length;
const errs = rows.filter((r) => r.err).length;
console.log(`\n| case | tier | surfaced | section |`);
console.log(`|---|---|---|---|`);
for (const r of rows) {
  console.log(
    `| ${r.id} | ${r.tier} | ${r.err ? "ERROR: " + r.err : r.hit ? "yes" : "**no**"} | ${r.section || "—"} |`,
  );
}
const byTier = (t) => {
  const g = rows.filter((r) => r.tier === t);
  return g.length ? `${g.filter((r) => r.hit).length}/${g.length}` : "—";
};
console.log(
  `\ncanon ${byTier("canon")} · normal ${byTier("normal")} — a canon dump makes canon cases trivial, so the normal column is the live signal.`,
);
console.log(
  `\n**recall ${hits}/${rows.length}**${errs ? ` (${errs} errored)` : ""}`,
);
if (errs) process.exitCode = 2;
