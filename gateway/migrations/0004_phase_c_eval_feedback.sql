CREATE TABLE IF NOT EXISTS memory_feedback (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  space    TEXT NOT NULL,
  project  TEXT NOT NULL,
  fact_id  TEXT NOT NULL,
  member   TEXT NOT NULL,
  verdict  TEXT NOT NULL,
  ts       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_feedback_fact
  ON memory_feedback (space, fact_id);

CREATE TABLE IF NOT EXISTS golden_candidate (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  space            TEXT NOT NULL,
  project          TEXT NOT NULL,
  query            TEXT NOT NULL,
  expected_fact_id TEXT NOT NULL,
  note             TEXT,
  ts               TEXT NOT NULL,
  promoted         INTEGER NOT NULL DEFAULT 0
);
