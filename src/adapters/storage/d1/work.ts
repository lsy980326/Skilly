import { z } from "zod";
import { MemoryError, type Mutation } from "../../../core/memory/model.js";
import type { WorkMutation } from "../../../core/work/model.js";
import { reportSchema, workLinks } from "../../../core/work/schema.js";

const metadata = z.strictObject({ ...workLinks, run_id: z.uuid().optional(), record_id: z.uuid().optional(),
  title: z.string().trim().min(1).max(160).optional(), branch: z.string().trim().min(1).max(200).optional(), report: reportSchema.optional() });
type Sql = (sql: string, ...values: (string | number | null)[]) => void;

/** Validate before creating a session. Never silently discard nested unsupported metadata. */
export function validateD1Work(change: Mutation): WorkMutation[] {
  if ((change.work !== undefined && !metadata.safeParse(change.work).success)
    || (change.reports !== undefined && !z.array(metadata).max(8).safeParse(change.reports).success)) {
    throw new MemoryError("invalid_input", "Invalid D1 work metadata.");
  }
  const entries = [...(change.work ? [change.work] : []), ...(change.reports ?? [])];
  if (entries.length > 9) throw new MemoryError("resource_limit", "At most nine work entries per mutation.");
  const records = [...(change.record ? [change.record] : []), ...(change.records ?? [])];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!metadata.safeParse(entry).success) throw new MemoryError("invalid_input", "Invalid D1 work metadata.");
    if (entry.features?.some(feature => feature.aliases !== undefined || feature.code_paths !== undefined)) {
      if (!entry.run_id) throw new MemoryError("scope_mismatch", "Feature discovery metadata requires its own task.");
    }
    // Catalog-only binding registration is allowed; task details/reports require the mutation's own run.
    if (entry.run_id && entry.run_id !== change.run?.id && !records.some(r => r.run_id === entry.run_id)) {
      throw new MemoryError("scope_mismatch", "Work metadata must target this mutation's task.");
    }
    if ((entry.title || entry.branch || entry.record_id || entry.report) && !entry.run_id) {
      throw new MemoryError("scope_mismatch", "Task metadata requires a task ID.");
    }
    if (entry.report && !entry.record_id) throw new MemoryError("scope_mismatch", "A report requires a new record.");
    if (entry.record_id) {
      if (!records.some(r => r.id === entry.record_id && r.run_id === entry.run_id) || seen.has(entry.record_id)) {
        throw new MemoryError("scope_mismatch", "A report must belong to one new record in its own task.");
      }
      seen.add(entry.record_id);
    }
  }
  return entries;
}

/** Append statements to the same CAS/record/receipt batch; no independent writes or pre-read races. */
export function appendD1Work(projectId: string, entry: WorkMutation, sql: Sql, assertOne: () => void): void {
  const runId = entry.run_id;
  for (const c of entry.components ?? []) {
    sql(`INSERT INTO components VALUES (?,?,?) ON CONFLICT(project_id,key) DO UPDATE SET name=components.name
      WHERE components.name=excluded.name`, projectId, c.key, c.name);
    assertOne();
    if (runId) sql("INSERT INTO run_components VALUES (?,?,?) ON CONFLICT DO NOTHING", projectId, runId, c.key);
  }
  for (const f of entry.features ?? []) {
    sql(`INSERT INTO features VALUES (?,?,?,?) ON CONFLICT(project_id,key) DO UPDATE SET name=features.name
      WHERE features.name=excluded.name AND (? IS NULL OR features.description=excluded.description)`,
    projectId, f.key, f.name, f.description ?? "", f.description ?? null);
    assertOne();
    if (runId) sql("INSERT INTO run_features VALUES (?,?,?) ON CONFLICT DO NOTHING", projectId, runId, f.key);
  }
  if (runId && (entry.title || entry.branch)) {
    sql("INSERT INTO run_details VALUES (?,?,?,?) ON CONFLICT DO NOTHING", projectId, runId, entry.title ?? null, entry.branch ?? null);
  }
  if (entry.record_id && entry.report) {
    for (const update of entry.report.feature_updates ?? []) {
      sql(`INSERT INTO skilly_write_assertions (id,ok) VALUES (1,CASE WHEN EXISTS
        (SELECT 1 FROM run_features WHERE project_id=? AND run_id=? AND feature_key=?) THEN 1 ELSE 0 END)`, projectId, runId!, update.key);
      sql("DELETE FROM skilly_write_assertions WHERE id=1");
    }
    sql(`INSERT INTO record_reports SELECT ?,?,? WHERE EXISTS
      (SELECT 1 FROM records WHERE project_id=? AND id=? AND run_id=?)`,
    projectId, entry.record_id, JSON.stringify(entry.report), projectId, entry.record_id, runId!);
    assertOne();
  }
}
