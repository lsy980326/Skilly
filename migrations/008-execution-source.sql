CREATE TABLE execution_sources (
  execution_id TEXT PRIMARY KEY REFERENCES executions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  before_json TEXT NOT NULL,
  after_json TEXT
) STRICT;
PRAGMA user_version = 8;
