import { unreviewedRunSql } from "./run-reviews.js";
import { SqliteSkills } from "./skills.js";
import { SqliteDocuments } from "./documents.js";
import { markdownReceiptIdentity, type MarkdownSource } from "../../../core/documents/importer.js";
import { createMemoryContext } from "./context.js";
import { SqliteExecutions } from "./executions.js";
import { lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { activityFor, ViewerError } from "../../../core/viewer/model.js";
import type { RunState } from "../../../core/memory/model.js";
import { SqliteWorkReader } from "./work.js";
import { recordingCoverage, recordingDelivery } from "../../../core/memory/recording-health.js";
import { SqliteTaskEvents } from "./task-events.js";
import type { SourceProvider } from "../../../core/execution/currentness.js";

type Row = Record<string, SQLOutputValue>;
const PAGE_SIZE = 40;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function requireId(value: string): string {
  if (!UUID.test(value)) throw new ViewerError("invalid_input", "잘못된 식별자입니다.");
  return value;
}
function pageOffset(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new ViewerError("invalid_input", "목록 위치가 올바르지 않습니다.");
  }
  return value;
}
function text(row: Row, key: string): string {
  if (typeof row[key] !== "string") throw new ViewerError("unavailable", "기록 형식을 읽을 수 없습니다.");
  return row[key];
}
function number(row: Row, key: string): number {
  if (typeof row[key] !== "number") throw new ViewerError("unavailable", "기록 형식을 읽을 수 없습니다.");
  return row[key];
}
function readOnly(path: string): DatabaseSync {
  if (!isAbsolute(path)) throw new ViewerError("invalid_input", "DB의 절대 경로를 지정해 주세요.");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ViewerError("invalid_input", "기존의 일반 DB 파일만 열 수 있습니다.");
  const db = new DatabaseSync(path, { readOnly: true, enableDoubleQuotedStringLiterals: false });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 250; PRAGMA cache_size = -2048;");
    return db;
  } catch (error) { db.close(); throw error; }
}
function page<T>(rows: T[], offset: number) {
  return { items: rows.slice(0, PAGE_SIZE), next_offset: rows.length > PAGE_SIZE ? offset + PAGE_SIZE : null };
}

/** Dedicated read model: never opens a writer, migrates, registers or retries. */
export class SqliteViewer {
  private readonly db: DatabaseSync;
  private readonly work: SqliteWorkReader;
  constructor(private readonly path: string, private readonly now: () => number = Date.now, private readonly sources?: SourceProvider) {
    this.db = readOnly(path);
    try { this.version(); } catch (error) { this.db.close(); throw error; }
    this.work = new SqliteWorkReader(this.db, now);
  }
  close(): void { this.db.close(); }

  importedDocuments(projectId: string, options: {id?:string;version?:string;compare?:string;offset?:number;query?:string} = {}) {
    this.requireProject(projectId);
    if(this.version()<7) return {items:[],next_offset:null,unavailable:"가져온 문서 보관함은 DB v7에서 지원합니다. 기존 파일은 변경하지 않았습니다."};
    const reader=new SqliteDocuments(this.db);
    return options.id ? reader.detail(projectId,options.id,options) : reader.list(projectId,options.offset,options.query);
  }

  documentTargets(projectId: string) {
    this.requireProject(projectId);
    if (this.version() < 7) return { items: [], unavailable: "문서 가져오기는 DB v7 이상에서 지원합니다. 기존 파일은 변경하지 않았습니다." };
    const rows = this.db.prepare(`SELECT MAX(r.id) id, r.repository, r.environment, COALESCE(c.key,'') component_key, COALESCE(c.name,'서비스 공통') component_name
      FROM runs r LEFT JOIN run_components rc ON rc.project_id=r.project_id AND rc.run_id=r.id
      LEFT JOIN components c ON c.project_id=rc.project_id AND c.key=rc.component_key
      WHERE r.project_id=? GROUP BY r.repository,r.environment,c.key,c.name
      ORDER BY r.repository,r.environment,component_name LIMIT 101`).all(projectId);
    return { items: rows.slice(0, 100), truncated: rows.length > 100 };
  }

  documentTarget(projectId: string, runId: string | undefined, componentKey: string, scope?: { repository: string; environment: string }) {
    this.requireProject(projectId);
    if (this.version() < 7) throw new ViewerError("invalid_input", "문서 가져오기는 DB v7 이상에서 지원합니다. 먼저 설치 버전을 확인해 주세요.");
    if (scope) {
      if (runId || componentKey) throw new ViewerError("invalid_input", "새 작업 공간은 서비스 공통으로 저장합니다.");
      return { repository: scope.repository, environment: scope.environment, component: undefined };
    }
    if (!runId) throw new ViewerError("invalid_input", "저장할 작업 공간을 선택해 주세요.");
    const task = this.detail(projectId, runId).run;
    const component = componentKey ? task.components.find(item => item.key === componentKey) : undefined;
    if (componentKey && !component) throw new ViewerError("invalid_input", "선택한 작업 공간의 구성요소를 다시 확인해 주세요.");
    return { repository: task.repository, environment: task.environment, component };
  }

  documentStatus(projectId: string, scope: { repository: string; environment: string }, source: MarkdownSource, body: string, importKey: string) {
    const identity = markdownReceiptIdentity(scope, source, body, createMemoryContext().hash);
    const receipt = this.db.prepare("SELECT payload_hash,result_json FROM receipts WHERE scope=? AND idempotency_key=?").get(projectId, identity.key);
    if (!receipt) return { state: "new" as const };
    if (text(receipt, "payload_hash") !== identity.hash) throw new ViewerError("unavailable", "기존 문서의 저장 내용을 확인하지 못했습니다.");
    const result: unknown = JSON.parse(text(receipt, "result_json"));
    if (!result || typeof result !== "object" || !("record_ids" in result) || !Array.isArray(result.record_ids) || !result.record_ids.length
      || result.record_ids.some(id => typeof id !== "string" || !UUID.test(id))) throw new ViewerError("unavailable", "기존 문서 연결을 확인하지 못했습니다.");
    const ids = result.record_ids as string[];
    const records = ids.map(id => this.db.prepare("SELECT run_id,repository,environment,source_fingerprint FROM records WHERE project_id=? AND id=?").get(projectId, id));
    if (records.some(row => !row || row["repository"] !== scope.repository || row["environment"] !== scope.environment || row["source_fingerprint"] !== source.sha256))
      throw new ViewerError("unavailable", "기존 원문 기록을 확인하지 못했습니다.");
    const own = this.db.prepare("SELECT r.id,r.state FROM receipts p JOIN runs r ON r.project_id=p.scope AND r.id=json_extract(p.result_json,'$.run.id') WHERE p.scope=? AND p.idempotency_key=?").get(projectId, importKey);
    return { state: own?.["state"] === "active" ? "completion_pending" as const : "stored" as const,
      run_id: text(records[0]!, "run_id"), import_run_id: own ? text(own, "id") : text(records[0]!, "run_id"), record_ids: ids };
  }

  private version(): number {
    const version = this.db.prepare("PRAGMA user_version").get()?.["user_version"];
    if (this.db.prepare("PRAGMA application_id").get()?.["application_id"] !== 1397446988
      || typeof version !== "number" || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10].includes(version)) {
      throw new ViewerError("unavailable", "지원하는 Skilly DB(v1–v10)가 아닙니다. 파일을 변경하지 않았습니다.");
    }
    return version;
  }
  private requireProject(id: string): void {
    requireId(id);
    if (!this.db.prepare("SELECT 1 FROM projects WHERE id = ?").get(id)) {
      throw new ViewerError("not_found", "프로젝트를 찾을 수 없습니다.");
    }
  }
  private actorQuery(): { field: string; join: string } {
    return this.version() >= 3
      ? { field: "a.actor", join: "LEFT JOIN run_actors a ON a.run_id = r.id" }
      : { field: "NULL AS actor", join: "" };
  }
  private task(row: Row) {
    const state = text(row, "state");
    if (state !== "active" && state !== "completed" && state !== "interrupted") {
      throw new ViewerError("unavailable", "알 수 없는 작업 상태입니다.");
    }
    return {
      id: text(row, "id"), project_id: text(row, "project_id"), goal: text(row, "goal"),
      mode: text(row, "mode"), state, repository: text(row, "repository"), environment: text(row, "environment"),
      created_at: text(row, "created_at"), updated_at: text(row, "updated_at"),
      actor: typeof row["actor"] === "string" ? row["actor"] : null,
      actor_source: row["actor"] ? "self_reported" : "not_collected",
      activity: activityFor(state as RunState, text(row, "updated_at"), this.now()),
      ...this.work.identity(text(row, "project_id"), text(row, "id")),
    };
  }

  skills(projectId: string, options: { key?: string; version?: string; offset?: number; query?: string } = {}) {
    this.requireProject(projectId);
    const reader = new SqliteSkills(this.db);
    try {
      if (options.key) {
        if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(options.key) || (options.version?.length ?? 0) > 80) throw new ViewerError("invalid_input", "잘못된 스킬 조회 조건입니다.");
        return reader.detail(projectId, options.key, options.version, pageOffset(options.offset ?? 0));
      }
      if ((options.query?.length ?? 0) > 200) throw new ViewerError("invalid_input", "검색어가 너무 깁니다.");
      return reader.list(projectId, pageOffset(options.offset ?? 0), 12, options.query ?? "");
    } catch (error) {
      if (error instanceof ViewerError) throw error;
      if (error instanceof Error && "code" in error && error.code === "not_found") throw new ViewerError("not_found", "해당 스킬 버전이 없습니다.");
      throw error;
    }
  }

  projects(offset = 0) {
    pageOffset(offset);
    const rows = this.db.prepare(`SELECT p.*, count(r.id) AS total,
      coalesce(sum(r.state = 'completed' AND ${this.version() >= 9 ? unreviewedRunSql : "1"}),0) AS unreviewed_completed,
      coalesce(sum(r.state = 'active'), 0) AS unfinished,
      coalesce(sum(r.state = 'interrupted'), 0) AS interrupted,
      max(r.updated_at) AS last_activity FROM projects p LEFT JOIN runs r ON r.project_id = p.id
      GROUP BY p.id ORDER BY coalesce(max(r.updated_at), p.created_at) DESC, p.id LIMIT ? OFFSET ?`)
      .all(PAGE_SIZE + 1, offset);
    return page(rows.map(row => ({
      id: text(row, "id"), key: text(row, "project_key"), name: text(row, "name"),
      total: number(row, "total"), unfinished: number(row, "unfinished"), interrupted: number(row, "interrupted"),
      last_activity: row["last_activity"], unreviewed_completed: number(row, "unreviewed_completed"),
    })), offset);
  }

  runs(projectId: string, options: { offset?: number; query?: string; state?: string; component?: string; feature?: string; unreviewed?: boolean } = {}) {
    this.requireProject(projectId);
    const offset = pageOffset(options.offset ?? 0);
    const query = options.query ?? "";
    const state = options.state ?? "all";
    if (query.length > 200 || !["all", "active", "completed", "interrupted"].includes(state)) {
      throw new ViewerError("invalid_input", "검색어나 상태 필터를 확인해 주세요.");
    }
    if (options.unreviewed && state !== "completed") throw new ViewerError("invalid_input", "미확인 보관함은 완료 작업만 조회합니다.");
    this.requireFilters(options);
    const result = this.work.overview({ project_id: projectId, view: "tasks", offset, limit: PAGE_SIZE, query, state,
      ...(options.component ? { component: options.component } : {}), ...(options.feature ? { feature: options.feature } : {}) }, { unreviewed: options.unreviewed === true });
    if (Array.isArray(result["items"])) {
      const items = result["items"].map(item => {
        if (!item || typeof item !== "object" || Array.isArray(item) || typeof item["id"] !== "string") throw new ViewerError("unavailable", "작업 목록을 확인하지 못했습니다.");
        return item;
      });
      const ids = items.map(item => String(item["id"]));
      const observed = new SqliteTaskEvents(this.db, this.path).interruptions(projectId, ids);
      result["items"] = items.map((item,index) => ({ ...item,
        interruption_observed: observed ? observed.has(ids[index]!) : null }));
    }
    return result;
  }

  overview(projectId: string, view: string, offset = 0, options: {query?:string;component?:string;feature?:string;repository?:string;environment?:string} = {}) {
    this.requireProject(projectId); pageOffset(offset);
    if (view !== "components" && view !== "features") throw new ViewerError("invalid_input", "조회 종류를 확인해 주세요.");
    this.requireFilters(options);
    if ((options.query?.length ?? 0) > 200 || [options.repository,options.environment].some(value=>value!==undefined&&(!value.length||value.length>100||/[\u0000-\u001f]/.test(value)))) throw new ViewerError("invalid_input","검색 범위를 확인해 주세요.");
    return this.work.overview({ project_id: projectId, view, offset, limit: PAGE_SIZE, ...options });
  }

  private requireFilters(options: { component?: string; feature?: string }) {
    for (const value of [options.component, options.feature]) {
      if (value !== undefined && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(value)) throw new ViewerError("invalid_input", "구성요소나 기능을 확인해 주세요.");
    }
  }

  detail(projectId: string, runId: string, before = Number.MAX_SAFE_INTEGER) {
    this.requireProject(projectId);
    requireId(runId);
    if (!Number.isSafeInteger(before) || before < 1) throw new ViewerError("invalid_input", "기록 위치가 올바르지 않습니다.");
    const actor = this.actorQuery();
    const row = this.db.prepare(`SELECT r.*, ${actor.field} FROM runs r ${actor.join}
      WHERE r.project_id = ? AND r.id = ?`).get(projectId, runId);
    if (!row) throw new ViewerError("not_found", "이 프로젝트의 작업이 아닙니다.");
    const records = this.db.prepare(`SELECT seq, id, topic, kind, body, observed_at, recorded_at, superseded_by,
      ${this.version() >= 2 ? "report_origin" : "'unspecified' AS report_origin"}
      FROM records WHERE project_id = ? AND run_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`)
      .all(projectId, runId, before, PAGE_SIZE + 1)
      .map(record => ({ ...record, seq: number(record, "seq"), provenance: "agent_report", verified: false,
        report: this.work.report(projectId, text(record, "id")) ?? null }));
    const counts = this.db.prepare("SELECT kind, count(*) AS total FROM records WHERE project_id = ? AND run_id = ? GROUP BY kind")
      .all(projectId, runId);
    return {
      run: { ...this.task(row), task_recording: new SqliteTaskEvents(this.db, this.path).status(projectId, runId) }, records: {
        items: records.slice(0, PAGE_SIZE),
        next_before: records.length > PAGE_SIZE ? records[PAGE_SIZE - 1]?.seq : null,
      }, claims_verified: false,
      record_counts: Object.fromEntries(counts.map(count => [text(count, "kind"), number(count, "total")])),
      executions: new SqliteExecutions(this.db, this.sources).list(projectId, runId),
    };
  }

  executions(projectId: string, runId: string, offset = 0) {
    this.requireProject(projectId); requireId(runId); pageOffset(offset);
    if (!this.db.prepare("SELECT 1 FROM runs WHERE project_id=? AND id=?").get(projectId, runId)) throw new ViewerError("not_found", "이 프로젝트의 작업이 아닙니다.");
    return new SqliteExecutions(this.db, this.sources).list(projectId, runId, offset);
  }

  recovery(projectId: string, offset = 0) {
    this.requireProject(projectId);
    pageOffset(offset);
    let journal: DatabaseSync | undefined;
    try {
      journal = readOnly(`${this.path}.recovery.sqlite`);
      if (journal.prepare("PRAGMA application_id").get()?.["application_id"] !== 1397446994
        || journal.prepare("PRAGMA user_version").get()?.["user_version"] !== 1) {
        throw new ViewerError("unavailable", "지원하지 않는 복구 보관함입니다.");
      }
      const rows = journal.prepare(`SELECT id, tool, repository, environment, request_key, payload_hash,
        received_at, last_error, input_json IS NOT NULL AS retained,
        json_extract(input_json, '$.run_id') AS run_id, substr(json_extract(input_json, '$.goal'), 1, 200) AS goal
        FROM requests WHERE project_id = ? AND (input_json IS NOT NULL OR last_error IS NOT NULL)
        ORDER BY received_at DESC, id DESC LIMIT ? OFFSET ?`).all(projectId, PAGE_SIZE + 1, offset);
      const items = rows.map(row => {
        const receipt = this.db.prepare("SELECT payload_hash FROM receipts WHERE scope = ? AND idempotency_key = ?")
          .get(projectId, text(row, "request_key"));
        const saved = receipt?.["payload_hash"] === row["payload_hash"];
        const error = row["last_error"];
        const retained = row["retained"] === 1;
        const state = saved ? "saved" : receipt ? "conflict" : !retained ? "rejected"
          : !error ? "unconfirmed" : ["busy", "storage_error", "conflict"].includes(String(error)) ? "retry_required" : "blocked";
        return {
          request_id: text(row, "id"), tool: text(row, "tool"), run_id: row["run_id"], goal: row["goal"],
          repository: text(row, "repository"), environment: text(row, "environment"),
          received_at: text(row, "received_at"), last_error: error, state, original_input_retained: retained,
          delivery_status: recordingDelivery(saved, retained, state),
        };
      });
      return { status: "available", recording_coverage: recordingCoverage(), ...page(items, offset) };
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      return { status: missing ? "missing" : "unavailable", recording_coverage: recordingCoverage(), items: [], next_offset: null };
    } finally { journal?.close(); }
  }
}
