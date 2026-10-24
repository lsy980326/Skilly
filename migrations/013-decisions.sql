CREATE TABLE decision_events (
  project_id TEXT NOT NULL, record_id TEXT NOT NULL,
  subject_key TEXT NOT NULL, component_key TEXT NOT NULL, feature_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  PRIMARY KEY(project_id, record_id),
  FOREIGN KEY(project_id, record_id) REFERENCES records(project_id, id)
) STRICT;
CREATE INDEX decision_subjects ON decision_events(project_id, subject_key, component_key, feature_key);
PRAGMA user_version = 13;
