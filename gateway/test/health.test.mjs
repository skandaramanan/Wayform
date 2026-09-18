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
function env({ rows, stuck = 0, leaked = 0, lastRun }) {
  const stmt = (sql) => ({
    bind: () => stmt(sql),
    all: async () => ({ results: rows }),
    first: async () => ({ n: sql.includes("JOIN plan") ? leaked : stuck }),
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
    [env({ rows, leaked: 1, lastRun: now() }), "shippedPlansUnindexed"],
    [env({ rows, lastRun: "2026-01-01T00:00:00Z" }), "cronRanLastHour"],
    [env({ rows }), "cronRanLastHour"],
  ]) {
    const res = await deepHealth(e);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).checks[check], false, check);
  }
});

test("shippedPlansUnindexed runs real SQL against the real schema", async () => {
  const { sqliteD1 } = await import("./sqlite-d1.mjs");
  const db = sqliteD1();
  db.raw.exec(
    "INSERT INTO plan (space,id,project,seq,title,author,state,version,rev,runs,created,updated) " +
      "VALUES ('s','p1','proj',1,'t','a','shipped',1,4,1,'x','x')," +
      "('s','p2','proj',2,'t','a','building',1,3,1,'x','x')",
  );
  const put = (id) =>
    db.raw.exec(
      "INSERT INTO docs (id,space,project,kind,tier,body,source_file,source_author,source_ts,created_at,source_id) " +
        `VALUES ('${id}','s','proj','plan','normal','b','plans/proj/x','a','x','x','${id}')`,
    );
  put("plan:p2");
  const e = (d) => ({ DB: d, ROUTING: { get: async () => now() } });
  let body = await (await deepHealth(e(db))).json();
  assert.equal(body.checks.shippedPlansUnindexed, true);
  put("plan:p1");
  body = await (await deepHealth(e(db))).json();
  assert.equal(body.checks.shippedPlansUnindexed, false);
});
