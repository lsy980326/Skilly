-- Additive D1 business history; apply after 001 and 002, never to live SQLite.
CREATE TABLE decision_events (
  project_id TEXT NOT NULL, record_id TEXT NOT NULL,
  subject_key TEXT NOT NULL, component_key TEXT NOT NULL, feature_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  PRIMARY KEY(project_id,record_id),
  FOREIGN KEY(project_id,record_id) REFERENCES records(project_id,id)
) STRICT;
CREATE INDEX decision_subjects ON decision_events(project_id,subject_key,component_key,feature_key);
CREATE TRIGGER decision_original_update BEFORE UPDATE ON records
WHEN EXISTS(SELECT 1 FROM decision_events WHERE project_id=OLD.project_id AND record_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Decision originals are immutable'); END;
CREATE TRIGGER decision_original_delete BEFORE DELETE ON records
WHEN EXISTS(SELECT 1 FROM decision_events WHERE project_id=OLD.project_id AND record_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'Decision originals are immutable'); END;
CREATE TRIGGER decision_metadata_update BEFORE UPDATE ON decision_events
BEGIN SELECT RAISE(ABORT,'Decision links are immutable'); END;
CREATE TRIGGER decision_metadata_delete BEFORE DELETE ON decision_events
BEGIN SELECT RAISE(ABORT,'Decision links are immutable'); END;
CREATE TABLE plan_versions (
  project_id TEXT NOT NULL REFERENCES projects(id), repository TEXT NOT NULL, environment TEXT NOT NULL,
  plan_key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0), title TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('markdown','conversation')), source_ref TEXT NOT NULL,
  source_body TEXT NOT NULL, source_hash TEXT NOT NULL, items_json TEXT NOT NULL CHECK(json_valid(items_json)),
  run_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(project_id,repository,environment,plan_key,version),
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id)
) STRICT;
CREATE TABLE plan_item_updates (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL, repository TEXT NOT NULL, environment TEXT NOT NULL,
  plan_key TEXT NOT NULL, version INTEGER NOT NULL, item_key TEXT NOT NULL,
  run_id TEXT NOT NULL, record_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','in_progress','blocked','completed')),
  note TEXT NOT NULL, criteria_json TEXT NOT NULL CHECK(json_valid(criteria_json)), created_at TEXT NOT NULL,
  FOREIGN KEY(project_id,repository,environment,plan_key,version) REFERENCES plan_versions(project_id,repository,environment,plan_key,version),
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
  FOREIGN KEY(project_id,record_id) REFERENCES records(project_id,id)
) STRICT;
CREATE INDEX plan_item_latest ON plan_item_updates(project_id,repository,environment,plan_key,version,item_key,seq DESC);
CREATE TRIGGER plan_version_update BEFORE UPDATE ON plan_versions
BEGIN SELECT RAISE(ABORT,'Plan versions are immutable'); END;
CREATE TRIGGER plan_version_delete BEFORE DELETE ON plan_versions
BEGIN SELECT RAISE(ABORT,'Plan versions are immutable'); END;
CREATE TRIGGER plan_progress_update BEFORE UPDATE ON plan_item_updates
BEGIN SELECT RAISE(ABORT,'Plan progress is append only'); END;
CREATE TRIGGER plan_progress_delete BEFORE DELETE ON plan_item_updates
BEGIN SELECT RAISE(ABORT,'Plan progress is append only'); END;
