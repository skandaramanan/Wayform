// D1Like over node:sqlite with every real migration applied, so plan SQL is
// tested against SQLite itself rather than a hand-written fake.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const norm = (v) =>
  v === undefined ? null : v instanceof ArrayBuffer ? new Uint8Array(v) : v;

export function sqliteD1() {
  const raw = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort())
    raw.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  const stmt = (sql, binds = []) => ({
    bind: (...v) => stmt(sql, v.map(norm)),
    run: async () => {
      const r = raw.prepare(sql).run(...binds);
      return { meta: { changes: Number(r.changes) } };
    },
    all: async () => ({ results: raw.prepare(sql).all(...binds) }),
    first: async () => raw.prepare(sql).get(...binds) ?? null,
  });
  return {
    raw,
    prepare: (sql) => stmt(sql),
    async batch(stmts) {
      raw.exec("BEGIN");
      try {
        const out = [];
        for (const s of stmts) out.push(await s.run());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
