import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, realpathSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { loadProjectBinding } from "../../project/binding.js";
import type { ProjectBinding } from "../../../core/memory/binding.js";
import { MemoryError } from "../../../core/memory/model.js";
import { captureTaskEvent } from "./task-event-storage.js";
import { hasEventImports, nativeOnly } from "./event-imports.js";

export const lifecycleEvents = ["SessionStart", "PostToolUse", "PreCompact", "Stop", "Interrupt", "SessionEnd"] as const;
const application = 1397446995;
export const lifecycleSchemaSql = `CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
          project_key TEXT NOT NULL, repository TEXT NOT NULL, environment TEXT NOT NULL,
          root_hash TEXT NOT NULL, session_hash TEXT NOT NULL, turn_hash TEXT,
          event TEXT NOT NULL, source TEXT, tool_group TEXT, received_at TEXT NOT NULL) STRICT;
          CREATE INDEX event_scope ON events(project_key, repository, environment, root_hash, seq DESC);
          PRAGMA application_id=${application}; PRAGMA user_version=1;`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const text = z.string().min(1).max(256);
const inputSchema = z.object({ hook_event_name: z.enum(lifecycleEvents), session_id: text,
  cwd: z.string().min(1).max(4096), turn_id: text.optional(), tool_use_id: text.optional(),
  source: z.enum(["startup", "resume", "clear", "compact", "fork"]).optional(),
  tool_name: z.string().max(256).optional() });
const observationSchema = z.strictObject({ observation_id: text, session_hash: z.string().regex(/^[a-f0-9]{64}$/),
  turn_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), event: z.enum(lifecycleEvents),
  source: z.string().nullable(), tool_group: z.enum(["shell", "edit", "mcp", "other"]).nullable(), received_at: z.iso.datetime() });

// This is bounded event telemetry, not a second work journal or a task write queue.
// Store an allowlist only: never prompts, transcripts, commands, tool input or output.
export function recordLifecycle(dbPath: string, root: string, value: unknown) {
  const parsed = inputSchema.safeParse(value);
  if (!parsed.success) throw new MemoryError("invalid_hook_event", "Unsupported or invalid lifecycle event.");
  const input = parsed.data;
  if (!isAbsolute(dbPath) || !isAbsolute(root) || !isAbsolute(input.cwd)
    || realpathSync(input.cwd) !== realpathSync(root)) {
    throw new MemoryError("scope_mismatch", "Hook cwd must match the explicitly configured project root.");
  }
  const binding = loadProjectBinding(root);
  // Prevent writes through symbolic parent directories; no permissions are changed.
  let parent = dirname(dbPath);
  while (true) {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new MemoryError("invalid_path", "Use regular event storage directories.");
    const next = dirname(parent); if (next === parent) break; parent = next;
  }
  const path = `${dbPath}.events.sqlite`;
  try { closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)); }
  catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; }
  regular(path);
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=200; PRAGMA synchronous=FULL; PRAGMA cache_size=-512; BEGIN IMMEDIATE;");
    try {
      const app = db.prepare("PRAGMA application_id").get()?.["application_id"];
      const version = db.prepare("PRAGMA user_version").get()?.["user_version"];
      if (app === 0 && version === 0 && db.prepare("SELECT count(*) AS n FROM sqlite_master").get()?.["n"] === 0) {
        db.exec(lifecycleSchemaSql);
      } else validate(db);
      const id = input.hook_event_name === "PostToolUse" && input.tool_use_id
        ? hash(JSON.stringify([binding.key, binding.repository, binding.environment, realpathSync(root), input.session_id, input.tool_use_id])) : randomUUID();
      if (db.prepare("SELECT id FROM events WHERE id=?").get(id)) { db.exec("COMMIT"); return receipt(id); }
      if (Number(db.prepare("SELECT count(*) AS n FROM events").get()?.["n"]) >= 10_000) {
        throw new MemoryError("event_store_full", "Event capacity reached. Existing observations were preserved; this event was not retained.");
      }
      const tool = input.tool_name === "Bash" ? "shell" : input.tool_name === "apply_patch" ? "edit"
        : input.tool_name?.startsWith("mcp__") ? "mcp" : input.tool_name ? "other" : null;
      db.prepare("INSERT INTO events VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id,
        binding.key, binding.repository, binding.environment, hash(realpathSync(root)), hash(input.session_id),
        input.turn_id ? hash(input.turn_id) : null, input.hook_event_name, input.source ?? null, tool, new Date().toISOString());
      captureTaskEvent(db, dbPath, id);
      db.exec("COMMIT"); return receipt(id);
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

function receipt(id: string) {
  return { observation_id: id, delivery_status: "saved", work_record_saved: false,
    provenance: "local_hook_input", claims_verified: false };
}
function regular(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new MemoryError("invalid_path", "Event store must be a regular file.");
}
function validate(db: DatabaseSync) {
  if (db.prepare("PRAGMA application_id").get()?.["application_id"] !== application
    || ![1, 2].includes(Number(db.prepare("PRAGMA user_version").get()?.["user_version"]))) {
    throw new MemoryError("unsupported_event_store", "Unsupported event store; existing data was preserved.");
  }
}

export function openLifecycleStore(path: string, writable = false) {
  regular(path);
  const db = new DatabaseSync(path, { readOnly: !writable });
  try {
    db.exec("PRAGMA busy_timeout=200;");
    if (!writable) db.exec("PRAGMA query_only=ON;");
    else db.exec("PRAGMA synchronous=FULL;");
    validate(db); return db;
  } catch (error) { db.close(); throw error; }
}

export function readLifecycle(dbPath: string, binding: ProjectBinding, root: string) {
  const base = { provenance: "local_hook_input", claims_verified: false, authenticity: "not_attested",
    work_record_linkage: "not_observed", completeness: "unknown", missing_record_count: null,
    hook_loading: "not_verified", automatic_replay: false } as const;
  const path = `${dbPath}.events.sqlite`;
  let db: DatabaseSync | undefined;
  try {
    try { regular(path); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { ...base, status: "not_observed", items: [] };
      throw error;
    }
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=200;"); validate(db);
    const items = db.prepare(`SELECT id AS observation_id, session_hash, turn_hash, event, source, tool_group, received_at
      FROM events WHERE project_key=? AND repository=? AND environment=? AND root_hash=? ${nativeOnly(db, "event", "events.id")} ORDER BY seq DESC LIMIT 20`)
      .all(binding.key, binding.repository, binding.environment, hash(realpathSync(root))).map(row => observationSchema.parse(row));
    const imported = hasEventImports(db) ? db.prepare(`SELECT e.id AS observation_id,e.session_hash,e.turn_hash,e.event,e.source,e.tool_group,e.received_at
      FROM events e JOIN event_imports origin ON origin.kind='event' AND origin.id=e.id
      WHERE e.project_key=? AND e.repository=? AND e.environment=? ORDER BY e.seq DESC LIMIT 20`).all(binding.key,binding.repository,binding.environment).map(row => observationSchema.parse(row)) : [];
    return { ...base, status: items.length ? "observations_available" : "not_observed", items,
      ...(imported.length ? { imported_observations: { items: imported, current_session_binding: false, root_scope: "original_locations", provenance: "project_import_history" } } : {}),
      limit: 20, interruption_meaning: "Interrupt observes a user interruption, not a task finish. Stop is a turn boundary, not task completion." };
  } catch { return { ...base, status: "unavailable", error: "Event observations could not be read; no empty-success or retention claim is made." }; }
  finally { db?.close(); }
}
