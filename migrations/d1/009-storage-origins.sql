-- Explicit portability extension; ordinary v15 databases are not auto-upgraded.
CREATE TABLE storage_origins (
 project_id TEXT NOT NULL REFERENCES projects(id), origin TEXT NOT NULL CHECK(origin IN ('sqlite','d1')),
 table_name TEXT NOT NULL, row_key TEXT NOT NULL, row_json TEXT NOT NULL CHECK(json_valid(row_json)),
 PRIMARY KEY(project_id,origin,table_name,row_key)) STRICT;
CREATE TRIGGER d1_fence_storage_origins_insert BEFORE INSERT ON storage_origins WHEN EXISTS(SELECT 1 FROM d1_project_authority a WHERE a.state='blocked' AND (a.project_id=NEW.project_id)) BEGIN SELECT RAISE(ABORT,'project_write_blocked'); END;
CREATE TRIGGER d1_fence_storage_origins_update BEFORE UPDATE ON storage_origins WHEN EXISTS(SELECT 1 FROM d1_project_authority a WHERE a.state='blocked' AND (a.project_id=NEW.project_id OR a.project_id=OLD.project_id)) BEGIN SELECT RAISE(ABORT,'project_write_blocked'); END;
CREATE TRIGGER d1_fence_storage_origins_delete BEFORE DELETE ON storage_origins WHEN EXISTS(SELECT 1 FROM d1_project_authority a WHERE a.state='blocked' AND (a.project_id=OLD.project_id)) BEGIN SELECT RAISE(ABORT,'project_write_blocked'); END;
