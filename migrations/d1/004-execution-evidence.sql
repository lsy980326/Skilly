-- Additive host-runner evidence; apply after 001–003, never to live SQLite.
CREATE TABLE executions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL, record_id TEXT,
  source TEXT NOT NULL CHECK(source='local_runner'), executable TEXT NOT NULL, command_hash TEXT NOT NULL,
  started_at TEXT NOT NULL, ended_at TEXT, duration_ms INTEGER,
  outcome TEXT NOT NULL CHECK(outcome IN ('unconfirmed','exited','launch_failed','timed_out','interrupted')),
  exit_code INTEGER, signal TEXT, error_code TEXT,
  stdout_bytes INTEGER NOT NULL, stderr_bytes INTEGER NOT NULL,
  stdout_hash TEXT, stderr_hash TEXT, stdout_hashed_bytes INTEGER NOT NULL, stderr_hashed_bytes INTEGER NOT NULL,
  output_complete INTEGER NOT NULL CHECK(output_complete IN (0,1)),
  test_details_json TEXT NOT NULL CHECK(json_valid(test_details_json)),
  source_before_json TEXT CHECK(source_before_json IS NULL OR json_valid(source_before_json)),
  source_after_json TEXT CHECK(source_after_json IS NULL OR json_valid(source_after_json)),
  UNIQUE(project_id,id),
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
  FOREIGN KEY(project_id,record_id) REFERENCES records(project_id,id)
) STRICT;
CREATE INDEX executions_run ON executions(project_id,run_id,started_at DESC,id DESC);
CREATE TRIGGER execution_identity_update BEFORE UPDATE ON executions
WHEN OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL OR NEW.outcome='unconfirmed'
  OR NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.run_id IS NOT OLD.run_id
  OR NEW.record_id IS NOT OLD.record_id OR NEW.source IS NOT OLD.source OR NEW.executable IS NOT OLD.executable
  OR NEW.command_hash IS NOT OLD.command_hash OR NEW.started_at IS NOT OLD.started_at
  OR NEW.source_before_json IS NOT OLD.source_before_json
BEGIN SELECT RAISE(ABORT,'Execution identity and finalized observations are immutable'); END;
CREATE TRIGGER execution_delete BEFORE DELETE ON executions
BEGIN SELECT RAISE(ABORT,'Execution observations are retained'); END;
CREATE TABLE plan_update_executions (
  project_id TEXT NOT NULL, update_id TEXT NOT NULL REFERENCES plan_item_updates(id), execution_id TEXT NOT NULL,
  PRIMARY KEY(update_id,execution_id), FOREIGN KEY(project_id,execution_id) REFERENCES executions(project_id,id)
) STRICT;
CREATE TRIGGER plan_execution_update BEFORE UPDATE ON plan_update_executions
BEGIN SELECT RAISE(ABORT,'Plan evidence links are immutable'); END;
CREATE TRIGGER plan_execution_delete BEFORE DELETE ON plan_update_executions
BEGIN SELECT RAISE(ABORT,'Plan evidence links are immutable'); END;
