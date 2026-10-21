CREATE TABLE executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  record_id TEXT,
  source TEXT NOT NULL CHECK (source = 'local_runner'),
  executable TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  duration_ms INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('unconfirmed', 'exited', 'launch_failed', 'timed_out', 'interrupted')),
  exit_code INTEGER,
  signal TEXT,
  error_code TEXT,
  stdout_bytes INTEGER NOT NULL DEFAULT 0,
  stderr_bytes INTEGER NOT NULL DEFAULT 0,
  stdout_hash TEXT,
  stderr_hash TEXT,
  stdout_hashed_bytes INTEGER NOT NULL DEFAULT 0,
  stderr_hashed_bytes INTEGER NOT NULL DEFAULT 0,
  output_complete INTEGER NOT NULL DEFAULT 1 CHECK (output_complete IN (0, 1)),
  FOREIGN KEY (project_id, run_id) REFERENCES runs(project_id, id),
  FOREIGN KEY (project_id, record_id) REFERENCES records(project_id, id)
) STRICT;
CREATE INDEX executions_run ON executions(project_id, run_id, started_at DESC, id DESC);
PRAGMA user_version = 6;
