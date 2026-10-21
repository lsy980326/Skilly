CREATE TABLE skill_versions (
  project_id TEXT NOT NULL REFERENCES projects(id), skill_key TEXT NOT NULL, version TEXT NOT NULL,
  source TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
  body TEXT NOT NULL, files_json TEXT NOT NULL CHECK(json_valid(files_json)), content_hash TEXT NOT NULL,
  install_instructions TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(project_id, skill_key, version)
) STRICT;
CREATE TABLE skill_installations (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, skill_key TEXT NOT NULL, version TEXT NOT NULL,
  repository TEXT NOT NULL, environment TEXT NOT NULL, project_root TEXT NOT NULL,
  tool TEXT NOT NULL CHECK(tool IN ('codex', 'cursor')), folder TEXT NOT NULL, assigned_at TEXT NOT NULL,
  UNIQUE(project_id, id), UNIQUE(project_id, skill_key, repository, environment, project_root, tool, folder),
  FOREIGN KEY(project_id, skill_key, version) REFERENCES skill_versions(project_id, skill_key, version)
) STRICT;
CREATE TABLE skill_observations (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, installation_id TEXT NOT NULL,
  version TEXT NOT NULL, expected_hash TEXT NOT NULL, observed_at TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('matches', 'modified', 'missing', 'unavailable')),
  files_json TEXT NOT NULL CHECK(json_valid(files_json)),
  FOREIGN KEY(project_id, installation_id) REFERENCES skill_installations(project_id, id)
) STRICT;
CREATE INDEX skill_observation_latest ON skill_observations(project_id, installation_id, observed_at DESC, seq DESC);
PRAGMA user_version = 5;
