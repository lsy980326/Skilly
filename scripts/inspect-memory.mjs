import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { loadProjectBinding } from "../dist/adapters/project/binding.js";

// A human-facing inspection path. Never initialize, register, migrate or write.
// Do not use openLocal: opening the application's writer can initialize a DB.
export function inspectMemory({ project, db: path, limit = 5, run, attention = false }) {
  if (!isAbsolute(project) || !isAbsolute(path)) throw new Error("--project and --db must be absolute paths.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("--limit must be between 1 and 20.");
  if (run !== undefined && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(run)) {
    throw new Error("--run must be a UUID.");
  }
  const binding = loadProjectBinding(project);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("--db must be an existing regular file, not a symlink.");
  const db = new DatabaseSync(path, { readOnly: true, enableDoubleQuotedStringLiterals: false });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1000; BEGIN;");
    const version = db.prepare("PRAGMA user_version").get().user_version;
    const application = db.prepare("PRAGMA application_id").get().application_id;
    if (application !== 1397446988 || ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].includes(version)) throw new Error("Expected an existing Skilly schema version 1–14 database.");
    const identity = db.prepare("SELECT id, name FROM projects WHERE project_key = ?").get(binding.key);
    if (identity && identity.name !== binding.name) throw new Error("Project key/name mismatch.");
    const scope = { key: binding.key, repository: binding.repository, environment: binding.environment };
    if (!identity) return { status: "project_not_registered", scope, runs: [], claims_verified: false };
    const params = [identity.id, binding.repository, binding.environment];
    if (run) params.push(run);
    params.push(limit);
    const runs = db.prepare(`SELECT id, goal, mode, state, created_at, updated_at FROM runs
      WHERE project_id = ? AND repository = ? AND environment = ? ${run ? "AND id = ?" : ""}
      ${attention && !run ? "AND state IN ('active', 'interrupted')" : ""}
      ORDER BY updated_at DESC, id DESC LIMIT ?`).all(...params);
    if (run && runs.length === 0) throw new Error("Run not found in this project/repository/environment.");
    const counts = db.prepare(`SELECT kind, count(*) AS count FROM records
      WHERE project_id = ? AND run_id = ? GROUP BY kind`);
    const recent = db.prepare(`SELECT id, topic, kind, recorded_at, superseded_by,
      ${version >= 2 ? "report_origin" : "'unspecified' AS report_origin"},
      substr(body, 1, 240) AS excerpt, length(body) > 240 AS excerpt_truncated
      FROM records WHERE project_id = ? AND run_id = ? ORDER BY seq DESC LIMIT 5`);
    return {
      status: "ok", project_id: identity.id, scope, claims_verified: false,
      recovery_requests: inspectRecovery(path, identity.id, binding, db, limit, run),
      runs: runs.map(task => ({
        ...task,
        record_counts: Object.fromEntries(counts.all(identity.id, task.id).map(row => [row.kind, row.count])),
        recent_records: recent.all(identity.id, task.id).map(row => ({
          ...row, excerpt_truncated: Boolean(row.excerpt_truncated), provenance: "agent_report", verified: false,
        })),
      })),
      limitation: "Record presence and run state only; neither Codex connectivity nor content accuracy is verified. An active run may still be working.",
    };
  } finally {
    // Closing a read transaction releases its snapshot without mutating data.
    db.close();
  }
}

function inspectRecovery(path, projectId, scope, recordsDb, limit, run) {
  const journalPath = `${path}.recovery.sqlite`;
  if (!existsSync(journalPath)) return [];
  const stat = lstatSync(journalPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Recovery journal must be an existing regular file.");
  const journal = new DatabaseSync(journalPath, { readOnly: true });
  try {
    journal.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 1000;");
    if (journal.prepare("PRAGMA application_id").get().application_id !== 1397446994
      || journal.prepare("PRAGMA user_version").get().user_version !== 1) throw new Error("Unsupported recovery journal.");
    const rows = journal.prepare(`SELECT id, tool, request_key, payload_hash, received_at, last_error FROM requests
      WHERE project_id = ? AND repository = ? AND environment = ? AND input_json IS NOT NULL
      ${run ? "AND json_extract(input_json, '$.run_id') = ?" : ""}
      ORDER BY received_at, id LIMIT ?`).all(projectId, scope.repository, scope.environment, ...(run ? [run] : []), limit);
    return rows.map(row => {
      const receipt = recordsDb.prepare("SELECT payload_hash FROM receipts WHERE scope = ? AND idempotency_key = ?").get(projectId, row.request_key);
      return {
        request_id: row.id, tool: row.tool, first_received_at: row.received_at, last_error: row.last_error,
        persistence: receipt?.payload_hash === row.payload_hash ? "persisted" : receipt ? "conflict" : "not_found",
        original_input_retained: true,
      };
    });
  } finally { journal.close(); }
}

// Stored reports and binding labels are untrusted terminal text. Fold whitespace
// and show control bytes literally so records cannot emit terminal commands.
function display(value) {
  return String(value).replace(/\s+/gu, " ").replace(/[\u0000-\u001f\u007f-\u009f]/gu,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function formatInspection(report) {
  const lines = [
    `프로젝트: ${display(report.scope.key)} / ${display(report.scope.repository)} / ${display(report.scope.environment)}`,
    "읽기 전용 확인 — 저장된 설명의 정확성·Codex 연결 상태는 검증하지 않습니다.",
  ];
  if (report.status === "project_not_registered") lines.push("이 DB에 아직 프로젝트가 등록되지 않았습니다.");
  else if (report.runs.length === 0) lines.push("이 범위에 저장된 작업이 없습니다.");
  for (const run of report.runs) {
    lines.push("", `작업 ${display(run.id)} [${display(run.state)}] ${display(run.mode)}`,
      `목표: ${display(run.goal)}`, `최근 변경: ${display(run.updated_at)}`,
      `기록 수: ${display(JSON.stringify(run.record_counts))} (summary는 종료 요약 또는 별도 요약 기록)`);
    for (const record of run.recent_records) {
      const origin = { contemporaneous: "당시 작성 보고", retrospective: "소급 작성 보고", unspecified: "작성 시점 미지정" }[record.report_origin] ?? "작성 시점 미지정";
      lines.push(`  ${display(record.kind)} ${display(record.id)} / ${display(record.topic)} [${origin}]${record.superseded_by ? " [정정됨]" : ""}`,
        `  ${display(record.excerpt)}${record.excerpt_truncated ? "…" : ""}`);
    }
  }
  for (const request of report.recovery_requests ?? []) {
    lines.push("", `복구 요청 ${display(request.request_id)} / ${display(request.tool)}`,
      `저장: ${display(request.persistence)} / 원래 요청 보관됨 / 오류: ${display(request.last_error ?? "결과 미확정")}`);
  }
  lines.push("", "completed는 작업 마감 상태입니다. active는 진행 중이거나 종료 기록이 없다는 뜻이며 실패를 단정하지 않습니다.");
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      project: { type: "string" }, db: { type: "string" }, run: { type: "string" },
      limit: { type: "string", default: "5" }, json: { type: "boolean" },
      attention: { type: "boolean" },
    } });
    if (!values.project || !values.db) throw new Error("Usage: npm run memory:inspect -- --project /absolute/project --db /absolute/memory.sqlite [--run UUID] [--attention] [--limit 1..20] [--json]. Run npm run build first.");
    const result = inspectMemory({ ...values, limit: Number(values.limit) });
    process.stdout.write((values.json ? JSON.stringify(result, null, 2) : formatInspection(result)) + "\n");
  } catch (error) {
    process.stderr.write(`Skilly inspection failed: ${display(error instanceof Error ? error.message : "Unknown error")}\n`);
    process.exitCode = 1;
  }
}
