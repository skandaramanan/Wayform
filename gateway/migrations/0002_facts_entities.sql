-- Phase B1: a fact is a docs row; source_id groups the fact set of one ledger
-- entry for idempotent delete-then-insert re-ingest. Entity tags power the
-- retrieval candidate generator and the briefing topic manifest.
ALTER TABLE docs ADD COLUMN source_id TEXT;
CREATE INDEX IF NOT EXISTS docs_source ON docs (space, source_id);

CREATE TABLE IF NOT EXISTS fact_entities (
  space   TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  entity  TEXT NOT NULL,
  PRIMARY KEY (space, fact_id, entity)
);
CREATE INDEX IF NOT EXISTS fact_entities_lookup ON fact_entities (space, entity);
