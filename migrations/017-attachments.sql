-- Only an explicit attachment save installs this local extension.
CREATE TABLE attachment_objects (
 project_id TEXT NOT NULL REFERENCES projects(id), sha256 TEXT NOT NULL,
 bytes INTEGER NOT NULL CHECK(bytes >= 0 AND bytes <= 4194304),
 parts INTEGER NOT NULL CHECK(parts >= 1 AND parts <= 64), created_at TEXT NOT NULL,
 PRIMARY KEY(project_id,sha256)) STRICT;
CREATE TABLE attachment_chunks (
 project_id TEXT NOT NULL, sha256 TEXT NOT NULL, part INTEGER NOT NULL,
 data_base64 TEXT NOT NULL, PRIMARY KEY(project_id,sha256,part),
 FOREIGN KEY(project_id,sha256) REFERENCES attachment_objects(project_id,sha256)) STRICT;
CREATE TABLE record_attachments (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL, record_id TEXT,
 sha256 TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL,
 FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
 FOREIGN KEY(project_id,record_id) REFERENCES records(project_id,id),
 FOREIGN KEY(project_id,sha256) REFERENCES attachment_objects(project_id,sha256)) STRICT;
CREATE UNIQUE INDEX attachment_target ON record_attachments(project_id,run_id,coalesce(record_id,''),name,sha256);
CREATE INDEX attachment_run ON record_attachments(project_id,run_id,created_at,id);
PRAGMA user_version=17;
