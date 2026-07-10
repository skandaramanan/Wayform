CREATE TABLE IF NOT EXISTS supersession_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  space       TEXT NOT NULL,
  project     TEXT NOT NULL,
  new_fact_id TEXT NOT NULL,
  old_fact_id TEXT NOT NULL,
  verdict     TEXT NOT NULL,
  auto_linked INTEGER NOT NULL DEFAULT 0,
  reason      TEXT,
  ts          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS supersession_log_space_ts
  ON supersession_log (space, ts);
CREATE INDEX IF NOT EXISTS supersession_log_verdict
  ON supersession_log (space, verdict, ts);
