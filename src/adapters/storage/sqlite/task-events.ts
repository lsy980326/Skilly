import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { MemoryError, type JsonObject, parseJsonObject } from "../../../core/memory/model.js";
import type { TaskEvents } from "../../../core/memory/task-events.js";
import { openLifecycleStore } from "./lifecycle.js";
import { taskLinkSchema, lastSavedReceipt } from "./task-event-storage.js";

type Row = Record<string, SQLOutputValue>;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function text(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw new MemoryError("invalid_data", "Invalid task event metadata.");
  return value;
}

/** Sidecar links are explicit declarations; the authoritative run and saved records stay untouched. */
export class SqliteTaskEvents implements TaskEvents {
  constructor(private readonly db: DatabaseSync, private readonly path: string, private readonly root?: string) {}

  private run(projectId: string, runId: string) {
    const run = this.db.prepare(`SELECT r.*,p.project_key FROM runs r JOIN projects p ON p.id=r.project_id
      WHERE r.project_id=? AND r.id=?`).get(projectId, runId);
    if (!run) throw new MemoryError("not_found", "Task not found in this project.");
    return run;
  }

  async link(projectId: string, runId: string, observationId: string): Promise<JsonObject> {
    if (!this.root) throw new MemoryError("project_unresolved", "A launched project root is required for linking.");
    const run = this.run(projectId, runId), rootHash = hash(realpathSync(this.root));
    const events = openLifecycleStore(`${this.path}.events.sqlite`, true);
    try {
      events.exec("BEGIN IMMEDIATE");
      try {
        const anchor = events.prepare(`SELECT * FROM events WHERE id=? AND project_key=? AND repository=? AND environment=? AND root_hash=?`)
          .get(observationId, text(run, "project_key"), text(run, "repository"), text(run, "environment"), rootHash);
        if (!anchor) throw new MemoryError("scope_mismatch", "Observation is absent or belongs to another project root or scope.");
        events.exec(taskLinkSchema);
        const prior = events.prepare(`SELECT * FROM task_links WHERE project_key=? AND repository=? AND environment=? AND root_hash=? AND session_hash=? ORDER BY seq DESC LIMIT 1`)
          .get(text(run, "project_key"), text(run, "repository"), text(run, "environment"), rootHash, text(anchor, "session_hash"));
        if (prior && prior["project_id"] === projectId && prior["run_id"] === runId) {
          events.exec("COMMIT"); return this.linkReceipt(prior);
        }
        if (run["state"] !== "active") throw new MemoryError("run_closed", "Only this session's active task can be linked.");
        if (prior) {
          const old = this.db.prepare("SELECT state FROM runs WHERE project_id=? AND id=?").get(text(prior, "project_id"), text(prior, "run_id"));
          if (!old || old["state"] === "active") throw new MemoryError("link_conflict", "This session is already linked to an unfinished task. Do not take it over.");
        }
        // The host may deliver another PostToolUse before this MCP call arrives.
        // Only a session/turn boundary invalidates the supplied anchor; turn_hash
        // is opaque host metadata and may also change between ordinary tool calls.
        const boundary = events.prepare(`SELECT 1 FROM events WHERE session_hash=? AND root_hash=? AND project_key=? AND repository=? AND environment=?
          AND seq>? AND event NOT IN ('PostToolUse','PreCompact') LIMIT 1`)
          .get(text(anchor, "session_hash"), rootHash, text(run, "project_key"), text(run, "repository"), text(run, "environment"), anchor["seq"]!);
        if (boundary || !["SessionStart", "PostToolUse", "PreCompact"].includes(text(anchor, "event"))) {
          throw new MemoryError("stale_anchor", "Use an explicit observation from the current open session segment, after any interruption, stop or session restart.");
        }
        if (Number(events.prepare("SELECT count(*) n FROM task_links").get()?.["n"]) >= 10_000) throw new MemoryError("link_store_full", "Link capacity reached; no existing data was removed.");
        const from = Number(events.prepare("SELECT coalesce(max(seq),0)+1 n FROM events").get()?.["n"]);
        const id = randomUUID();
        events.prepare("INSERT INTO task_links VALUES(NULL,?,?,?,?,?,?,?,?,?,?,?)").run(id, projectId, runId,
          text(run, "project_key"), text(run, "repository"), text(run, "environment"), rootHash, text(anchor, "session_hash"), observationId, from, new Date().toISOString());
        const saved = events.prepare("SELECT * FROM task_links WHERE id=?").get(id)!;
        events.exec("COMMIT"); return this.linkReceipt(saved);
      } catch (error) { events.exec("ROLLBACK"); throw error; }
    } finally { events.close(); }
  }

  private linkReceipt(row: Row): JsonObject {
    return { status: "persisted", link_id: text(row, "id"), run_id: text(row, "run_id"),
      session_hash: text(row, "session_hash"), from_event_seq: Number(row["from_seq"]),
      linked_at: text(row, "linked_at"), linkage: "explicit_agent_binding", retrospective: false,
      claims_verified: false, automatic_replay: false };
  }

  interruptions(projectId: string, runIds: string[]): Set<string> | undefined {
    if (runIds.length > 40) throw new MemoryError("invalid_input", "Read at most 40 task summaries.");
    if (!runIds.length) return new Set();
    let events: DatabaseSync | undefined;
    try {
      events = openLifecycleStore(`${this.path}.events.sqlite`);
      if (!events.prepare("SELECT 1 FROM sqlite_master WHERE name='event_task_links'").get()) return new Set();
      return new Set(events.prepare(`SELECT DISTINCT l.run_id FROM task_links l JOIN event_task_links x ON x.link_id=l.id JOIN events e ON e.id=x.event_id
        WHERE l.project_id=? AND e.event='Interrupt' AND l.run_id IN (${runIds.map(()=>"?").join(",")})`).all(projectId,...runIds).map(row=>text(row,"run_id")));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return new Set();
      return undefined;
    } finally { events?.close(); }
  }

  status(projectId: string, runId: string): JsonObject {
    const run = this.run(projectId, runId);
    const base = { run_id: runId, task_state: text(run, "state"), last_saved: lastSavedReceipt(this.db, projectId, runId),
      claims_verified: false, missing_record_count: null, live_execution: "unknown", automatic_replay: false };
    let events: DatabaseSync | undefined;
    try {
      events = openLifecycleStore(`${this.path}.events.sqlite`);
      if (!events.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_links'").get()) return { ...base, linkage: "not_linked", events: [] };
      const args = [projectId, runId, text(run, "project_key"), text(run, "repository"), text(run, "environment"),
        ...(this.root ? [hash(realpathSync(this.root))] : [])];
      const where = `l.project_id=? AND l.run_id=? AND l.project_key=? AND l.repository=? AND l.environment=? ${this.root ? "AND l.root_hash=?" : ""}`;
      const linked = events.prepare(`SELECT 1 FROM task_links l WHERE ${where} LIMIT 1`).get(...args);
      if (!linked) return { ...base, linkage: "not_linked", events: [] };
      const select = `SELECT e.id,e.event,e.received_at,e.seq,x.saved_json FROM events e JOIN event_task_links x ON x.event_id=e.id
        JOIN task_links l ON l.id=x.link_id WHERE ${where}`;
      const rows = events.prepare(`${select} ORDER BY e.seq DESC LIMIT 21`).all(...args);
      const project = (row: Row) => ({ observation_id: text(row, "id"), event: text(row, "event"), received_at: text(row, "received_at"),
        saved_during_event: parseJsonObject(text(row, "saved_json")) });
      const interrupted = events.prepare(`${select} AND e.event='Interrupt' ORDER BY e.seq DESC LIMIT 1`).get(...args);
      const issue = events.prepare(`SELECT count(*) n FROM event_link_failures f JOIN task_links l ON l.id=f.link_id WHERE ${where}`).get(...args);
      return { ...base, linkage: "explicit_agent_binding", event_status: "available", events: rows.slice(0,20).map(project),
        interruption: interrupted ? project(interrupted) : null, latest_event: rows[0] ? project(rows[0]) : null,
        association_unconfirmed: Number(issue?.["n"] ?? 0), history_truncated: rows.length>20,
        limitation: "Only future events captured while the explicitly linked task was active are associated. No cross-database atomic cutoff, live status, or completeness guarantee." };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { ...base, linkage: "not_linked", events: [] };
      return { ...base, linkage: "unavailable", events_status: "unavailable" };
    } finally { events?.close(); }
  }
}
