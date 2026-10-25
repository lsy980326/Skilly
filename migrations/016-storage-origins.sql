-- Explicit portability extension; ordinary v15 databases are not auto-upgraded.
CREATE TABLE storage_origins (
 project_id TEXT NOT NULL REFERENCES projects(id), origin TEXT NOT NULL CHECK(origin IN ('sqlite','d1')),
 table_name TEXT NOT NULL, row_key TEXT NOT NULL, row_json TEXT NOT NULL CHECK(json_valid(row_json)),
 PRIMARY KEY(project_id,origin,table_name,row_key)) STRICT;
PRAGMA user_version=16;
