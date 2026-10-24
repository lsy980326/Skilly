import type { DatabaseSync } from "node:sqlite";
import { MemoryError, parseJsonObject, type JsonObject, type Run } from "../../../core/memory/model.js";
import { skillUsagesSchema, taskSkillUsageRowSchema, type SkillUsage, type SkillUsageReader, type TaskSkillUsageRow } from "../../../core/skills/usage.js";
import { SqliteSkills } from "./skills.js";

const PAGE = 8;
export class SqliteTaskSkills implements SkillUsageReader {
  constructor(private readonly db: DatabaseSync) {}
  private supported() { return Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"]) >= 15; }
  prepare(run: Run, inputs: SkillUsage[], root?: string) {
    const library = new SqliteSkills(this.db);
    return skillUsagesSchema.parse(inputs).map(input => {
      const version = library.version(run.project_id, input.skill_key, input.version);
      if (!version) throw new MemoryError("not_found", "Register the exact reported skill version first; never substitute the latest version.");
      const row = { ...input, project_id: run.project_id, run_id: run.id, content_hash: version.content_hash, observation_id: input.observation_id ?? null };
      if (row.observation_id) {
        const installation = assertObservation(this.db, row, run.repository, run.environment);
        if (!root || installation["project_root"] !== root)
          throw new MemoryError("scope_mismatch", "Only saved observations from this explicitly launched project root can be attached.");
      }
      return row;
    });
  }
  write(rows: TaskSkillUsageRow[]) {
    for (const row of rows) {
      taskSkillUsageRowSchema.parse(row);
      this.db.prepare("INSERT INTO task_skill_usage VALUES(?,?,?,?,?,?,?,?)").run(row.project_id, row.record_id, row.run_id,
        row.skill_key, row.version, row.content_hash, row.purpose, row.observation_id);
    }
  }
  list(project: string, run: string, offset: number, record?: string): JsonObject {
    if (!this.db.prepare("SELECT 1 FROM runs WHERE project_id=? AND id=?").get(project, run)) throw new MemoryError("not_found", "Task not found in this project.");
    if (!this.supported()) return { items: [], next_offset: null, schema_supported: false, claims_verified: false, loading_status: "unknown" };
    const rows = this.db.prepare(`SELECT u.*,r.seq,r.recorded_at,r.report_origin,r.superseded_by,v.name,
      o.state AS file_state,o.observed_at,o.expected_hash,o.files_json,i.tool,i.folder,i.project_root
      FROM task_skill_usage u JOIN records r ON r.project_id=u.project_id AND r.id=u.record_id
      JOIN skill_versions v ON v.project_id=u.project_id AND v.skill_key=u.skill_key AND v.version=u.version
      LEFT JOIN skill_observations o ON o.project_id=u.project_id AND o.id=u.observation_id
      LEFT JOIN skill_installations i ON i.project_id=o.project_id AND i.id=o.installation_id
      WHERE u.project_id=? AND u.run_id=? ${record ? "AND u.record_id=?" : ""}
      ORDER BY r.seq DESC,u.skill_key,u.version LIMIT ? OFFSET ?`).all(project, run, ...(record ? [record] : []), PAGE + 1, offset);
    const items = rows.slice(0, PAGE).map(row => parseJsonObject(JSON.stringify({
      skill_key: row["skill_key"], name: row["name"], version: row["version"], content_hash: row["content_hash"],
      purpose: row["purpose"], record_id: row["record_id"], run_id: row["run_id"], recorded_at: row["recorded_at"],
      report_origin: row["report_origin"], report_state: row["superseded_by"] ? "superseded" : "reported",
      provenance: "agent_report", claims_verified: false, loading_status: "unknown",
      file_observation: row["observation_id"] ? {
        id: row["observation_id"], state: row["file_state"], observed_at: row["observed_at"], expected_hash: row["expected_hash"],
        files: JSON.parse(String(row["files_json"])), tool: row["tool"], folder: row["folder"], project_root: row["project_root"],
        evidence: "local_files_at_observation_time", current_machine_verified: false,
      } : null,
    })));
    return { items, next_offset: rows.length > PAGE ? offset + PAGE : null, schema_supported: true,
      claims_verified: false, loading_status: "unknown", coverage: "explicit_checkpoint_reports_only" };
  }
}

function assertObservation(db: DatabaseSync, row: Pick<TaskSkillUsageRow, "project_id" | "skill_key" | "version" | "content_hash" | "observation_id">, repository: string, environment: string) {
  const observation = db.prepare(`SELECT o.version AS observation_version,o.expected_hash,i.* FROM skill_observations o
    JOIN skill_installations i ON i.project_id=o.project_id AND i.id=o.installation_id
    WHERE o.project_id=? AND o.id=?`).get(row.project_id, row.observation_id!);
  // The installation's assigned version may change later; compare the immutable observation version.
  if (!observation || observation["observation_version"] !== row.version || observation["expected_hash"] !== row.content_hash
    || observation["skill_key"] !== row.skill_key || observation["repository"] !== repository || observation["environment"] !== environment)
    throw new MemoryError("scope_mismatch", "Observation must match this project, skill version, repository and environment.");
  return observation;
}

/** Transfer validation checks saved identities, not today's machine or model loading. */
export function validateTaskSkillData(db: DatabaseSync) {
  if (Number(db.prepare("PRAGMA user_version").get()?.["user_version"]) < 15) return;
  const library = new SqliteSkills(db);
  for (const raw of db.prepare("SELECT * FROM task_skill_usage").iterate()) {
    const row = taskSkillUsageRowSchema.parse(raw);
    const record = db.prepare("SELECT run_id,repository,environment FROM records WHERE project_id=? AND id=?").get(row.project_id, row.record_id);
    if (!record || record["run_id"] !== row.run_id || library.version(row.project_id, row.skill_key, row.version)?.content_hash !== row.content_hash)
      throw new MemoryError("invalid_data", "Invalid task skill report identity or version.");
    if (row.observation_id) assertObservation(db, row, String(record["repository"]), String(record["environment"]));
  }
}
