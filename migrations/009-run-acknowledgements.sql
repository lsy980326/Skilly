CREATE TABLE run_acknowledgements (
  project_id TEXT NOT NULL REFERENCES projects(id),
  run_id TEXT NOT NULL,
  acknowledged_updated_at TEXT NOT NULL,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (project_id, run_id, acknowledged_updated_at),
  FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id)
) STRICT;
PRAGMA user_version = 9;
