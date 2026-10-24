-- Additive native host-event history; apply after 001–004, never to live SQLite.
CREATE TABLE lifecycle_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
  project_key TEXT NOT NULL, repository TEXT NOT NULL, environment TEXT NOT NULL,
  root_hash TEXT NOT NULL, session_hash TEXT NOT NULL, turn_hash TEXT,
  event TEXT NOT NULL CHECK(event IN ('SessionStart','PostToolUse','PreCompact','Stop','Interrupt','SessionEnd')),
  source TEXT, tool_group TEXT, observed_at TEXT NOT NULL, received_at TEXT NOT NULL, payload_hash TEXT NOT NULL,
  association_status TEXT NOT NULL CHECK(association_status IN ('linked','not_linked','run_closed')),
  UNIQUE(project_id,id)
) STRICT;
CREATE INDEX lifecycle_scope ON lifecycle_events(project_id,repository,environment,root_hash,session_hash,seq DESC);
CREATE TABLE task_event_links (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL,
  run_id TEXT NOT NULL, repository TEXT NOT NULL, environment TEXT NOT NULL,
  root_hash TEXT NOT NULL, session_hash TEXT NOT NULL, anchor_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL CHECK(from_seq>0), linked_at TEXT NOT NULL,
  UNIQUE(project_id,id), FOREIGN KEY(project_id,run_id) REFERENCES runs(project_id,id),
  FOREIGN KEY(project_id,anchor_id) REFERENCES lifecycle_events(project_id,id)
) STRICT;
CREATE INDEX task_event_session ON task_event_links(project_id,repository,environment,root_hash,session_hash,seq DESC);
CREATE INDEX task_event_run ON task_event_links(project_id,run_id,root_hash,seq DESC);
CREATE TABLE event_task_snapshots (
  project_id TEXT NOT NULL, event_id TEXT NOT NULL, link_id TEXT NOT NULL,
  saved_json TEXT NOT NULL CHECK(json_valid(saved_json)), PRIMARY KEY(project_id,event_id),
  FOREIGN KEY(project_id,event_id) REFERENCES lifecycle_events(project_id,id),
  FOREIGN KEY(project_id,link_id) REFERENCES task_event_links(project_id,id)
) STRICT;
CREATE TRIGGER lifecycle_update BEFORE UPDATE ON lifecycle_events
BEGIN SELECT RAISE(ABORT,'Received event originals are immutable'); END;
CREATE TRIGGER lifecycle_delete BEFORE DELETE ON lifecycle_events
BEGIN SELECT RAISE(ABORT,'Received event originals are retained'); END;
CREATE TRIGGER task_event_update BEFORE UPDATE ON task_event_links
BEGIN SELECT RAISE(ABORT,'Explicit task links are immutable'); END;
CREATE TRIGGER task_event_delete BEFORE DELETE ON task_event_links
BEGIN SELECT RAISE(ABORT,'Explicit task links are retained'); END;
CREATE TRIGGER event_snapshot_update BEFORE UPDATE ON event_task_snapshots
BEGIN SELECT RAISE(ABORT,'Interruption snapshots are immutable'); END;
CREATE TRIGGER event_snapshot_delete BEFORE DELETE ON event_task_snapshots
BEGIN SELECT RAISE(ABORT,'Interruption snapshots are retained'); END;
