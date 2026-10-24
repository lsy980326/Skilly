import { SqliteTaskSkills } from "./task-skills.js";
import { SqlitePlans } from "./plans.js";
import { SqliteDecisions } from "./decisions.js";
import { SqliteRunReviews } from "./run-reviews.js";
import { SqliteSkills } from "./skills.js";
import { SqliteExecutions } from "./executions.js";
import { SqliteTaskEvents } from "./task-events.js";
import type { SourceProvider } from "../../../core/execution/currentness.js";
import { DatabaseSync, type SQLOutputValue, type SQLInputValue } from "node:sqlite";
import { readFileSync } from "node:fs";
import {
  MemoryError, parseJsonObject, type MemoryRecord, type Mutation, type Project,
  type Receipt, type RecordQuery, type Run,
} from "../../../core/memory/model.js";
import type { MemoryStore } from "../../../core/memory/ports.js";
import { SqliteWorkReader, writeWork } from "./work.js";

import type { InstallationComponent } from "../../../core/viewer/components.js";
import { componentWhere } from "./component-links.js";
import { readAuthority, assertWritable } from "./project-authority.js";

type Row = Record<string, SQLOutputValue>;

export class SqliteMemoryStore implements MemoryStore {
  private readonly db: DatabaseSync;
  readonly work: SqliteWorkReader;
  readonly reviews: SqliteRunReviews;
  readonly skills: SqliteSkills;
  readonly executions: SqliteExecutions;
  readonly plans: SqlitePlans;
  readonly decisions: SqliteDecisions;
  readonly taskSkills: SqliteTaskSkills;

  constructor(private readonly path: string, sources?: SourceProvider, bindings: InstallationComponent[] = []) {
    this.db = new DatabaseSync(path, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false });
    try {
      this.db.exec("PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL; PRAGMA cache_size = -8192;");
      this.migrate();
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.work = new SqliteWorkReader(this.db, Date.now, sources);
      this.reviews = new SqliteRunReviews(this.db);
      this.skills = new SqliteSkills(this.db, bindings);
      this.executions = new SqliteExecutions(this.db, sources);
      this.plans = new SqlitePlans(this.db, sources);
      this.decisions = new SqliteDecisions(this.db);
      this.taskSkills = new SqliteTaskSkills(this.db);
    } catch (error) {
      this.db.close();
      throw storageError(error);
    }
  }

  close(): void { this.db.close(); }
  authority(projectId:string) { return readAuthority(this.db,projectId); }
  assertWritable(projectId:string) { assertWritable(this.db,projectId); }
  taskEvents(root?: string) { return new SqliteTaskEvents(this.db, this.path, root); }

  private migrate(): void {
    const version = number(this.db.prepare("PRAGMA user_version").get(), "user_version");
    const application = number(this.db.prepare("PRAGMA application_id").get(), "application_id");
    if ((version !== 0 && application !== 1397446988) || (version === 0 && application !== 0)) {
      throw new MemoryError("foreign_database", "This file is not a Skilly database.");
    }
    if (version > 15) throw new MemoryError("schema_too_new", "This DB requires a newer Skilly version.");
    if (version === 15) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const lockedVersion = number(this.db.prepare("PRAGMA user_version").get(), "user_version");
      if (lockedVersion === 0) {
        const tables = number(this.db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get(), "count");
        if (tables !== 0) throw new MemoryError("foreign_database", "Refusing to initialize a nonempty database.");
        const migration = readFileSync(new URL("../../../../migrations/001-local-memory.sql", import.meta.url), "utf8");
        this.db.exec(migration);
      }
      if (lockedVersion < 2) {
        this.db.exec(readFileSync(new URL("../../../../migrations/002-recovery.sql", import.meta.url), "utf8"));
      }
      if (lockedVersion < 3) {
        this.db.exec(readFileSync(new URL("../../../../migrations/003-run-actors.sql", import.meta.url), "utf8"));
      }
      if (lockedVersion < 4) {
        this.db.exec(readFileSync(new URL("../../../../migrations/004-work-structure.sql", import.meta.url), "utf8"));
      }
      if (lockedVersion < 5) {
        this.db.exec(readFileSync(new URL("../../../../migrations/005-skill-library.sql", import.meta.url), "utf8"));
      }
      if (lockedVersion < 6) this.db.exec(readFileSync(new URL("../../../../migrations/006-executions.sql", import.meta.url), "utf8"));
      if (lockedVersion < 7) this.db.exec(readFileSync(new URL("../../../../migrations/007-test-details.sql", import.meta.url), "utf8"));
      if (lockedVersion < 8) this.db.exec(readFileSync(new URL("../../../../migrations/008-execution-source.sql", import.meta.url), "utf8"));
      if (lockedVersion < 9) this.db.exec(readFileSync(new URL("../../../../migrations/009-run-acknowledgements.sql", import.meta.url), "utf8"));
      if (lockedVersion < 10) this.db.exec(readFileSync(new URL("../../../../migrations/010-feature-discovery.sql", import.meta.url), "utf8"));
      if (lockedVersion < 11) this.db.exec(readFileSync(new URL("../../../../migrations/011-plans.sql", import.meta.url), "utf8"));
      if (lockedVersion < 12) this.db.exec(readFileSync(new URL("../../../../migrations/012-execution-worktrees.sql", import.meta.url), "utf8"));
      if (lockedVersion < 13) this.db.exec(readFileSync(new URL("../../../../migrations/013-decisions.sql", import.meta.url), "utf8"));
      if (lockedVersion < 14) this.db.exec(readFileSync(new URL("../../../../migrations/014-decision-guards.sql", import.meta.url), "utf8"));
      if (lockedVersion < 15) this.db.exec(readFileSync(new URL("../../../../migrations/015-task-skill-usage.sql", import.meta.url), "utf8"));
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async getProject(id: string): Promise<Project | undefined> {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? projectFrom(row) : undefined;
  }

  async findProject(key: string): Promise<Project | undefined> {
    const row = this.db.prepare("SELECT * FROM projects WHERE project_key = ?").get(key);
    return row ? projectFrom(row) : undefined;
  }

  async listProjects(after: string, limit: number): Promise<Project[]> {
    return this.db.prepare("SELECT * FROM projects WHERE project_key > ? ORDER BY project_key LIMIT ?").all(after, limit).map(projectFrom);
  }

  async getRun(projectId: string, runId: string): Promise<Run | undefined> {
    const row = this.db.prepare(`SELECT r.*, a.actor FROM runs r LEFT JOIN run_actors a ON a.run_id = r.id
      WHERE r.project_id = ? AND r.id = ?`).get(projectId, runId);
    return row ? runFrom(row) : undefined;
  }

  async unfinishedRuns(projectId: string, repository: string, environment: string, limit: number, offset: number, component?: string): Promise<Run[]> {
    const selected = componentWhere(component, "SELECT 1 FROM run_components rc WHERE rc.project_id=r.project_id AND rc.run_id=r.id", "rc.component_key");
    return this.db.prepare(`SELECT r.*, a.actor FROM runs r LEFT JOIN run_actors a ON a.run_id = r.id
      WHERE r.project_id = ? AND r.repository = ? AND r.environment = ? AND r.state IN ('active', 'interrupted') AND ${selected.sql}
      ORDER BY r.updated_at ASC, r.id ASC LIMIT ? OFFSET ?`)
      .all(projectId, repository, environment, ...selected.params, limit, offset).map(runFrom);
  }

  async getRecord(projectId: string, recordId: string): Promise<MemoryRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM records WHERE project_id = ? AND id = ?").get(projectId, recordId);
    return row ? recordFrom(row) : undefined;
  }

  async getReceipt(scope: string, key: string): Promise<Receipt | undefined> {
    const row = this.db.prepare("SELECT * FROM receipts WHERE scope = ? AND idempotency_key = ?").get(scope, key);
    return row ? {
      scope: string(row, "scope"), key: string(row, "idempotency_key"),
      hash: string(row, "payload_hash"), result: parseJsonObject(string(row, "result_json")),
    } : undefined;
  }

  async maxSequence(projectId: string): Promise<number> {
    return number(this.db.prepare("SELECT coalesce(max(seq), 0) AS seq FROM records WHERE project_id = ?").get(projectId), "seq");
  }

  async query(input: RecordQuery): Promise<MemoryRecord[]> {
    const conditions = ["r.project_id = ?", "r.environment = ?", "r.repository = ?", "r.seq < ?", "r.seq <= ?"];
    const params: SQLInputValue[] = [input.project_id, input.environment, input.repository, input.after_seq, input.snapshot_seq];
    if (!input.history) {
      conditions.push("r.superseded_by IS NULL");
      if (input.source_fingerprint) {
        conditions.push("(r.source_fingerprint IS NULL OR r.source_fingerprint = ?)");
        params.push(input.source_fingerprint);
      }
    }
    if (input.topic) { conditions.push("r.topic = ?"); params.push(input.topic); }
    const terms = input.query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 12) ?? [];
    if (input.query && terms.length === 0) return [];
    if (terms.length) {
      // Quotes/operators are never accepted as FTS syntax. Short Korean terms
      // also use a substring path inside the already-fixed project scope.
      const fts = terms.map(term => `"${term}"*`).join(" AND ");
      const substring = terms.map(() => "(instr(lower(r.body), lower(?)) > 0 OR instr(lower(r.topic), lower(?)) > 0)").join(" AND ");
      conditions.push(`(r.seq IN (SELECT rowid FROM record_search WHERE record_search MATCH ?) OR (${substring}))`);
      params.push(fts, ...terms.flatMap(term => [term, term]));
    }
    params.push(input.limit);
    return this.db.prepare(`SELECT r.* FROM records r WHERE ${conditions.join(" AND ")} ORDER BY r.seq DESC LIMIT ?`)
      .all(...params).map(recordFrom);
  }

  async commit(change: Mutation): Promise<"committed" | "conflict"> {
    try { this.db.exec("BEGIN IMMEDIATE"); } catch (error) { throw storageError(error); }
    try {
      assertWritable(this.db,change.project.id);
      const receipt = change.receipt;
      if (this.db.prepare("SELECT 1 FROM receipts WHERE scope = ? AND idempotency_key = ?").get(receipt.scope, receipt.key)) {
        this.db.exec("ROLLBACK");
        return "conflict";
      }
      const project = change.project;
      if (change.expected_revision === null) {
        if (this.db.prepare("SELECT 1 FROM projects WHERE project_key = ? OR id = ?").get(project.key, project.id)) {
          this.db.exec("ROLLBACK");
          return "conflict";
        }
        this.db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?, ?)").run(project.id, project.key, project.name, project.revision, project.created_at);
      } else {
        const updated = this.db.prepare("UPDATE projects SET revision = ? WHERE id = ? AND revision = ?")
          .run(project.revision, project.id, change.expected_revision);
        if (updated.changes !== 1) {
          this.db.exec("ROLLBACK");
          return "conflict";
        }
      }
      if (change.run) {
        const run = change.run;
        this.db.prepare(`INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`)
          .run(run.id, run.project_id, run.goal, run.mode, run.environment, run.repository, run.state, run.created_at, run.updated_at);
        if (run.actor) {
          this.db.prepare("INSERT INTO run_actors VALUES (?, ?) ON CONFLICT(run_id) DO NOTHING").run(run.id, run.actor);
        }
      }
      for (const r of [...(change.record ? [change.record] : []), ...(change.records ?? [])]) {
        this.db.prepare(`INSERT INTO records
          (id, project_id, run_id, topic, kind, body, environment, repository, source_fingerprint, observed_at, recorded_at, supersedes, superseded_by, report_origin)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(r.id, r.project_id, r.run_id, r.topic, r.kind, r.body, r.environment, r.repository, r.source_fingerprint,
            r.observed_at, r.recorded_at, r.supersedes, r.superseded_by, r.report_origin);
        if (r.supersedes) {
          const updated = this.db.prepare("UPDATE records SET superseded_by = ? WHERE project_id = ? AND id = ? AND superseded_by IS NULL")
            .run(r.id, r.project_id, r.supersedes);
          if (updated.changes !== 1) {
            this.db.exec("ROLLBACK");
            return "conflict";
          }
        }
      }
      if (change.work) writeWork(this.db, project.id, change.work);
      if (change.decision && change.record) {
        const d=change.decision;
        this.db.prepare("INSERT INTO decision_events VALUES(?,?,?,?,?,?)").run(project.id,change.record.id,d.subject,d.component_key??"",d.feature_key??"",JSON.stringify(d));
      }
      if (change.skill_usage) this.taskSkills.write(change.skill_usage);
      for (const report of change.reports ?? []) writeWork(this.db, project.id, report);
      this.db.prepare("INSERT INTO receipts VALUES (?, ?, ?, ?)").run(receipt.scope, receipt.key, receipt.hash, JSON.stringify(receipt.result));
      this.db.exec("COMMIT");
      return "committed";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw storageError(error);
    }
  }
}

function string(row: Row | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string") throw new MemoryError("invalid_data", `Invalid stored field: ${key}.`);
  return value;
}
function number(row: Row | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new MemoryError("invalid_data", `Invalid stored field: ${key}.`);
  return value;
}
function nullable(row: Row, key: string): string | null {
  return row[key] === null ? null : string(row, key);
}
function projectFrom(row: Row): Project {
  return { id: string(row, "id"), key: string(row, "project_key"), name: string(row, "name"), revision: number(row, "revision"), created_at: string(row, "created_at") };
}
function runFrom(row: Row): Run {
  const mode = string(row, "mode");
  const state = string(row, "state");
  if (mode !== "answer" && mode !== "diagnose" && mode !== "review" && mode !== "change") throw new MemoryError("invalid_data", "Invalid run mode.");
  if (state !== "active" && state !== "completed" && state !== "interrupted") throw new MemoryError("invalid_data", "Invalid run state.");
  return {
    id: string(row, "id"), project_id: string(row, "project_id"), goal: string(row, "goal"), mode, state,
    environment: string(row, "environment"), repository: string(row, "repository"),
    created_at: string(row, "created_at"), updated_at: string(row, "updated_at"),
    ...(typeof row["actor"] === "string" ? { actor: row["actor"] } : {}),
  };
}
function recordFrom(row: Row): MemoryRecord {
  const kind = string(row, "kind");
  const origin = string(row, "report_origin");
  if (origin !== "unspecified" && origin !== "contemporaneous" && origin !== "retrospective") {
    throw new MemoryError("invalid_data", "Invalid report origin.");
  }
  if (kind !== "note" && kind !== "decision" && kind !== "change" && kind !== "issue" && kind !== "summary") {
    throw new MemoryError("invalid_data", "Invalid record kind.");
  }
  return {
    id: string(row, "id"), seq: number(row, "seq"), project_id: string(row, "project_id"),
    run_id: string(row, "run_id"), topic: string(row, "topic"), kind, body: string(row, "body"),
    environment: string(row, "environment"), repository: string(row, "repository"),
    source_fingerprint: nullable(row, "source_fingerprint"), observed_at: string(row, "observed_at"),
    recorded_at: string(row, "recorded_at"), supersedes: nullable(row, "supersedes"), superseded_by: nullable(row, "superseded_by"),
    report_origin: origin,
  };
}
function storageError(error: unknown): Error {
  if (error instanceof MemoryError) return error;
  if(error instanceof Error && error.message.includes("project_write_blocked")) return new MemoryError("project_write_blocked","This project copy is fenced; no forwarding or automatic retry.");
  if (error instanceof Error && "errcode" in error && (error.errcode === 5 || error.errcode === 6)) {
    return new MemoryError("busy", "Database is busy. Retry with the same idempotency key.", true);
  }
  return new MemoryError("storage_error", "The database operation failed. No successful persistence is claimed.");
}
