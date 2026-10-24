import { closeSync, constants, fsyncSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { eventRowSchemas, eventTables, savedPointSchema, type EventTable } from "../../../core/transfer/events.js";
import { MAX_DATA_BYTES, MAX_LINE_BYTES, MAX_ROWS, type Manifest } from "../../../core/transfer/format.js";
import { bundleLines, digest, fail } from "./files.js";
import { hasEventImports } from "../sqlite/event-imports.js";

type Row = Record<string, SQLOutputValue>;
export type SourceRecords = Map<string, { seq: number; run: string; recordedAt: string }>;
type Scope = { id: string; key: string; runs: Set<string>; records: SourceRecords };
const columns = (table: EventTable) => Object.keys(eventRowSchemas[table].shape);
function selection(table: EventTable) {
  if (table === "events") return "SELECT * FROM events WHERE ?1 IS NOT NULL AND project_key=?2 ORDER BY seq";
  if (table === "task_links") return "SELECT * FROM task_links WHERE project_id=?1 AND project_key=?2 ORDER BY seq";
  if (table === "event_imports") return `SELECT * FROM event_imports WHERE
    (kind='event' AND id IN(SELECT id FROM events WHERE project_key=?2)) OR
    (kind='link' AND id IN(SELECT id FROM task_links WHERE project_id=?1 AND project_key=?2)) ORDER BY kind,id`;
  return `SELECT x.* FROM ${table} x JOIN task_links l ON l.id=x.link_id WHERE l.project_id=?1 AND l.project_key=?2 ORDER BY x.event_id`;
}
export function exportProjectEvents(events: DatabaseSync, projectId: string, key: string, output: string, usedBytes: number, usedRows: number) {
  const path = join(output, "events.ndjson"), fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let bytes = usedBytes, count = usedRows;
  const linked = Boolean(events.prepare("SELECT 1 FROM sqlite_schema WHERE name='task_links'").get());
  try {
    for (const table of eventTables) {
      if ((table !== "events" && !linked) || (table === "event_imports" && !hasEventImports(events))) continue;
      for (const raw of events.prepare(selection(table)).iterate(projectId, key)) {
        const row = eventRowSchemas[table].parse(raw), line = Buffer.from(JSON.stringify({ table, row }) + "\n");
        if (line.length > MAX_LINE_BYTES || (bytes += line.length) > MAX_DATA_BYTES || ++count > MAX_ROWS)
          fail("transfer_limit", "Project and event history exceed the bounded bundle size.");
        for (let offset = 0; offset < line.length;) offset += writeSync(fd, line, offset);
      }
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return { descriptor: digest(path), rows: count - usedRows };
}

export function scanProjectEvents(fd: number, manifest: Manifest, scope: Scope, visit: (table: EventTable, row: Row) => void) {
  const events = new Map<string, Row>(), links = new Map<string, Row>(), keys = new Map<EventTable, Set<string>>();
  let count = 0, last = -1;
  const sameScope = (event: Row, link: Row) => ["project_key", "repository", "environment", "root_hash", "session_hash"].every(k => event[k] === link[k]);
  for (const line of bundleLines(fd)) {
    const entry: unknown = JSON.parse(line);
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join() !== "row,table"
      || !("table" in entry) || !("row" in entry) || !eventTables.includes(entry.table as EventTable)) fail("invalid_bundle", "Unknown event entry.");
    const table = entry.table as EventTable, order = eventTables.indexOf(table), row: Row = eventRowSchemas[table].parse(entry.row);
    if (order < last || ++count > MAX_ROWS) fail("invalid_bundle", "Invalid event row order or count."); last = order;
    const seen = keys.get(table) ?? new Set<string>(), key = String(table === "event_imports" ? row["kind"] + ":" + row["id"] : row["id"] ?? row["event_id"]);
    if (seen.has(key)) fail("import_conflict", "Duplicate event identity."); seen.add(key); keys.set(table, seen);
    if (seen.size > (table === "event_imports" ? 20_000 : 10_000)) fail("transfer_limit", "Event table exceeds its bounded capacity.");
    if (table === "events") {
      if (row["project_key"] !== scope.key) fail("scope_mismatch", "Bundle contains another project's event.");
      events.set(String(row["id"]), row);
    } else if (table === "task_links") {
      const anchor = events.get(String(row["anchor_id"]));
      if (row["project_id"] !== scope.id || row["project_key"] !== scope.key || !scope.runs.has(String(row["run_id"]))
        || !anchor || !sameScope(anchor, row) || Number(anchor["seq"]) >= Number(row["from_seq"])) fail("invalid_event_link", "Task link has a foreign or absent anchor.");
      links.set(String(row["id"]), row);
    } else if (table === "event_imports") {
      if (!(row["kind"] === "event" ? events.has(String(row["id"])) && row["source_from_seq"] === null : links.has(String(row["id"])) && row["source_from_seq"] !== null))
        fail("invalid_event_link", "Import origin has a foreign or absent identity.");
    } else {
      const link = links.get(String(row["link_id"])), event = events.get(String(row["event_id"]));
      if (!link || !event || !sameScope(event, link) || Number(event["seq"]) < Number(link["from_seq"])) fail("invalid_event_link", "Association has no matching scoped event/link.");
      if (table === "event_task_links") {
        const saved = savedPointSchema.parse(JSON.parse(String(row["saved_json"])));
        if (saved.stage === "record") {
          const record = scope.records.get(saved.record_id ?? "");
          if (!record || record.run !== link["run_id"] || record.seq !== saved.seq || record.recordedAt !== saved.recorded_at || !saved.record_visible)
            fail("invalid_event_link", "Historical saved point does not match its source record identity and sequence.");
        } else if (saved.record_id !== null || saved.seq !== undefined || saved.source_seq !== undefined || saved.recorded_at !== undefined || saved.record_visible)
          fail("invalid_event_link", "Non-record saved point contains a record reference.");
      }
    }
    visit(table, row);
  }
  if (count !== manifest.event_rows) fail("invalid_bundle", "Event row count mismatch.");
}

export function importProjectEvents(fd: number, manifest: Manifest, scope: Scope, main: DatabaseSync, target: DatabaseSync) {
  const eventOffset = Number(target.prepare("SELECT coalesce(max(seq),0) n FROM events").get()?.["n"]);
  const linkOffset = Number(target.prepare("SELECT coalesce(max(seq),0) n FROM task_links").get()?.["n"]);
  const origins = new Map<string, Row>();
  const shift = (value: SQLOutputValue | undefined, offset: number) => {
    const shifted = Number(value) + offset; if (!Number.isSafeInteger(shifted) || shifted <= 0) fail("transfer_limit", "Event sequence exceeds its safe range."); return shifted;
  };
  scanProjectEvents(fd, manifest, scope, (table, source) => {
    if (table === "event_imports") { origins.set(String(source["kind"]) + ":" + String(source["id"]), source); return; }
    const row = { ...source };
    if (table === "events" || table === "task_links") {
      const kind = table === "events" ? "event" : "link";
      origins.set(kind + ":" + source["id"], { kind, id: source["id"]!, source_seq: source["seq"]!,
        source_from_seq: table === "task_links" ? source["from_seq"]! : null, source_bundle_hash: manifest.files.events!.sha256 });
      row["seq"] = shift(row["seq"], table === "events" ? eventOffset : linkOffset);
      if (table === "task_links") row["from_seq"] = shift(row["from_seq"], eventOffset);
    } else if (table === "event_task_links") {
      const saved = savedPointSchema.parse(JSON.parse(String(row["saved_json"])));
      if (saved.stage === "record") {
        const record = main.prepare("SELECT seq FROM records WHERE project_id=? AND id=?").get(scope.id, saved.record_id);
        if (!record) fail("invalid_event_link", "Imported saved record is missing.");
        row["saved_json"] = JSON.stringify({ ...saved, source_seq: saved.source_seq ?? saved.seq, seq: Number(record["seq"]) });
      }
    }
    const names = columns(table);
    target.prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map(name => row[name] as SQLInputValue));
  });
  const names = columns("event_imports");
  for (const origin of origins.values()) target.prepare(`INSERT INTO event_imports (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`).run(...names.map(k => origin[k] as SQLInputValue));
}
