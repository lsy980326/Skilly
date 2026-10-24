-- Additive D1-only work metadata. Apply after 001; never to the live SQLite DB.
CREATE TABLE components (
  project_id TEXT NOT NULL REFERENCES projects(id), key TEXT NOT NULL, name TEXT NOT NULL,
  PRIMARY KEY(project_id,key)
) STRICT;
CREATE TABLE features (
  project_id TEXT NOT NULL REFERENCES projects(id), key TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL,
  PRIMARY KEY(project_id,key)
) STRICT;
CREATE TABLE run_components (
  project_id TEXT NOT NULL, run_id TEXT NOT NULL, component_key TEXT NOT NULL,
  PRIMARY KEY(project_id,run_id,component_key),
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
  FOREIGN KEY(project_id,component_key) REFERENCES components(project_id,key)
) STRICT;
CREATE TABLE run_features (
  project_id TEXT NOT NULL, run_id TEXT NOT NULL, feature_key TEXT NOT NULL,
  PRIMARY KEY(project_id,run_id,feature_key),
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
  FOREIGN KEY(project_id,feature_key) REFERENCES features(project_id,key)
) STRICT;
CREATE TABLE run_details (
  project_id TEXT NOT NULL, run_id TEXT NOT NULL, title TEXT, branch TEXT,
  PRIMARY KEY(project_id,run_id),
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id)
) STRICT;
CREATE TABLE record_reports (
  project_id TEXT NOT NULL, record_id TEXT NOT NULL, report_json TEXT NOT NULL CHECK(json_valid(report_json)),
  PRIMARY KEY(project_id,record_id),
  FOREIGN KEY(project_id,record_id) REFERENCES records(project_id,id)
) STRICT;
CREATE INDEX run_components_filter ON run_components(project_id,component_key,run_id);
CREATE INDEX run_features_filter ON run_features(project_id,feature_key,run_id);
CREATE INDEX runs_activity ON runs(project_id,repository,environment,updated_at DESC,id DESC);
CREATE INDEX records_observed ON records(project_id,run_id,observed_at DESC,seq DESC);
