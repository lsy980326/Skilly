-- D1-only explicit metadata, no inference or rewrite of historical task links.
CREATE TABLE feature_aliases (
  project_id TEXT NOT NULL, feature_key TEXT NOT NULL, repository TEXT NOT NULL, environment TEXT NOT NULL,
  alias TEXT NOT NULL, normalized_alias TEXT NOT NULL, source_run_id TEXT NOT NULL,
  PRIMARY KEY(project_id,feature_key,repository,environment,normalized_alias),
  FOREIGN KEY(project_id,feature_key) REFERENCES features(project_id,key),
  FOREIGN KEY(project_id,source_run_id,feature_key) REFERENCES run_features(project_id,run_id,feature_key)
) STRICT;
CREATE TABLE feature_code_paths (
  project_id TEXT NOT NULL, feature_key TEXT NOT NULL, repository TEXT NOT NULL, environment TEXT NOT NULL,
  path TEXT NOT NULL, normalized_path TEXT NOT NULL, source_run_id TEXT NOT NULL,
  PRIMARY KEY(project_id,feature_key,repository,environment,path),
  FOREIGN KEY(project_id,feature_key) REFERENCES features(project_id,key),
  FOREIGN KEY(project_id,source_run_id,feature_key) REFERENCES run_features(project_id,run_id,feature_key)
) STRICT;
CREATE INDEX feature_alias_scope ON feature_aliases(project_id,repository,environment,normalized_alias);
CREATE INDEX feature_path_scope ON feature_code_paths(project_id,repository,environment,normalized_path);
CREATE TRIGGER feature_alias_update BEFORE UPDATE ON feature_aliases BEGIN SELECT RAISE(ABORT,'Explicit aliases are immutable'); END;
CREATE TRIGGER feature_alias_delete BEFORE DELETE ON feature_aliases BEGIN SELECT RAISE(ABORT,'Explicit aliases are retained'); END;
CREATE TRIGGER feature_path_update BEFORE UPDATE ON feature_code_paths BEGIN SELECT RAISE(ABORT,'Declared paths are immutable'); END;
CREATE TRIGGER feature_path_delete BEFORE DELETE ON feature_code_paths BEGIN SELECT RAISE(ABORT,'Declared paths are retained'); END;
