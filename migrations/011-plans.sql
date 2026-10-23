CREATE TABLE plan_versions (
  project_id TEXT NOT NULL REFERENCES projects(id), repository TEXT NOT NULL, environment TEXT NOT NULL,
  plan_key TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0), title TEXT NOT NULL,
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
  run_id TEXT NOT NULL, record_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','in_progress','blocked','completed')),
  note TEXT NOT NULL, criteria_json TEXT NOT NULL CHECK(json_valid(criteria_json)), created_at TEXT NOT NULL,
  FOREIGN KEY(project_id,repository,environment,plan_key,version) REFERENCES plan_versions(project_id,repository,environment,plan_key,version),
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
  FOREIGN KEY(project_id,record_id) REFERENCES records(project_id,id)
) STRICT;
CREATE TABLE plan_update_executions (
  project_id TEXT NOT NULL REFERENCES projects(id), update_id TEXT NOT NULL REFERENCES plan_item_updates(id),
  execution_id TEXT NOT NULL REFERENCES executions(id), PRIMARY KEY(update_id,execution_id)
) STRICT;
CREATE INDEX plan_item_latest ON plan_item_updates(project_id,repository,environment,plan_key,version,item_key,seq DESC);
PRAGMA user_version = 11;
