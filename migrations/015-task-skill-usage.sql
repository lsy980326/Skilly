CREATE UNIQUE INDEX skill_observation_identity ON skill_observations(project_id, id);
CREATE TABLE task_skill_usage (
  project_id TEXT NOT NULL, record_id TEXT NOT NULL, run_id TEXT NOT NULL,
  skill_key TEXT NOT NULL, version TEXT NOT NULL, content_hash TEXT NOT NULL,
  purpose TEXT NOT NULL, observation_id TEXT,
  PRIMARY KEY(project_id, record_id, skill_key, version),
  FOREIGN KEY(project_id, record_id) REFERENCES records(project_id, id),
  FOREIGN KEY(project_id, run_id) REFERENCES runs(project_id, id),
  FOREIGN KEY(project_id, skill_key, version) REFERENCES skill_versions(project_id, skill_key, version),
  FOREIGN KEY(project_id, observation_id) REFERENCES skill_observations(project_id, id)
) STRICT;
CREATE INDEX task_skill_usage_run ON task_skill_usage(project_id, run_id, record_id);
CREATE TRIGGER task_skill_usage_update BEFORE UPDATE ON task_skill_usage
BEGIN SELECT RAISE(ABORT, 'Task skill reports are append-only.'); END;
CREATE TRIGGER task_skill_usage_delete BEFORE DELETE ON task_skill_usage
BEGIN SELECT RAISE(ABORT, 'Task skill reports are append-only.'); END;
PRAGMA user_version = 15;
