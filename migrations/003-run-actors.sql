-- Keep the runs column layout compatible with already-running v2 writers.
-- Actor names are declarations, not authenticated human identities.
CREATE TABLE run_actors (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  actor TEXT NOT NULL CHECK (length(trim(actor)) BETWEEN 1 AND 80)
) STRICT;
CREATE INDEX runs_viewer ON runs(project_id, updated_at DESC, id DESC);
CREATE INDEX records_run_seq ON records(project_id, run_id, seq DESC);
PRAGMA user_version = 3;
