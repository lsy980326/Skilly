-- Explicit cloud access policy. Never applied by local SQLite/transfer setup.
CREATE TABLE cloud_project_access (
 issuer TEXT NOT NULL, subject TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
 repository TEXT NOT NULL, environment TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')), state TEXT NOT NULL CHECK(state IN ('active','revoked')),
 created_at TEXT NOT NULL, PRIMARY KEY(issuer,subject,project_id,repository,environment,version)) STRICT;
CREATE TRIGGER cloud_access_update BEFORE UPDATE ON cloud_project_access BEGIN SELECT RAISE(ABORT,'Access history is immutable'); END;
CREATE TRIGGER cloud_access_delete BEFORE DELETE ON cloud_project_access BEGIN SELECT RAISE(ABORT,'Access history is retained'); END;
CREATE TABLE cloud_access_guard (id INTEGER PRIMARY KEY CHECK(id=1),ok INTEGER NOT NULL CONSTRAINT skilly_cloud_access_allowed CHECK(ok=1)) STRICT;
