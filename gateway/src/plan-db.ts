/**
 * D1 projection of the plan ledger (migration 0007). Everything here is
 * derivable from plans/<project>/<id>/ event files via plan-core's
 * foldEvents; see rebuildPlan in plans.ts.
 */
import type { D1Like, D1Stmt } from "./index-db.js";
import { slug } from "../../src/slug.js";
import type {
  DecisionRole,
  PlanBody,
  PlanMeta,
  PlanState,
  PlanStep,
} from "./plan-core.js";

export interface PlanRun {
  run: number;
  agent: string;
  started: string;
  ended: string | null;
  outcome: string | null;
  commitSha: string | null;
}

const PLAN_COLS =
  "id, project, seq, title, repo, branch, author, state, version, rev, runs, superseded_by, created, updated";

function rowToMeta(r: Record<string, unknown>): PlanMeta {
  return {
    id: r.id as string,
    project: r.project as string,
    seq: Number(r.seq),
    title: r.title as string,
    repo: (r.repo as string | null) ?? null,
    branch: (r.branch as string | null) ?? null,
    author: r.author as string,
    state: r.state as PlanState,
    version: Number(r.version),
    rev: Number(r.rev),
    runs: Number(r.runs),
    supersededBy: (r.superseded_by as string | null) ?? null,
    created: r.created as string,
    updated: r.updated as string,
  };
}

/** Next #N for (space, project). Atomic: one UPSERT … RETURNING. */
export async function nextSeq(
  db: D1Like,
  space: string,
  project: string,
): Promise<number> {
  const row = await db
    .prepare(
      "INSERT INTO plan_counter (space, project, last_seq) VALUES (?, ?, 1) " +
        "ON CONFLICT (space, project) DO UPDATE SET last_seq = last_seq + 1 " +
        "RETURNING last_seq",
    )
    .bind(space, slug(project))
    .first();
  return Number(row?.last_seq);
}

/** Raise the counter to at least `seq` (rebuild). Never lowers it. */
export async function bumpCounter(
  db: D1Like,
  space: string,
  project: string,
  seq: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO plan_counter (space, project, last_seq) VALUES (?, ?, ?) " +
        "ON CONFLICT (space, project) DO UPDATE SET last_seq = MAX(last_seq, excluded.last_seq)",
    )
    .bind(space, slug(project), seq)
    .run();
}

/**
 * Project one step. `prevRev` is the rev the step was computed from (null for
 * create). One batch = one transaction: every child row is guarded on the
 * plan still being at `prevRev`, and the plan row is written LAST, so a lost
 * race writes nothing at all. Returns false when the race was lost.
 */
export async function applyStep(
  db: D1Like,
  space: string,
  prevRev: number | null,
  s: PlanStep,
): Promise<boolean> {
  const m = s.meta;
  const guard =
    prevRev === null
      ? "NOT EXISTS (SELECT 1 FROM plan WHERE space = ? AND id = ?)"
      : "EXISTS (SELECT 1 FROM plan WHERE space = ? AND id = ? AND rev = ?)";
  const g = prevRev === null ? [space, m.id] : [space, m.id, prevRev];
  const stmts: D1Stmt[] = [];
  if (s.body) {
    stmts.push(
      db
        .prepare(
          "INSERT OR REPLACE INTO plan_body (space, plan_id, version, markdown, author, ts) " +
            `SELECT ?, ?, ?, ?, ?, ? WHERE ${guard}`,
        )
        .bind(
          space,
          m.id,
          s.body.version,
          s.body.markdown,
          s.body.author,
          s.body.ts,
          ...g,
        ),
    );
  }
  for (const l of s.links) {
    stmts.push(
      db
        .prepare(
          "INSERT OR IGNORE INTO plan_decision (space, plan_id, fact_id, role) " +
            `SELECT ?, ?, ?, ? WHERE ${guard}`,
        )
        .bind(space, m.id, l.factId, l.role, ...g),
    );
  }
  if (s.runEnd) {
    stmts.push(
      db
        .prepare(
          "UPDATE plan_run SET ended = ?, outcome = ?, commit_sha = ? " +
            `WHERE space = ? AND plan_id = ? AND run = ? AND ${guard}`,
        )
        .bind(
          s.runEnd.ts,
          s.runEnd.outcome,
          s.runEnd.commitSha,
          space,
          m.id,
          s.runEnd.run,
          ...g,
        ),
    );
  }
  if (s.runStart) {
    stmts.push(
      db
        .prepare(
          "INSERT OR REPLACE INTO plan_run (space, plan_id, run, agent, started) " +
            `SELECT ?, ?, ?, ?, ? WHERE ${guard}`,
        )
        .bind(
          space,
          m.id,
          s.runStart.run,
          s.runStart.agent,
          s.runStart.ts,
          ...g,
        ),
    );
  }
  stmts.push(
    prevRev === null
      ? db
          .prepare(
            `INSERT INTO plan (space, ${PLAN_COLS}) ` +
              "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
          )
          .bind(
            space,
            m.id,
            m.project,
            m.seq,
            m.title,
            m.repo,
            m.branch,
            m.author,
            m.state,
            m.version,
            m.rev,
            m.runs,
            m.supersededBy,
            m.created,
            m.updated,
          )
      : db
          .prepare(
            "UPDATE plan SET title = ?, state = ?, version = ?, rev = ?, runs = ?, " +
              "superseded_by = ?, updated = ? WHERE space = ? AND id = ? AND rev = ?",
          )
          .bind(
            m.title,
            m.state,
            m.version,
            m.rev,
            m.runs,
            m.supersededBy,
            m.updated,
            space,
            m.id,
            prevRev,
          ),
  );
  const res = (await db.batch(stmts)) as { meta?: { changes?: number } }[];
  return (res[res.length - 1]?.meta?.changes ?? 0) > 0;
}

/** Delete every row of one plan (rebuild starts from nothing). */
export async function clearPlan(
  db: D1Like,
  space: string,
  planId: string,
): Promise<void> {
  await db.batch(
    ["plan_body", "plan_decision", "plan_run"]
      .map((t) =>
        db
          .prepare(`DELETE FROM ${t} WHERE space = ? AND plan_id = ?`)
          .bind(space, planId),
      )
      .concat(
        db
          .prepare("DELETE FROM plan WHERE space = ? AND id = ?")
          .bind(space, planId),
      ),
  );
}

/** "#48" or "48" → by number within the project; anything else → by id. */
export async function getPlan(
  db: D1Like,
  space: string,
  project: string,
  ref: string,
): Promise<PlanMeta | null> {
  const n = ref.trim().match(/^#?(\d+)$/);
  const row = n
    ? await db
        .prepare(
          `SELECT ${PLAN_COLS} FROM plan WHERE space = ? AND project = ? AND seq = ?`,
        )
        .bind(space, slug(project), Number(n[1]))
        .first()
    : await db
        .prepare(
          `SELECT ${PLAN_COLS} FROM plan WHERE space = ? AND project = ? AND id = ?`,
        )
        .bind(space, slug(project), ref.trim())
        .first();
  return row ? rowToMeta(row) : null;
}

/** Newest first. */
export async function listPlans(
  db: D1Like,
  space: string,
  project: string,
  limit = 50,
): Promise<PlanMeta[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PLAN_COLS} FROM plan WHERE space = ? AND project = ? ORDER BY seq DESC LIMIT ?`,
    )
    .bind(space, slug(project), limit)
    .all();
  return results.map(rowToMeta);
}

/** A specific version, or the newest when omitted. */
export async function getBody(
  db: D1Like,
  space: string,
  planId: string,
  version?: number,
): Promise<PlanBody | null> {
  const row =
    version === undefined
      ? await db
          .prepare(
            "SELECT version, markdown, author, ts FROM plan_body WHERE space = ? AND plan_id = ? ORDER BY version DESC LIMIT 1",
          )
          .bind(space, planId)
          .first()
      : await db
          .prepare(
            "SELECT version, markdown, author, ts FROM plan_body WHERE space = ? AND plan_id = ? AND version = ?",
          )
          .bind(space, planId, version)
          .first();
  return row
    ? {
        version: Number(row.version),
        markdown: row.markdown as string,
        author: row.author as string,
        ts: row.ts as string,
      }
    : null;
}

export async function listLinks(
  db: D1Like,
  space: string,
  planId: string,
): Promise<{ factId: string; role: DecisionRole }[]> {
  const { results } = await db
    .prepare(
      "SELECT fact_id, role FROM plan_decision WHERE space = ? AND plan_id = ? ORDER BY role, fact_id",
    )
    .bind(space, planId)
    .all();
  return results.map((r) => ({
    factId: r.fact_id as string,
    role: r.role as DecisionRole,
  }));
}

export async function listRuns(
  db: D1Like,
  space: string,
  planId: string,
): Promise<PlanRun[]> {
  const { results } = await db
    .prepare(
      "SELECT run, agent, started, ended, outcome, commit_sha FROM plan_run WHERE space = ? AND plan_id = ? ORDER BY run",
    )
    .bind(space, planId)
    .all();
  return results.map((r) => ({
    run: Number(r.run),
    agent: r.agent as string,
    started: r.started as string,
    ended: (r.ended as string | null) ?? null,
    outcome: (r.outcome as string | null) ?? null,
    commitSha: (r.commit_sha as string | null) ?? null,
  }));
}
