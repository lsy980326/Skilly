-- D1-only additive catalog and historical evidence. Apply explicitly after 001–005.
CREATE TABLE skill_versions (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL REFERENCES projects(id),
  skill_key TEXT NOT NULL, version TEXT NOT NULL, source TEXT NOT NULL, name TEXT NOT NULL,
  description TEXT NOT NULL, body TEXT NOT NULL, files_json TEXT NOT NULL CHECK(json_valid(files_json)),
  content_hash TEXT NOT NULL, install_instructions TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(project_id,skill_key,version)
) STRICT;
CREATE TABLE skill_installations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), skill_key TEXT NOT NULL,
  repository TEXT NOT NULL, environment TEXT NOT NULL, root_hash TEXT NOT NULL,
  tool TEXT NOT NULL CHECK(tool IN ('codex','cursor')), folder TEXT NOT NULL,
  UNIQUE(project_id,id), UNIQUE(project_id,skill_key,repository,environment,root_hash,tool,folder)
) STRICT;
CREATE TABLE skill_assignments (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
  installation_id TEXT NOT NULL, skill_key TEXT NOT NULL, version TEXT NOT NULL, assigned_at TEXT NOT NULL,
  UNIQUE(project_id,id), FOREIGN KEY(project_id,installation_id) REFERENCES skill_installations(project_id,id),
  FOREIGN KEY(project_id,skill_key,version) REFERENCES skill_versions(project_id,skill_key,version)
) STRICT;
CREATE INDEX skill_assignment_latest ON skill_assignments(project_id,installation_id,seq DESC);
CREATE TABLE skill_observations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
  assignment_id TEXT NOT NULL, expected_hash TEXT NOT NULL, observed_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('matches','modified','missing','unavailable')),
  files_json TEXT NOT NULL CHECK(json_valid(files_json)), UNIQUE(project_id,id),
  FOREIGN KEY(project_id,assignment_id) REFERENCES skill_assignments(project_id,id)
) STRICT;
CREATE INDEX skill_observation_latest ON skill_observations(project_id,assignment_id,seq DESC);
CREATE TABLE task_skill_usage (
  project_id TEXT NOT NULL, record_id TEXT NOT NULL, run_id TEXT NOT NULL,
  skill_key TEXT NOT NULL, version TEXT NOT NULL, content_hash TEXT NOT NULL, purpose TEXT NOT NULL,
  observation_id TEXT, PRIMARY KEY(project_id,record_id,skill_key,version),
  FOREIGN KEY(project_id,record_id) REFERENCES records(project_id,id),
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
  FOREIGN KEY(project_id,skill_key,version) REFERENCES skill_versions(project_id,skill_key,version),
  FOREIGN KEY(project_id,observation_id) REFERENCES skill_observations(project_id,id)
) STRICT;
CREATE INDEX task_skill_task ON task_skill_usage(project_id,run_id,record_id);
CREATE TRIGGER skill_version_update BEFORE UPDATE ON skill_versions BEGIN SELECT RAISE(ABORT,'Skill versions are immutable'); END;
CREATE TRIGGER skill_version_delete BEFORE DELETE ON skill_versions BEGIN SELECT RAISE(ABORT,'Skill versions are retained'); END;
CREATE TRIGGER skill_installation_update BEFORE UPDATE ON skill_installations BEGIN SELECT RAISE(ABORT,'Installation identities are immutable'); END;
CREATE TRIGGER skill_installation_delete BEFORE DELETE ON skill_installations BEGIN SELECT RAISE(ABORT,'Installation identities are retained'); END;
CREATE TRIGGER skill_assignment_update BEFORE UPDATE ON skill_assignments BEGIN SELECT RAISE(ABORT,'Assignment history is immutable'); END;
CREATE TRIGGER skill_assignment_delete BEFORE DELETE ON skill_assignments BEGIN SELECT RAISE(ABORT,'Assignment history is retained'); END;
CREATE TRIGGER skill_observation_update BEFORE UPDATE ON skill_observations BEGIN SELECT RAISE(ABORT,'File observations are immutable'); END;
CREATE TRIGGER skill_observation_delete BEFORE DELETE ON skill_observations BEGIN SELECT RAISE(ABORT,'File observations are retained'); END;
CREATE TRIGGER task_skill_update BEFORE UPDATE ON task_skill_usage BEGIN SELECT RAISE(ABORT,'Use reports are immutable'); END;
CREATE TRIGGER task_skill_delete BEFORE DELETE ON task_skill_usage BEGIN SELECT RAISE(ABORT,'Use reports are retained'); END;
