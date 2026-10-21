import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { MemoryError } from "../../../core/memory/model.js";
import { executionRowSchema, executionProjection, type ExecutionRow } from "../../../core/execution/model.js";

export function validateExecutionData(db: DatabaseSync): void {
  for (const row of db.prepare("SELECT * FROM executions").iterate()) {
    if (!executionRowSchema.safeParse(row).success) throw new MemoryError("invalid_data", "Invalid process observation.");
  }
  if (db.prepare(`SELECT 1 FROM executions e JOIN records r ON r.project_id=e.project_id AND r.id=e.record_id
    WHERE e.run_id != r.run_id LIMIT 1`).get()) throw new MemoryError("scope_mismatch", "Execution record belongs to another task.");
}

export class SqliteExecutions {
  constructor(private readonly db: DatabaseSync) {}
  start(input: { project_id: string; run_id: string; record_id?: string; executable: string; command_hash: string }): string {
    // Validate before any process runs. Keep association checks and insertion atomic.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const run = this.db.prepare("SELECT state FROM runs WHERE project_id=? AND id=?").get(input.project_id, input.run_id);
      if (!run || run["state"] !== "active") throw new MemoryError("run_closed", "Execution requires an active task in this project.");
      if (input.record_id && !this.db.prepare("SELECT 1 FROM records WHERE project_id=? AND run_id=? AND id=?").get(input.project_id, input.run_id, input.record_id)) {
        throw new MemoryError("scope_mismatch", "Record belongs to another task.");
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO executions (id,project_id,run_id,record_id,source,executable,command_hash,started_at,outcome)
        VALUES (?,?,?,?,'local_runner',?,?,?,'unconfirmed')`).run(id, input.project_id, input.run_id, input.record_id ?? null, input.executable, input.command_hash, new Date().toISOString());
      this.db.exec("COMMIT");
      return id;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  finish(id: string, result: Pick<ExecutionRow, "outcome" | "exit_code" | "signal" | "error_code" | "duration_ms" | "stdout_bytes" | "stderr_bytes" | "stdout_hash" | "stderr_hash" | "stdout_hashed_bytes" | "stderr_hashed_bytes" | "output_complete">): void {
    const row = this.db.prepare("SELECT * FROM executions WHERE id=?").get(id);
    if (!row || row["ended_at"] !== null) throw new MemoryError("conflict", "Execution is absent or already finalized; never rerun a command to retry its storage.");
    const complete = executionRowSchema.parse({ ...row, ...result, ended_at: new Date().toISOString() });
    const names = ["ended_at", ...Object.keys(result)] as (keyof typeof complete)[];
    const saved = this.db.prepare(`UPDATE executions SET ${names.map(name => `${name}=?`).join(",")} WHERE id=? AND ended_at IS NULL`)
      .run(...names.map(name => complete[name]), id);
    if (saved.changes !== 1) throw new MemoryError("conflict", "Execution finalization is unconfirmed.");
  }
  list(projectId: string, runId: string, offset = 0, recordId?: string) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new MemoryError("invalid_input", "Invalid execution offset.");
    if (Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"]) < 6) return { items: [], next_offset: null, coverage: "explicit_runner_only", claims_verified: false };
    const rows = this.db.prepare(`SELECT * FROM executions WHERE project_id=? AND run_id=? ${recordId ? "AND record_id=?" : ""}
      ORDER BY started_at DESC,id DESC LIMIT 21 OFFSET ?`).all(projectId, runId, ...(recordId ? [recordId] : []), offset);
    return { items: rows.slice(0, 20).map(row => executionProjection(executionRowSchema.parse(row))),
      next_offset: rows.length > 20 ? offset + 20 : null, coverage: "explicit_runner_only", claims_verified: false };
  }
}
