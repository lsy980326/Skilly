import type { DatabaseSync } from "node:sqlite";
import { MemoryError } from "../../../core/memory/model.js";

export const EVENT_WINDOW_LIMIT = 10_000;
export const EVENT_MAX_WINDOWS = 8;
export const EVENT_BODY_LIMIT = 64 * 1024 * 1024;
export const EVENT_RETAINED_LIMIT = EVENT_WINDOW_LIMIT * EVENT_MAX_WINDOWS;

// Windows are storage ranges, not session boundaries. Existing rows and saved
// points never move. Only explicit activation establishes a new capture epoch.
export const eventRetentionSchemaSql = `CREATE TABLE event_retention (
  id INTEGER PRIMARY KEY CHECK(id=1), capture_from_seq INTEGER NOT NULL CHECK(capture_from_seq>0),
  capture_from_link_seq INTEGER NOT NULL CHECK(capture_from_link_seq>0), activated_at TEXT NOT NULL) STRICT;
  CREATE TABLE event_windows (id INTEGER PRIMARY KEY CHECK(id>0), first_seq INTEGER NOT NULL UNIQUE CHECK(first_seq>0), opened_at TEXT NOT NULL) STRICT;
  CREATE TRIGGER event_retention_no_update BEFORE UPDATE ON event_retention BEGIN SELECT RAISE(ABORT,'immutable_event_retention'); END;
  CREATE TRIGGER event_retention_no_delete BEFORE DELETE ON event_retention BEGIN SELECT RAISE(ABORT,'immutable_event_retention'); END;
  CREATE TRIGGER event_retention_no_replace BEFORE INSERT ON event_retention WHEN EXISTS(SELECT 1 FROM event_retention)
    BEGIN SELECT RAISE(ABORT,'immutable_event_retention'); END;
  CREATE TRIGGER event_windows_no_update BEFORE UPDATE ON event_windows BEGIN SELECT RAISE(ABORT,'immutable_event_window'); END;
  CREATE TRIGGER event_windows_no_delete BEFORE DELETE ON event_windows BEGIN SELECT RAISE(ABORT,'immutable_event_window'); END;
  CREATE TRIGGER event_windows_no_replace BEFORE INSERT ON event_windows WHEN EXISTS(SELECT 1 FROM event_windows WHERE id=NEW.id OR first_seq=NEW.first_seq)
    BEGIN SELECT RAISE(ABORT,'immutable_event_window'); END;`;

export function retainedEvents(db: DatabaseSync) {
  return Number(db.prepare("PRAGMA user_version").get()?.["user_version"]) === 3;
}
const count = (db: DatabaseSync, table: string) => Number(db.prepare(`SELECT count(*) n FROM ${table}`).get()?.["n"]);
const invalid = () => { throw new MemoryError("invalid_event_retention", "Invalid event retention metadata; existing observations were preserved."); };
function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return invalid();
  return value;
}
export function captureFloor(db: DatabaseSync) {
  if (!retainedEvents(db)) return { event: 1, link: 1 };
  const row = db.prepare("SELECT * FROM event_retention WHERE id=1").get();
  if (!row) return invalid();
  return { event: positive(row["capture_from_seq"]), link: positive(row["capture_from_link_seq"]) };
}
export function eventCapacity(db: DatabaseSync, validateRanges = true) {
  const own = !db.isTransaction;
  if (own) db.exec("BEGIN");
  try { return capacitySnapshot(db,validateRanges); }
  finally { if (own) db.exec("ROLLBACK"); }
}
function capacitySnapshot(db: DatabaseSync, validateRanges: boolean) {
  const retained = retainedEvents(db), total = count(db, "events");
  const linked = Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='task_links'").get());
  const links = linked ? count(db, "task_links") : 0;
  const pageSize = Number(db.prepare("PRAGMA page_size").get()?.["page_size"]);
  const bytes = Number(db.prepare("PRAGMA page_count").get()?.["page_count"]) * pageSize;
  const reserve = 32 * pageSize;
  let active = total, windows = 1;
  if (retained) {
    const rows = db.prepare("SELECT * FROM event_windows ORDER BY id LIMIT 9").all();
    const floor = captureFloor(db);
    if (!rows.length || rows.length > EVENT_MAX_WINDOWS || count(db,"event_retention") !== 1 || rows[0]?.["first_seq"] !== 1) return invalid();
    let prior = 0;
    for (const [i, row] of rows.entries()) {
      const first = positive(row["first_seq"]);
      if (row["id"] !== i+1 || first <= prior || !Number.isFinite(Date.parse(String(row["opened_at"])))) return invalid();
      const next = rows[i+1]?.["first_seq"];
      if (validateRanges || i === rows.length-1) {
        const n = Number(db.prepare("SELECT count(*) n FROM events WHERE seq>=? AND (? IS NULL OR seq<?)").get(first, next ?? null, next ?? null)?.["n"]);
        if (n > EVENT_WINDOW_LIMIT || (next !== undefined && first >= floor.event && n !== EVENT_WINDOW_LIMIT)) return invalid();
        active = n;
      }
      prior = first;
    }
    const max = Number(db.prepare("SELECT coalesce(max(seq),0) n FROM events").get()?.["n"]);
    const maxLink = Number(db.prepare("SELECT coalesce(max(seq),0) n FROM task_links").get()?.["n"]);
    const activated = db.prepare("SELECT activated_at FROM event_retention WHERE id=1").get()?.["activated_at"];
    if (prior > max+1 || floor.link > maxLink+1 || !Number.isFinite(Date.parse(String(activated)))
      || !rows.slice(0,2).some(r => r["first_seq"] === floor.event)) return invalid();
    windows = rows.length;
  }
  const linkLimit = retained ? EVENT_RETAINED_LIMIT : EVENT_WINDOW_LIMIT;
  const state = retained && bytes + reserve >= EVENT_BODY_LIMIT ? "storage_full"
    : active < EVENT_WINDOW_LIMIT ? "ready" : !retained ? "activation_required"
    : windows < EVENT_MAX_WINDOWS ? "rollover_ready" : "retention_full";
  return { schema_version: Number(db.prepare("PRAGMA user_version").get()?.["user_version"]),
    mode: retained ? "retained_windows" : "legacy", capture_status: state,
    scope: "shared_event_store", total_events: total, active_events: active, archived_events: total-active,
    window_limit: EVENT_WINDOW_LIMIT, windows, max_windows: retained ? EVENT_MAX_WINDOWS : 1,
    remaining_in_window: Math.max(0,EVENT_WINDOW_LIMIT-active), body_bytes: bytes, body_limit_bytes: EVENT_BODY_LIMIT,
    write_reserve_bytes: reserve,
    task_links: links, task_link_limit: linkLimit, task_link_status: links >= linkLimit ? "full" : "ready",
    automatic_activation: false, automatic_deletion: false, missing_event_count: null, completeness: "unknown",
    temporary_files_included: false, claims_verified: false };
}

/** Caller owns BEGIN IMMEDIATE. Never called from readers or hook setup. */
export function initializeEventRetention(db: DatabaseSync) {
  if (retainedEvents(db)) return;
  if (count(db,"events") > EVENT_WINDOW_LIMIT) return invalid();
  const event = Number(db.prepare("SELECT coalesce(max(seq),0)+1 n FROM events").get()?.["n"]);
  const link = Number(db.prepare("SELECT coalesce(max(seq),0)+1 n FROM task_links").get()?.["n"]);
  positive(event); positive(link);
  const now = new Date().toISOString();
  db.exec(eventRetentionSchemaSql);
  db.prepare("INSERT INTO event_retention VALUES(1,?,?,?)").run(event,link,now);
  db.prepare("INSERT INTO event_windows VALUES(1,1,?)").run(now);
  if (event > 1) db.prepare("INSERT INTO event_windows VALUES(2,?,?)").run(event,now);
  db.exec("PRAGMA user_version=3;");
  assertEventBodyBudget(db);
}

/** Serialized with the event INSERT, so retries and concurrent writers cannot rotate twice. */
export function prepareEventCapacity(db: DatabaseSync) {
  const status = eventCapacity(db);
  if (status.capture_status === "ready") return;
  if (status.capture_status === "rollover_ready") {
    const first = positive(Number(db.prepare("SELECT coalesce(max(seq),0)+1 n FROM events").get()?.["n"]));
    db.prepare("INSERT INTO event_windows VALUES(?,?,?)").run(status.windows+1,first,new Date().toISOString());
    return;
  }
  throw new MemoryError("event_store_full", `Event collection stopped (${status.capture_status}). Existing observations were preserved; this event was not retained or queued.`);
}
export function assertEventBodyBudget(db: DatabaseSync) {
  if (retainedEvents(db) && eventCapacity(db).body_bytes > EVENT_BODY_LIMIT)
    throw new MemoryError("event_store_full", "Event DB body budget exceeded; the new write was rolled back. No existing observation was removed.");
}

export function requireLegacyEventTransfer(db: DatabaseSync | undefined) {
  if (db && retainedEvents(db)) throw new MemoryError("unsupported_event_retention_transfer",
    "Retained event windows require a whole-DB backup. Project export/merge/portable transfer does not preserve this capability yet; no output or write transition was started.");
}
