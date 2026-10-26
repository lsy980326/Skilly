-- Explicit local/test D1 upgrade after 012. Original policy and reservations stay intact.
CREATE TABLE cloud_usage_policy_versions (
 version INTEGER PRIMARY KEY CHECK(version>0), body TEXT NOT NULL CHECK(length(body)<=4096),
 reason TEXT NOT NULL CHECK(length(reason)<=500), created_at TEXT NOT NULL
) STRICT;
INSERT INTO cloud_usage_policy_versions SELECT 1,body,'bootstrap',strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM cloud_usage_policy WHERE id=1;
CREATE TRIGGER cloud_usage_versions_update BEFORE UPDATE ON cloud_usage_policy_versions BEGIN SELECT RAISE(ABORT,'Usage versions are immutable'); END;
CREATE TRIGGER cloud_usage_versions_delete BEFORE DELETE ON cloud_usage_policy_versions BEGIN SELECT RAISE(ABORT,'Usage versions are retained'); END;
CREATE TABLE cloud_usage_control (
 id INTEGER PRIMARY KEY CHECK(id=1), database_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0,
 policy_version INTEGER NOT NULL DEFAULT 0
) STRICT;
INSERT INTO cloud_usage_control SELECT 1,lower(hex(randomblob(16))),0,coalesce(max(version),0) FROM cloud_usage_policy_versions;
CREATE TRIGGER cloud_usage_bootstrap AFTER INSERT ON cloud_usage_policy BEGIN
 INSERT INTO cloud_usage_policy_versions VALUES(1,NEW.body,'bootstrap',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
 UPDATE cloud_usage_control SET policy_version=1,revision=revision+1 WHERE id=1 AND policy_version=0;
END;
CREATE TABLE cloud_usage_context (
 reservation_id TEXT PRIMARY KEY REFERENCES cloud_usage_reservations(id), policy_version INTEGER NOT NULL,
 policy_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0 CHECK(pending>=0),
 stopped INTEGER NOT NULL DEFAULT 0 CHECK(stopped IN (0,1)), completion_json TEXT, resolution_json TEXT
) STRICT;
CREATE TRIGGER cloud_usage_context_original BEFORE UPDATE ON cloud_usage_context
 WHEN NEW.reservation_id<>OLD.reservation_id OR NEW.policy_json<>OLD.policy_json OR NEW.policy_version<>OLD.policy_version
 OR (OLD.completion_json IS NOT NULL AND NEW.completion_json IS NOT OLD.completion_json)
 OR (OLD.resolution_json IS NOT NULL AND NEW.resolution_json IS NOT OLD.resolution_json)
 OR NEW.stopped<OLD.stopped
 BEGIN SELECT RAISE(ABORT,'Usage evidence cannot be replaced'); END;
CREATE TABLE cloud_usage_operations (
 request_key TEXT PRIMARY KEY, input_hash TEXT NOT NULL, result_json TEXT NOT NULL CHECK(length(result_json)<=32768), created_at TEXT NOT NULL
) STRICT;
CREATE TRIGGER cloud_usage_operations_update BEFORE UPDATE ON cloud_usage_operations BEGIN SELECT RAISE(ABORT,'Usage operations are immutable'); END;
CREATE TRIGGER cloud_usage_operations_delete BEFORE DELETE ON cloud_usage_operations BEGIN SELECT RAISE(ABORT,'Usage operations are retained'); END;
CREATE INDEX cloud_usage_unresolved ON cloud_usage_reservations(state,created_at,id);
CREATE TABLE cloud_usage_operation_guard (
 id INTEGER PRIMARY KEY CHECK(id=1), ok INTEGER NOT NULL CONSTRAINT skilly_usage_operation_allowed CHECK(ok=1)
) STRICT;
CREATE TABLE cloud_usage_admission (
 id INTEGER PRIMARY KEY CHECK(id=1), reservation_id TEXT NOT NULL, policy_version INTEGER NOT NULL
) STRICT;
CREATE TRIGGER cloud_usage_versioned_admission BEFORE INSERT ON cloud_usage_reservations
 WHEN NOT EXISTS(SELECT 1 FROM cloud_usage_admission a JOIN cloud_usage_control c ON c.id=1
  WHERE a.id=1 AND a.reservation_id=NEW.id AND a.policy_version=c.policy_version)
 BEGIN SELECT RAISE(ABORT,'skilly_usage_admission_required'); END;
