import { closeSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { lifecycleEvents, lifecycleSchemaSql } from "../sqlite/lifecycle.js";
import { taskLinkSchema } from "../sqlite/task-event-storage.js";
import { fileDescriptor, fail } from "./files.js";

const id = z.string().regex(/^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const scope = z.string().min(1).max(100), time = z.iso.datetime();
const savedSchema = z.strictObject({ stage: z.enum(["record", "start", "unknown"]), record_id: z.uuid().nullable(),
  seq: z.int().positive().optional(), recorded_at: time.optional(), record_visible: z.boolean(), receipt_confirmed: z.boolean(),
  read_at: time, meaning: z.literal("Record visible during hook processing; not an atomic cutoff across databases.") });
function schema(db: DatabaseSync) {
  return JSON.stringify(db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name").all());
}

/** Read a pinned, allowlisted event snapshot; never execute arbitrary schema on restore. */
export function readEvents(path: string): DatabaseSync {
  closeSync(fileDescriptor(path, 64 * 1024 * 1024));
  const db = new DatabaseSync(path, { readOnly: true, enableDoubleQuotedStringLiterals: false });
  const expected = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-1024; BEGIN;");
    const linked = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='task_links'").get());
    expected.exec(lifecycleSchemaSql);
    if (linked) expected.exec(taskLinkSchema);
    if (schema(db) !== schema(expected) || db.prepare("PRAGMA application_id").get()?.["application_id"] !== 1397446995
      || db.prepare("PRAGMA user_version").get()?.["user_version"] !== 1
      || db.prepare("PRAGMA integrity_check").all().some(r => r["integrity_check"] !== "ok")) {
      fail("invalid_event_store", "Unsupported or damaged event companion; existing files preserved.");
    }
    for (const table of linked ? ["events", "task_links", "event_task_links", "event_link_failures"] : ["events"]) {
      if (Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.["n"]) > 10_000) fail("transfer_limit", "Event companion exceeds its bounded capacity.");
    }
    for (const row of db.prepare("SELECT * FROM events").iterate()) {
      z.strictObject({ seq: z.int().positive(), id, project_key: scope, repository: scope, environment: scope, root_hash: hash,
        session_hash: hash, turn_hash: hash.nullable(), event: z.enum(lifecycleEvents), source: z.enum(["startup", "resume", "clear", "compact", "fork"]).nullable(),
        tool_group: z.enum(["shell", "edit", "mcp", "other"]).nullable(), received_at: time }).parse(row);
    }
    return db;
  } catch (error) { db.close(); throw error; }
  finally { expected.close(); }
}

export function validateEventPair(main: DatabaseSync, events: DatabaseSync): void {
  if (!events.prepare("SELECT 1 FROM sqlite_schema WHERE name='task_links'").get()) return;
  for (const row of events.prepare("SELECT * FROM task_links").iterate()) {
    z.strictObject({ seq: z.int().positive(), id: z.uuid(), project_id: z.uuid(), run_id: z.uuid(), project_key: scope,
      repository: scope, environment: scope, root_hash: hash, session_hash: hash, anchor_id: id, from_seq: z.int().positive(), linked_at: time }).parse(row);
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
      const saved = savedSchema.parse(JSON.parse(String(row["saved_json"])));
      if (saved.stage === "record") {
        const record = main.prepare("SELECT seq,recorded_at FROM records WHERE project_id=? AND run_id=? AND id=?")
          .get(link["project_id"]!, link["run_id"]!, saved.record_id);
        if (!record || record["seq"] !== saved.seq || record["recorded_at"] !== saved.recorded_at || !saved.record_visible) {
          fail("invalid_event_link", "Saved-point reference does not match its task record.");
        }
      } else if (saved.record_id !== null || saved.record_visible || saved.seq !== undefined || saved.recorded_at !== undefined) {
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
