CREATE TABLE IF NOT EXISTS membership_claims (
  github_id INTEGER PRIMARY KEY,
  space TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invite_claims (
  github_login TEXT PRIMARY KEY,
  space TEXT NOT NULL
);
