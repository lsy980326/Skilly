-- Explicit test/new D1 migration. No real account or SQLite migration.
CREATE TABLE cloud_usage_policy (
 id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL CHECK(length(body)<=4096)
) STRICT;
CREATE TRIGGER cloud_usage_policy_update BEFORE UPDATE ON cloud_usage_policy BEGIN SELECT RAISE(ABORT,'Usage policy is immutable'); END;
CREATE TRIGGER cloud_usage_policy_delete BEFORE DELETE ON cloud_usage_policy BEGIN SELECT RAISE(ABORT,'Usage policy is retained'); END;
CREATE TABLE cloud_usage_counters (
 bucket TEXT NOT NULL, day INTEGER NOT NULL, requests INTEGER NOT NULL DEFAULT 0,
 batches INTEGER NOT NULL DEFAULT 0, rows_read INTEGER NOT NULL DEFAULT 0,
 rows_written INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1)),
 PRIMARY KEY(bucket,day)
) STRICT;
CREATE TABLE cloud_usage_reservations (
 id TEXT PRIMARY KEY, day INTEGER NOT NULL, user_bucket TEXT, state TEXT NOT NULL CHECK(state IN ('held','settled','uncertain')),
 observed_json TEXT, write_bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
) STRICT;
CREATE TABLE cloud_usage_storage (
 id INTEGER PRIMARY KEY CHECK(id=1), accepted_write_bytes INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO cloud_usage_storage(id) VALUES(1);
CREATE TABLE cloud_usage_guard (
 id INTEGER PRIMARY KEY CHECK(id=1), ok INTEGER NOT NULL CONSTRAINT skilly_usage_allowed CHECK(ok=1)
) STRICT;
