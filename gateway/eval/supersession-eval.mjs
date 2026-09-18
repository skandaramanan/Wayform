#!/usr/bin/env node
/**
 * Precision/recall of the evidence supersession judge against hand-labeled
 * production pairs (gateway/eval/supersession-labels.json, 2026-09-18 audit:
 * 13 real replacements among 50 pairs the old fragment judge had linked).
 *
 * EVIDENCE_AUTO_SUPERSEDE may only be turned on when this reports precision
 * >= 0.95 — a false link hides a true fact and no reindex undoes it.
 *
 * Runs the PRODUCTION prompt and parser from dist/ against the live model at
 * temperature 0 (~50 calls, a few thousand neurons of account allocation).
 *
 *   CF_ACCOUNT_ID=... CF_API_TOKEN=$(npx wrangler auth token) \
 *     node eval/supersession-eval.mjs <clone of the memory repo>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildReplacementPrompt,
  parseReplacement,
} from "../dist/gateway/src/supersede.js";

const repo = process.argv[2];
const { CF_ACCOUNT_ID: acct, CF_API_TOKEN: token } = process.env;
if (!repo || !acct || !token) {
  console.error(
    "usage: CF_ACCOUNT_ID=.. CF_API_TOKEN=.. node eval/supersession-eval.mjs <memory-repo-clone>",
  );
  process.exit(2);
}
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const labels = JSON.parse(
  readFileSync(new URL("./supersession-labels.json", import.meta.url), "utf8"),
);

async function gen(prompt) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${MODEL}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt, max_tokens: 160, temperature: 0 }),
    },
  );
  const out = (await res.json()).result?.response;
  return typeof out === "string" ? out : JSON.stringify(out ?? "");
}

let tp = 0;
let fp = 0;
let fn = 0;
let tn = 0;
const misses = [];
for (const p of labels) {
  const raw = readFileSync(join(repo, p.newFile), "utf8");
  const text = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
  const out = await gen(
    buildReplacementPrompt(
      { text, date: p.newDate },
      { body: p.oldFact, date: p.oldDate },
    ),
  );
  const { replaces, evidence } = parseReplacement(out, text);
  const predicted = replaces && p.newDate >= p.oldDate;
  if (predicted && p.replaces) tp++;
  else if (predicted) fp++;
  else if (p.replaces) fn++;
  else tn++;
  if (predicted !== p.replaces) {
    misses.push(
      `${predicted ? "FALSE LINK" : "missed   "}  OLD: ${p.oldFact.slice(0, 90)}\n` +
        `             NEW: ${p.newFact.slice(0, 90)}` +
        (evidence ? `\n             evidence: ${evidence.slice(0, 120)}` : ""),
    );
  }
}
const precision = tp + fp ? tp / (tp + fp) : 1;
const recall = tp + fn ? tp / (tp + fn) : 0;
console.log(misses.join("\n"));
console.log(
  `\n  pairs ${labels.length} | TP ${tp} FP ${fp} FN ${fn} TN ${tn}` +
    `\n  precision ${precision.toFixed(3)}  recall ${recall.toFixed(3)}` +
    `  (gate: precision >= 0.95; baseline fragment judge 0.26)`,
);
