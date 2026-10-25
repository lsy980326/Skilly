-- Host-managed public policies and first-owner enrollment; explicit test/new D1 only.
CREATE TABLE cloud_auth_versions (
 policy_id TEXT NOT NULL, version INTEGER NOT NULL CHECK(version>0),
 state TEXT NOT NULL CHECK(state IN ('active','revoked')), valid_until INTEGER NOT NULL,
 entry_json TEXT NOT NULL CHECK(length(entry_json)<=65536), created_at TEXT NOT NULL,
 PRIMARY KEY(policy_id,version)) STRICT;
CREATE TRIGGER cloud_auth_update BEFORE UPDATE ON cloud_auth_versions BEGIN SELECT RAISE(ABORT,'Authentication history is immutable'); END;
CREATE TRIGGER cloud_auth_delete BEFORE DELETE ON cloud_auth_versions BEGIN SELECT RAISE(ABORT,'Authentication history is retained'); END;
CREATE TABLE cloud_auth_guard (id INTEGER PRIMARY KEY CHECK(id=1),ok INTEGER NOT NULL CONSTRAINT skilly_cloud_auth_allowed CHECK(ok=1)) STRICT;
CREATE TABLE cloud_owner_intents (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), repository TEXT NOT NULL, environment TEXT NOT NULL,
 policy_id TEXT NOT NULL, issuer TEXT NOT NULL, subject TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(project_id,repository,environment)) STRICT;
CREATE TRIGGER cloud_owner_intent_update BEFORE UPDATE ON cloud_owner_intents BEGIN SELECT RAISE(ABORT,'Owner intent is immutable'); END;
CREATE TRIGGER cloud_owner_intent_delete BEFORE DELETE ON cloud_owner_intents BEGIN SELECT RAISE(ABORT,'Owner intent is retained'); END;
CREATE TABLE cloud_owner_claims (
 intent_id TEXT PRIMARY KEY REFERENCES cloud_owner_intents(id), result_json TEXT NOT NULL, claimed_at TEXT NOT NULL) STRICT;
CREATE TRIGGER cloud_owner_claim_update BEFORE UPDATE ON cloud_owner_claims BEGIN SELECT RAISE(ABORT,'Owner claim is immutable'); END;
CREATE TRIGGER cloud_owner_claim_delete BEFORE DELETE ON cloud_owner_claims BEGIN SELECT RAISE(ABORT,'Owner claim is retained'); END;
CREATE TABLE cloud_owner_guard (id INTEGER PRIMARY KEY CHECK(id=1),ok INTEGER NOT NULL CONSTRAINT skilly_cloud_owner_allowed CHECK(ok=1)) STRICT;
