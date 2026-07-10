#!/usr/bin/env node
/**
 * Manual, recommend-only τ calibration (roadmap §7). Reads a retrieval_log
 * export (JSON from GET /admin/retrieval-log), LLM-judges each injected fact
 * for relevance to its query, and prints a bucket table + a recommended τ.
 * A human edits the TAU constant in gateway/src/rank.ts to apply — nothing
 * here writes to production.
 *
 * Usage:
 *   node eval/calibrate-tau.mjs <export.json> [precisionTarget=0.9]
 * Env: CF_ACCOUNT_ID, CF_API_TOKEN (Workers AI REST; free tier).
 */
import { readFileSync } from "node:fs";
import { recommendTau } from "../dist/gateway/src/eval-golden.js";

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

async function judgeRelevant(query, body) {
  const prompt =
    `Is the FACT relevant to answering the QUERY? Output ONLY JSON ` +
    `{"relevant":true|false}.\nQUERY: ${query}\nFACT: ${body}`;
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/ai/run/${MODEL}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.CF_API_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt }),
    },
  );
  const out = await res.json();
  try {
    const text = out.result?.response ?? "";
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]).relevant === true : false;
  } catch {
    return false;
  }
}

async function main() {
  const [file, targetArg] = process.argv.slice(2);
  if (!file) {
    console.error("usage: node eval/calibrate-tau.mjs <export.json> [target]");
    process.exit(1);
  }
  const target = Number(targetArg) || 0.9;
  const { rows } = JSON.parse(readFileSync(file, "utf8"));

  const judged = [];
  let injectedCount = 0;
  let silentCount = 0;
  for (const row of rows) {
    if (!row.injected) {
      silentCount++;
      continue;
    }
    injectedCount++;
    for (const r of row.returned ?? []) {
      // The export carries id + score; body is looked up by the operator if
      // needed. Here we judge on the query alone when body is absent.
      const relevant = await judgeRelevant(row.query, r.body ?? r.id);
      judged.push({ score: r.score, relevant });
    }
  }

  const { tau, precision, buckets } = recommendTau(judged, target);
  console.log("\nscore bucket        n   relevant  precision");
  for (const b of buckets) {
    const p = b.n ? (b.relevant / b.n).toFixed(2) : "—";
    console.log(
      `[${b.lo.toFixed(3)}, ${b.hi.toFixed(3)})  ${String(b.n).padStart(3)}   ${String(b.relevant).padStart(6)}     ${p}`,
    );
  }
  const total = injectedCount + silentCount;
  const irrelevant = judged.filter((j) => !j.relevant).length;
  console.log(
    `\nsilence rate: ${total ? (silentCount / total).toFixed(2) : "—"} ` +
      `| unnecessary-injection rate: ${judged.length ? (irrelevant / judged.length).toFixed(2) : "—"}`,
  );
  console.log(
    tau === null
      ? `\nNo τ reaches precision ${target}. Widen the sample or lower the target.`
      : `\nRecommended τ = ${tau} (precision ${precision.toFixed(2)} at that floor). ` +
          `Edit TAU in gateway/src/rank.ts to apply.`,
  );
}

main();
