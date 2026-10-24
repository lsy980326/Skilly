-- Old writers may still use generic supersedes. Guard decision originals at the storage boundary.
CREATE TRIGGER decision_original_update BEFORE UPDATE ON records
WHEN EXISTS(SELECT 1 FROM decision_events WHERE project_id=OLD.project_id AND record_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'Decision originals are immutable'); END;
CREATE TRIGGER decision_original_delete BEFORE DELETE ON records
WHEN EXISTS(SELECT 1 FROM decision_events WHERE project_id=OLD.project_id AND record_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'Decision originals are immutable'); END;
CREATE TRIGGER decision_metadata_update BEFORE UPDATE ON decision_events
BEGIN SELECT RAISE(ABORT, 'Decision links are immutable'); END;
CREATE TRIGGER decision_metadata_delete BEFORE DELETE ON decision_events
BEGIN SELECT RAISE(ABORT, 'Decision links are immutable'); END;
PRAGMA user_version = 14;
