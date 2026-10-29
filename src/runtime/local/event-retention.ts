import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { MemoryError } from "../../core/memory/model.js";
import { readEvents, validateEventPair, validateEventStore } from "../../adapters/storage/transfer/events.js";
import { readDatabase } from "../../adapters/storage/transfer/database.js";
import { safePath } from "../../adapters/storage/transfer/files.js";
import { openLifecycleStore } from "../../adapters/storage/sqlite/lifecycle.js";
import { eventCapacity, initializeEventRetention } from "../../adapters/storage/sqlite/event-retention.js";
import { taskLinkSchema } from "../../adapters/storage/sqlite/task-event-storage.js";
import { eventImportSchemaSql } from "../../adapters/storage/sqlite/event-imports.js";
import { hasAuthority } from "../../adapters/storage/sqlite/project-authority.js";
import { DatabaseSync } from "node:sqlite";

function preview(path: string, db: DatabaseSync) {
  const stat = lstatSync(path), mainStat = lstatSync(path.slice(0,-".events.sqlite".length)), capacity = eventCapacity(db);
  const max = db.prepare("SELECT coalesce(max(seq),0) n FROM events").get()?.["n"];
  const linked = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='task_links'").get();
  const linkMax = linked ? db.prepare("SELECT coalesce(max(seq),0) n FROM task_links").get()?.["n"] : 0;
  const expected = createHash("sha256").update(JSON.stringify([path,mainStat.dev,mainStat.ino,stat.dev,stat.ino,capacity,max,linkMax])).digest("hex");
  return { status: "preview", expect: expected, event_retention: capacity,
    event_store_managed: hasAuthority(db),
    change: capacity.mode === "legacy" ? "enable_retained_windows" : "already_enabled",
    existing_rows_changed: false, missed_events_recovered: false, needs_fresh_binding_after_enable: capacity.mode === "legacy",
    limitation: "Whole-DB backup/restore supported. Project export/merge/cutover/portable transfer of retained windows is not supported yet." };
}

/** Explicit maintenance only. Hook readers/writers never enable retention. */
export function eventRetentionCommand(command: string, options: { db?: string; expect?: string }) {
  if (!["events-retention-status","events-retention-enable"].includes(command)) throw new MemoryError("invalid_command","Unknown event retention command.");
  if (!options.db || (command === "events-retention-enable" ? !/^[a-f0-9]{64}$/.test(options.expect ?? "") : options.expect !== undefined))
    throw new MemoryError("invalid_input", "Use events-retention-status --db, then events-retention-enable --db --expect <preview-hash>.");
  const path = `${options.db}.events.sqlite`; safePath(options.db); safePath(path);
  if (command === "events-retention-status") {
    const db = readEvents(path); try { return preview(path,db); } finally { db.close(); }
  }
  const checked = readDatabase(options.db); checked.close();
  const main = new DatabaseSync(options.db);
  try {
    // Share the main-first gate with transfer fencing. It is a lock only; no
    // main rows are changed. Hold it until the companion activation commits.
    main.exec("PRAGMA busy_timeout=200; BEGIN IMMEDIATE");
    const db = openLifecycleStore(path,true);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        validateEventStore(db);
        const before = preview(path,db);
        if (before.expect !== options.expect) throw new MemoryError("event_store_changed", "Event storage changed since preview. Review a fresh preview; nothing was activated.");
        validateEventPair(main,db);
        const mainManaged = hasAuthority(main);
        if (before.change !== "already_enabled") {
          if (mainManaged || hasAuthority(db))
            throw new MemoryError("unsupported_event_retention_transfer", "Managed transfer stores cannot enable retained windows until their recovery workflow supports this capability. No authority or data was changed.");
          db.exec(taskLinkSchema + eventImportSchemaSql);
          initializeEventRetention(db);
          validateEventStore(db);
        }
        const capacity = eventCapacity(db);
        db.exec("COMMIT");
        return { status: "persisted", event_retention: capacity, existing_rows_changed: false,
          missed_events_recovered: false, automatic_replay: false, claims_verified: false };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
  } finally { if (main.isTransaction) main.exec("ROLLBACK"); main.close(); }
}
