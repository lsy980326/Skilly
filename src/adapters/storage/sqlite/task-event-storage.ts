import { DatabaseSync } from "node:sqlite";
import type { JsonObject } from "../../../core/memory/model.js";
import { nativeOnly } from "./event-imports.js";
import { captureFloor } from "./event-retention.js";

export const taskLinkSchema = `CREATE TABLE IF NOT EXISTS task_links (
  seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  project_key TEXT NOT NULL, repository TEXT NOT NULL, environment TEXT NOT NULL,
  root_hash TEXT NOT NULL, session_hash TEXT NOT NULL, anchor_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL, linked_at TEXT NOT NULL,
  UNIQUE(project_id,run_id,anchor_id)) STRICT;
  CREATE INDEX IF NOT EXISTS task_links_run ON task_links(project_id,run_id,seq);
  CREATE INDEX IF NOT EXISTS task_links_session ON task_links(project_key,repository,environment,root_hash,session_hash,seq DESC);
  CREATE TABLE IF NOT EXISTS event_task_links(event_id TEXT PRIMARY KEY,link_id TEXT NOT NULL,saved_json TEXT NOT NULL CHECK(json_valid(saved_json))) STRICT;
  CREATE INDEX IF NOT EXISTS event_task_link ON event_task_links(link_id,event_id);
  CREATE TABLE IF NOT EXISTS event_link_failures(event_id TEXT PRIMARY KEY,link_id TEXT NOT NULL,status TEXT NOT NULL) STRICT;`;

export function lastSavedReceipt(db: DatabaseSync, projectId: string, runId: string): JsonObject {
  const row = db.prepare(`SELECT r.id,r.seq,r.recorded_at,
    EXISTS(SELECT 1 FROM receipts p WHERE p.scope=r.project_id AND json_extract(p.result_json,'$.record_id')=r.id) AS receipt_confirmed
    FROM records r WHERE r.project_id=? AND r.run_id=? ORDER BY r.seq DESC LIMIT 1`).get(projectId, runId);
  if (row) return { stage: "record", record_id: String(row["id"]), seq: Number(row["seq"]), recorded_at: String(row["recorded_at"]),
    record_visible: true, receipt_confirmed: row["receipt_confirmed"] === 1 };
  const start = db.prepare("SELECT 1 FROM receipts WHERE scope=? AND json_extract(result_json,'$.run.id')=? LIMIT 1").get(projectId, runId);
  return { stage: start ? "start" : "unknown", record_id: null, record_visible: false, receipt_confirmed: Boolean(start) };
}

/** Capture an association only while the explicitly linked run is still active. Never backfill. */
export function captureTaskEvent(events: DatabaseSync, mainPath: string, eventId: string) {
  if (!events.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_task_links'").get()) return;
  const link = events.prepare(`SELECT l.* FROM task_links l JOIN events e ON e.id=? AND e.project_key=l.project_key
    AND e.repository=l.repository AND e.environment=l.environment AND e.root_hash=l.root_hash AND e.session_hash=l.session_hash
    AND e.seq>=l.from_seq AND l.seq>=? ${nativeOnly(events, "link", "l.id")} ORDER BY l.seq DESC LIMIT 1`).get(eventId,captureFloor(events).link);
  if (!link) return;
  let main: DatabaseSync | undefined;
  try {
    main = new DatabaseSync(mainPath, { readOnly: true });
    main.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=100;");
    if (main.prepare("PRAGMA application_id").get()?.["application_id"] !== 1397446988) throw new Error("Unsupported task store");
    const run = main.prepare(`SELECT r.state FROM runs r JOIN projects p ON p.id=r.project_id
      WHERE r.project_id=? AND r.id=? AND p.project_key=? AND r.repository=? AND r.environment=?`)
      .get(String(link["project_id"]), String(link["run_id"]), String(link["project_key"]), String(link["repository"]), String(link["environment"]));
    if (run?.["state"] !== "active") return;
    const saved = { ...lastSavedReceipt(main, String(link["project_id"]), String(link["run_id"])), read_at: new Date().toISOString(),
      meaning: "Record visible during hook processing; not an atomic cutoff across databases." };
    events.prepare("INSERT INTO event_task_links VALUES(?,?,?)").run(eventId, String(link["id"]), JSON.stringify(saved));
  } catch {
    events.prepare("INSERT INTO event_link_failures VALUES(?,?,?)").run(eventId, String(link["id"]), "association_unconfirmed");
  } finally { main?.close(); }
}
