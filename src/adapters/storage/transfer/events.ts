import { closeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { lifecycleSchemaSql } from "../sqlite/lifecycle.js";
import { taskLinkSchema } from "../sqlite/task-event-storage.js";
import { fileDescriptor, fail } from "./files.js";
import { eventImportSchemaSql, hasEventImports } from "../sqlite/event-imports.js";
import { eventRowSchemas, eventTables, savedPointSchema } from "../../../core/transfer/events.js";
import { authoritySql, hasAuthority, validateAuthority } from "../sqlite/project-authority.js";

function schema(db: DatabaseSync) {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all());
}

/** Read a pinned, allowlisted event snapshot; never execute arbitrary schema on restore. */
export function readEvents(path: string): DatabaseSync {
  closeSync(fileDescriptor(path, 64 * 1024 * 1024));
  const db = new DatabaseSync(path, { readOnly: true, enableDoubleQuotedStringLiterals: false });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-1024; BEGIN;");
    validateEventStore(db);
    return db;
  } catch (error) { db.close(); throw error; }
}

export function validateEventStore(db: DatabaseSync): void {
  const expected = new DatabaseSync(":memory:");
  try {
    const linked = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='task_links'").get());
    const version = Number(db.prepare("PRAGMA user_version").get()?.["user_version"]), imported = hasEventImports(db);
    if (![1, 2].includes(version) || (version === 2 ? !linked || !imported : imported)) fail("invalid_event_store", "Unsupported event companion version.");
    expected.exec(lifecycleSchemaSql);
    if (linked) expected.exec(taskLinkSchema);
    if (version === 2) expected.exec(eventImportSchemaSql + "PRAGMA user_version=2;");
    if (hasAuthority(db)) { expected.exec(authoritySql("events",linked)); validateAuthority(db); }
    if (schema(db) !== schema(expected) || db.prepare("PRAGMA application_id").get()?.["application_id"] !== 1397446995
      || db.prepare("PRAGMA integrity_check").all().some(r => r["integrity_check"] !== "ok")) {
      fail("invalid_event_store", "Unsupported or damaged event companion; existing files preserved.");
    }
    for (const table of eventTables) {
      if ((table !== "events" && !linked) || (table === "event_imports" && !imported)) continue;
      if (Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.["n"]) > (table === "event_imports" ? 20_000 : 10_000)) fail("transfer_limit", "Event companion exceeds its bounded capacity.");
      for (const row of db.prepare(`SELECT * FROM ${table}`).iterate()) eventRowSchemas[table].parse(row);
    }
    if (imported) for (const row of db.prepare("SELECT * FROM event_imports").iterate()) {
      const exists = db.prepare(`SELECT 1 FROM ${row["kind"] === "event" ? "events" : "task_links"} WHERE id=?`).get(row["id"]!);
      if (!exists || (row["kind"] === "event" ? row["source_from_seq"] !== null : row["source_from_seq"] === null)) fail("invalid_event_link", "Import origin references a missing event or link.");
    }
  } finally { expected.close(); }
}

export function validateEventPair(main: DatabaseSync, events: DatabaseSync): void {
  if (!events.prepare("SELECT 1 FROM sqlite_schema WHERE name='task_links'").get()) return;
  for (const row of events.prepare("SELECT * FROM task_links").iterate()) {
    eventRowSchemas.task_links.parse(row);
    const run = main.prepare(`SELECT r.id FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.project_id=? AND r.id=?
      AND p.project_key=? AND r.repository=? AND r.environment=?`).get(row["project_id"]!, row["run_id"]!, row["project_key"]!, row["repository"]!, row["environment"]!);
    const anchor = events.prepare(`SELECT 1 FROM events WHERE id=? AND project_key=? AND repository=? AND environment=?
      AND root_hash=? AND session_hash=? AND seq<?`).get(row["anchor_id"]!, row["project_key"]!, row["repository"]!, row["environment"]!, row["root_hash"]!, row["session_hash"]!, row["from_seq"]!);
    if (!run || !anchor) fail("invalid_event_link", "Event link has no matching task scope or anchor.");
  }
  for (const table of ["event_task_links", "event_link_failures"]) {
    for (const row of events.prepare(`SELECT * FROM ${table}`).iterate()) {
      const link = events.prepare(`SELECT l.* FROM task_links l JOIN events e ON e.id=? WHERE l.id=? AND e.seq>=l.from_seq
        AND e.project_key=l.project_key AND e.repository=l.repository AND e.environment=l.environment
        AND e.root_hash=l.root_hash AND e.session_hash=l.session_hash`).get(row["event_id"]!, row["link_id"]!);
      if (!link) fail("invalid_event_link", "Event association has no matching task link.");
      if (table === "event_link_failures") {
        if (row["status"] !== "association_unconfirmed") fail("invalid_event_link", "Unknown event failure state.");
        continue;
      }
      const saved = savedPointSchema.parse(JSON.parse(String(row["saved_json"])));
      if (saved.stage === "record") {
        const record = main.prepare("SELECT seq,recorded_at FROM records WHERE project_id=? AND run_id=? AND id=?")
          .get(link["project_id"]!, link["run_id"]!, saved.record_id);
        if (!record || record["seq"] !== saved.seq || record["recorded_at"] !== saved.recorded_at || !saved.record_visible) {
          fail("invalid_event_link", "Saved-point reference does not match its task record.");
        }
      } else if (saved.record_id !== null || saved.record_visible || saved.seq !== undefined || saved.source_seq !== undefined || saved.recorded_at !== undefined) {
        fail("invalid_event_link", "Non-record saved point contains a record reference.");
      }
      if (saved.receipt_confirmed) {
        const receipt = saved.stage === "record"
          ? main.prepare("SELECT 1 FROM receipts WHERE scope=? AND json_extract(result_json,'$.record_id')=?").get(link["project_id"]!, saved.record_id)
          : saved.stage === "start" ? main.prepare("SELECT 1 FROM receipts WHERE scope=? AND json_extract(result_json,'$.run.id')=?").get(link["project_id"]!, link["run_id"]!) : undefined;
        if (!receipt) fail("invalid_event_link", "Saved-point receipt is missing from the main snapshot.");
      }
    }
  }
}
