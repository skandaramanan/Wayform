-- Phase 1 plan object. A PROJECTION of the ledger's plans/<project>/<id>/
-- event files (gateway/src/plan-core.ts); rebuildable from the ledger via
-- POST /mcp/admin/reindex {"plans":true}. No BLOB columns.
CREATE TABLE IF NOT EXISTS plan (
  space         TEXT NOT NULL,
  id            TEXT NOT NULL,
  project       TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  title         TEXT NOT NULL,
  repo          TEXT,
  branch        TEXT,
  author        TEXT NOT NULL,
  state         TEXT NOT NULL
    CHECK (state IN ('draft','active','building','shipped','superseded')),
  version       INTEGER NOT NULL, -- newest plan_body version
  rev           INTEGER NOT NULL, -- ledger events applied (optimistic lock)
  runs          INTEGER NOT NULL DEFAULT 0,
  superseded_by TEXT,
  created       TEXT NOT NULL,
  updated       TEXT NOT NULL,
  PRIMARY KEY (space, id),
  UNIQUE (space, project, seq)
);

-- Every edit is a new row; old versions stay readable.
CREATE TABLE IF NOT EXISTS plan_body (
  space    TEXT NOT NULL,
  plan_id  TEXT NOT NULL,
  version  INTEGER NOT NULL,
  markdown TEXT NOT NULL,
  author   TEXT NOT NULL,
  ts       TEXT NOT NULL,
  PRIMARY KEY (space, plan_id, version)
);

CREATE TABLE IF NOT EXISTS plan_decision (
  space   TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  role    TEXT NOT NULL CHECK (role IN ('inherited','produced','violated')),
  PRIMARY KEY (space, plan_id, fact_id, role)
);

CREATE TABLE IF NOT EXISTS plan_run (
  space      TEXT NOT NULL,
  plan_id    TEXT NOT NULL,
  run        INTEGER NOT NULL,
  agent      TEXT NOT NULL,
  started    TEXT NOT NULL,
  ended      TEXT,
  outcome    TEXT,
  commit_sha TEXT,
  PRIMARY KEY (space, plan_id, run)
);

-- Per-project #N allocator. A failed ledger write leaves a gap, never a dup.
CREATE TABLE IF NOT EXISTS plan_counter (
  space    TEXT NOT NULL,
  project  TEXT NOT NULL,
  last_seq INTEGER NOT NULL,
  PRIMARY KEY (space, project)
);
