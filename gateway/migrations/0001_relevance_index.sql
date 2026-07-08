-- Disposable index plane (roadmap §2/§4): derived from the git ledger,
-- rebuildable via POST /admin/reindex. Phase A: one row per ledger entry.
CREATE TABLE IF NOT EXISTS docs (
  id TEXT NOT NULL,
  space TEXT NOT NULL,
  project TEXT NOT NULL,
  kind TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'normal',
  body TEXT NOT NULL,
  source_file TEXT NOT NULL,
  source_author TEXT NOT NULL,
  source_ts TEXT NOT NULL,
  embedding BLOB,
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (space, id)
);
CREATE INDEX IF NOT EXISTS docs_space_project ON docs (space, project);

CREATE TABLE IF NOT EXISTS index_state (
  space TEXT PRIMARY KEY,
  last_indexed_sha TEXT
);

CREATE TABLE IF NOT EXISTS retrieval_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space TEXT NOT NULL,
  project TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  query TEXT NOT NULL,
  returned TEXT NOT NULL,
  injected INTEGER NOT NULL,
  ts TEXT NOT NULL
);
