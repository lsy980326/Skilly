CREATE TABLE execution_test_details (
  execution_id TEXT PRIMARY KEY REFERENCES executions(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  details_json TEXT NOT NULL
) STRICT;
PRAGMA user_version = 7;
