-- Separate, unprovisioned cloud foundation schema. Never apply to a local Skilly v15 DB.
CREATE TABLE projects (
  id TEXT PRIMARY KEY, project_key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0), created_at TEXT NOT NULL
) STRICT;
CREATE TABLE runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), goal TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('answer','diagnose','review','change')),
  environment TEXT NOT NULL, repository TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','completed','interrupted')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id,id)
) STRICT;
CREATE TABLE run_actors (run_id TEXT PRIMARY KEY REFERENCES runs(id), actor TEXT NOT NULL) STRICT;
CREATE TABLE records (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id), run_id TEXT NOT NULL,
  topic TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('note','decision','change','issue','summary')),
  body TEXT NOT NULL, environment TEXT NOT NULL, repository TEXT NOT NULL, source_fingerprint TEXT,
  observed_at TEXT NOT NULL, recorded_at TEXT NOT NULL, supersedes TEXT, superseded_by TEXT,
  report_origin TEXT NOT NULL CHECK(report_origin IN ('unspecified','contemporaneous','retrospective')),
  UNIQUE(project_id,id),
  FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
  FOREIGN KEY(project_id,supersedes) REFERENCES records(project_id,id),
  FOREIGN KEY(project_id,superseded_by) REFERENCES records(project_id,id)
) STRICT;
CREATE INDEX records_scope ON records(project_id,environment,repository,seq DESC);
CREATE TABLE receipts (
  scope TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL,
  commit_token TEXT NOT NULL,
  PRIMARY KEY(scope,idempotency_key)
) STRICT;
CREATE TABLE skilly_write_assertions (
  id INTEGER PRIMARY KEY CHECK(id=1), ok INTEGER NOT NULL CONSTRAINT skilly_atomic_change CHECK(ok=1)
) STRICT;
CREATE VIRTUAL TABLE record_search USING fts5(body,topic,content='records',content_rowid='seq',tokenize='unicode61');
CREATE TRIGGER records_insert_search AFTER INSERT ON records BEGIN
  INSERT INTO record_search(rowid,body,topic) VALUES(new.seq,new.body,new.topic);
END;
