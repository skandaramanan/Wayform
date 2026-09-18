// /health?deep=1 fails on the production states that shipped green on
// 2026-09-18: mis-decoded vectors, and a cron that never finishes a pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deepHealth, CRON_LAST_RUN_KEY } from "../dist/gateway/src/health.js";

// D1 hands BLOBs back as plain byte Arrays; encode the way production stores.
const blob = (seed) => {
  const v = Array.from({ length: 768 }, (_, i) => Math.sin(seed * 1000 + i));
  return [...new Uint8Array(new Float32Array(v).buffer)];
};
function env({ rows, stuck = 0, lastRun }) {
  const stmt = (sql) => ({
    bind: () => stmt(sql),
    all: async () => ({ results: rows }),
    first: async () => ({ n: stuck }),
  });
  const kv = new Map(lastRun ? [[CRON_LAST_RUN_KEY, lastRun]] : []);
  return {
    DB: { prepare: stmt },
    ROUTING: { get: async (k) => kv.get(k) ?? null },
  };
}
const rows = [1, 2, 3].map((s) => ({ id: `d${s}`, embedding: blob(s) }));
const now = () => new Date().toISOString();

test("deep health is ok when vectors decode, cosine matches and the cron finished", async () => {
  const res = await deepHealth(env({ rows, lastRun: now() }));
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
});

test("deep health fails on mis-sized vectors, stuck claims or a stale cron", async () => {
  const wrapped = rows.map((r) => ({
    ...r,
    embedding: r.embedding.slice(0, 400),
  }));
  for (const [e, check] of [
    [env({ rows: wrapped, lastRun: now() }), "embeddingsDecode"],
    [env({ rows, stuck: 2, lastRun: now() }), "noStuckPending"],
    [env({ rows, lastRun: "2026-01-01T00:00:00Z" }), "cronRanLastHour"],
    [env({ rows }), "cronRanLastHour"],
  ]) {
    const res = await deepHealth(e);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).checks[check], false, check);
  }
});
