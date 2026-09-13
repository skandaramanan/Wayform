-- Per ledger file: what was last indexed (git blob sha), by which extractor
-- version, and how it went. Lets every ingest path skip unchanged content
-- instead of re-extracting it, and lets the cron retry only failures.
-- status: ok | floored (model failed; one whole-entry fact) | pending (claimed)
CREATE TABLE IF NOT EXISTS ingest_state (
  space       TEXT NOT NULL,
  source_file TEXT NOT NULL,
  digest      TEXT NOT NULL,
  version     TEXT NOT NULL,
  status      TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (space, source_file)
);
CREATE INDEX IF NOT EXISTS ingest_state_retry
  ON ingest_state (space, status, updated_at);
