-- Existing reports do not establish when the agent reconstructed their contents.
ALTER TABLE records ADD COLUMN report_origin TEXT NOT NULL DEFAULT 'unspecified'
  CHECK (report_origin IN ('unspecified', 'contemporaneous', 'retrospective'));
CREATE INDEX runs_attention ON runs(project_id, repository, environment, state, updated_at, id);
PRAGMA user_version = 2;
