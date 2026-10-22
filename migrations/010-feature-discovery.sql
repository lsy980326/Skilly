CREATE TABLE feature_aliases (
  project_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  repository TEXT NOT NULL,
  environment TEXT NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  PRIMARY KEY (project_id, feature_key, repository, environment, normalized_alias),
  FOREIGN KEY (project_id, feature_key) REFERENCES features(project_id, key),
  FOREIGN KEY (project_id, source_run_id) REFERENCES runs(project_id, id)
) STRICT;
CREATE INDEX feature_alias_lookup ON feature_aliases(project_id, repository, environment, normalized_alias, feature_key);
CREATE TABLE feature_code_paths (
  project_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  repository TEXT NOT NULL,
  environment TEXT NOT NULL,
  path TEXT NOT NULL,
  source_run_id TEXT NOT NULL,
  PRIMARY KEY (project_id, feature_key, repository, environment, path),
  FOREIGN KEY (project_id, feature_key) REFERENCES features(project_id, key),
  FOREIGN KEY (project_id, source_run_id) REFERENCES runs(project_id, id)
) STRICT;
CREATE INDEX feature_path_lookup ON feature_code_paths(project_id, repository, environment, path, feature_key);
PRAGMA user_version = 10;
