import { testDetailsRowSchema, type TestDetails } from "../../../core/execution/test-details.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { MemoryError } from "../../../core/memory/model.js";
import { executionRowSchema, executionProjection, type ExecutionRow } from "../../../core/execution/model.js";
import { executionSourceRowSchema, executionWorktreeRowSchema, sourceObservationSchema, sourceProjection, compareExecutionSource, type SourceObservation, type SourceProvider } from "../../../core/execution/currentness.js";
import { readExecutionSources } from "./execution-sources.js";
import { assertWritable } from "./project-authority.js";

export function validateExecutionData(db: DatabaseSync): void {
  for (const row of db.prepare("SELECT * FROM executions").iterate()) {
    if (!executionRowSchema.safeParse(row).success) throw new MemoryError("invalid_data", "Invalid process observation.");
  }
  if (Number(db.prepare("PRAGMA user_version").get()?.["user_version"]) >= 8) {
    for (const row of db.prepare("SELECT * FROM execution_sources").iterate()) {
      const parsed = executionSourceRowSchema.parse(row);
      const before = sourceObservationSchema.parse(JSON.parse(parsed.before_json));
      const scope = db.prepare(`SELECT p.project_key,r.repository,r.environment FROM executions e JOIN runs r ON r.id=e.run_id AND r.project_id=e.project_id
        JOIN projects p ON p.id=e.project_id WHERE e.id=? AND e.project_id=?`).get(parsed.execution_id, parsed.project_id);
      if (!scope || scope["project_key"] !== before.project_key || scope["repository"] !== before.repository || scope["environment"] !== before.environment)
        throw new MemoryError("scope_mismatch", "Execution source scope mismatch.");
      if (parsed.after_json) {
        const after = sourceObservationSchema.parse(JSON.parse(parsed.after_json));
        if (after.root_hash !== before.root_hash || after.project_key !== before.project_key || after.repository !== before.repository || after.environment !== before.environment)
          throw new MemoryError("scope_mismatch", "Execution source observations differ in scope.");
      }
    }
  }
  if (Number(db.prepare("PRAGMA user_version").get()?.["user_version"]) >= 7) {
    for (const row of db.prepare("SELECT * FROM execution_test_details").iterate()) {
      if (!testDetailsRowSchema.safeParse(row).success) throw new MemoryError("invalid_data", "Invalid test observation.");
    }
    if (db.prepare(`SELECT 1 FROM execution_test_details d JOIN executions e ON d.execution_id=e.id WHERE d.project_id != e.project_id LIMIT 1`).get())
      throw new MemoryError("scope_mismatch", "Test details belong to another project.");
  }
  if (Number(db.prepare("PRAGMA user_version").get()?.["user_version"]) >= 12) {
    for (const row of db.prepare("SELECT * FROM execution_worktrees").iterate()) executionWorktreeRowSchema.parse(row);
    if (db.prepare(`SELECT 1 FROM execution_worktrees w JOIN execution_sources s ON s.execution_id=w.execution_id
      WHERE w.project_id!=s.project_id OR (w.after_json IS NOT NULL AND s.after_json IS NULL) LIMIT 1`).get())
      throw new MemoryError("scope_mismatch", "Fingerprint source scope mismatch.");
  }
  if (db.prepare(`SELECT 1 FROM executions e JOIN records r ON r.project_id=e.project_id AND r.id=e.record_id
    WHERE e.run_id != r.run_id LIMIT 1`).get()) throw new MemoryError("scope_mismatch", "Execution record belongs to another task.");
}

export class SqliteExecutions {
  constructor(private readonly db: DatabaseSync, private readonly sources?: SourceProvider) {}
  start(input: { project_id: string; run_id: string; record_id?: string; executable: string; command_hash: string; source_observation?: SourceObservation }): string {
    // Validate before any process runs. Keep association checks and insertion atomic.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      assertWritable(this.db,input.project_id);
      const run = this.db.prepare("SELECT r.state,r.repository,r.environment,p.project_key FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.project_id=? AND r.id=?").get(input.project_id, input.run_id);
      if (!run || run["state"] !== "active") throw new MemoryError("run_closed", "Execution requires an active task in this project.");
      if (input.source_observation) {
        const source = sourceObservationSchema.parse(input.source_observation);
        if (source.project_key !== run["project_key"] || source.repository !== run["repository"] || source.environment !== run["environment"])
          throw new MemoryError("scope_mismatch", "Execution source belongs to another scope.");
      }
      if (input.record_id && !this.db.prepare("SELECT 1 FROM records WHERE project_id=? AND run_id=? AND id=?").get(input.project_id, input.run_id, input.record_id)) {
        throw new MemoryError("scope_mismatch", "Record belongs to another task.");
      }
      const id = randomUUID();
      this.db.prepare(`INSERT INTO executions (id,project_id,run_id,record_id,source,executable,command_hash,started_at,outcome)
        VALUES (?,?,?,?,'local_runner',?,?,?,'unconfirmed')`).run(id, input.project_id, input.run_id, input.record_id ?? null, input.executable, input.command_hash, new Date().toISOString());
      if (input.source_observation) {
        const { worktree, ...metadata } = sourceObservationSchema.parse(input.source_observation);
        this.db.prepare("INSERT INTO execution_sources VALUES(?,?,?,NULL)").run(id, input.project_id, JSON.stringify(metadata));
        if (worktree) this.db.prepare("INSERT INTO execution_worktrees VALUES(?,?,?,NULL)").run(id, input.project_id, JSON.stringify(worktree));
      }
      this.db.exec("COMMIT");
      return id;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  finish(id: string, result: Pick<ExecutionRow, "outcome" | "exit_code" | "signal" | "error_code" | "duration_ms" | "stdout_bytes" | "stderr_bytes" | "stdout_hash" | "stderr_hash" | "stdout_hashed_bytes" | "stderr_hashed_bytes" | "output_complete">, details?: TestDetails, sourceAfter?: SourceObservation): void {
    const row = this.db.prepare("SELECT * FROM executions WHERE id=?").get(id);
    if (!row || row["ended_at"] !== null) throw new MemoryError("conflict", "Execution is absent or already finalized; never rerun a command to retry its storage.");
    const complete = executionRowSchema.parse({ ...row, ...result, ended_at: new Date().toISOString() });
    if (sourceAfter) {
      const after = sourceObservationSchema.parse(sourceAfter);
      const saved = this.db.prepare("SELECT before_json FROM execution_sources WHERE execution_id=?").get(id);
      const before = saved ? sourceObservationSchema.parse(JSON.parse(String(saved["before_json"]))) : undefined;
      if (!before || before.root_hash !== after.root_hash || before.project_key !== after.project_key || before.repository !== after.repository || before.environment !== after.environment)
        throw new MemoryError("scope_mismatch", "Execution source observations differ in scope.");
    }
    const names = ["ended_at", ...Object.keys(result)] as (keyof typeof complete)[];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const saved = this.db.prepare(`UPDATE executions SET ${names.map(name => `${name}=?`).join(",")} WHERE id=? AND ended_at IS NULL`)
        .run(...names.map(name => complete[name]), id);
      if (saved.changes !== 1) throw new MemoryError("conflict", "Execution finalization is unconfirmed.");
      if (details) {
        const detailRow = testDetailsRowSchema.parse({ execution_id: id, project_id: row["project_id"], details_json: JSON.stringify(details) });
        this.db.prepare("INSERT INTO execution_test_details (execution_id,project_id,details_json) VALUES (?,?,?)").run(id, detailRow.project_id, detailRow.details_json);
      }
      if (sourceAfter) {
        const { worktree, ...metadata } = sourceObservationSchema.parse(sourceAfter);
        this.db.prepare("UPDATE execution_sources SET after_json=? WHERE execution_id=?").run(JSON.stringify(metadata), id);
        if (worktree) this.db.prepare(`INSERT INTO execution_worktrees VALUES(?,?,NULL,?)
          ON CONFLICT(execution_id) DO UPDATE SET after_json=excluded.after_json`).run(id, row["project_id"]!, JSON.stringify(worktree));
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private details(id: string, unfinished: boolean): TestDetails {
    const version = Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"]);
    const row = version >= 7 ? this.db.prepare("SELECT * FROM execution_test_details WHERE execution_id=?").get(id) : undefined;
    return row ? JSON.parse(testDetailsRowSchema.parse(row).details_json) as TestDetails
      : { status: "not_collected", reason: unfinished ? "unfinished" : "legacy" };
  }
  list(projectId: string, runId: string, offset = 0, recordId?: string) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) throw new MemoryError("invalid_input", "Invalid execution offset.");
    if (Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"]) < 6) return { items: [], next_offset: null, coverage: "explicit_runner_only", claims_verified: false };
    const rows = this.db.prepare(`SELECT * FROM executions WHERE project_id=? AND run_id=? ${recordId ? "AND record_id=?" : ""}
      ORDER BY started_at DESC,id DESC LIMIT 21 OFFSET ?`).all(projectId, runId, ...(recordId ? [recordId] : []), offset);
    const current = new Map<string, SourceObservation | undefined>();
    return { items: rows.slice(0, 20).map(row => {
      const {before,after} = Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"]) >= 8
        ? readExecutionSources(this.db, projectId, String(row["id"])) : {};
      if (before && !current.has(before.root_hash)) current.set(before.root_hash, this.sources?.(before));
      const now = before ? current.get(before.root_hash) : undefined;
      return { ...executionProjection(executionRowSchema.parse(row)), test_details: this.details(String(row["id"]), row["outcome"] === "unconfirmed"),
        code_version: { before: sourceProjection(before), after: sourceProjection(after), current: sourceProjection(now), comparison: compareExecutionSource(before, after, now) } };
    }),
      next_offset: rows.length > 20 ? offset + 20 : null, coverage: "explicit_runner_only", claims_verified: false };
  }
}
