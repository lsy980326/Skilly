CREATE TABLE execution_worktrees (
  execution_id TEXT PRIMARY KEY REFERENCES execution_sources(execution_id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  before_json TEXT,
  after_json TEXT,
  CHECK(before_json IS NOT NULL OR after_json IS NOT NULL)
) STRICT;

-- Preserve fingerprints written by the unreleased inline preview while restoring
-- the original source JSON contract. Published pre-v12 rows have no such field.
INSERT INTO execution_worktrees(execution_id,project_id,before_json,after_json)
  SELECT execution_id,project_id,json_extract(before_json,'$.worktree'),json_extract(after_json,'$.worktree')
  FROM execution_sources WHERE json_type(before_json,'$.worktree')='object' OR json_type(after_json,'$.worktree')='object';
UPDATE execution_sources SET before_json=json_remove(before_json,'$.worktree')
  WHERE json_type(before_json,'$.worktree')='object';
UPDATE execution_sources SET after_json=json_remove(after_json,'$.worktree')
  WHERE json_type(after_json,'$.worktree')='object';
PRAGMA user_version = 12;
