import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { MemoryError, type JsonObject } from "../../../core/memory/model.js";
import { tables } from "../../../core/transfer/format.js";

export const authorityRow = z.strictObject({ project_id:z.uuid(), project_key:z.string().min(1).max(100), transfer_id:z.uuid(),
  generation:z.int().positive(), role:z.enum(["source","target","return"]), state:z.enum(["blocked","writable"]), updated_at:z.iso.datetime() });
export type AuthorityRow = z.infer<typeof authorityRow>;
export type AuthorityKind = "main" | "recovery" | "events";
export function hasAuthority(db: DatabaseSync): boolean { return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='project_authority'").get()); }

/** Fixed SQL only. Triggers also fence connections opened before this metadata existed. */
export function authoritySql(kind: AuthorityKind, linked = true, portable = false): string {
  let sql = `CREATE TABLE IF NOT EXISTS project_authority (
    project_id TEXT PRIMARY KEY, project_key TEXT NOT NULL UNIQUE, transfer_id TEXT NOT NULL,
    generation INTEGER NOT NULL, role TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;`;
  const guarded = kind === "main" ? tables.filter(t=>t!=="requests" && (t!=="storage_origins" || portable)) : kind === "recovery" ? ["requests"]
    : ["events", ...(linked ? ["task_links","event_task_links","event_link_failures"] : [])];
  for (const table of guarded) {
    const owner = (row:string) => kind === "events"
      ? table === "events" || table === "task_links" ? `a.project_key=${row}.project_key`
        : `a.project_id=(SELECT project_id FROM task_links WHERE id=${row}.link_id)`
      : table === "projects" ? `a.project_id=${row}.id OR a.project_key=${row}.project_key`
      : table === "run_actors" ? `a.project_id=(SELECT project_id FROM runs WHERE id=${row}.run_id)`
      : table === "receipts" ? `a.project_id=${row}.scope OR (a.project_id=json_extract(${row}.result_json,'$.project.id'))`
      : `a.project_id=${row}.project_id`;
    for (const operation of ["INSERT","UPDATE","DELETE"] as const) {
      const rows = operation === "INSERT" ? ["NEW"] : operation === "DELETE" ? ["OLD"] : ["OLD","NEW"];
      sql += `CREATE TRIGGER IF NOT EXISTS authority_${table}_${operation.toLowerCase()} BEFORE ${operation} ON ${table}
        WHEN EXISTS(SELECT 1 FROM project_authority a WHERE a.state!='writable' AND (${rows.map(owner).join(" OR ")}))
        BEGIN SELECT RAISE(ABORT,'project_write_blocked'); END;`;
    }
  }
  return sql;
}
export function validateAuthority(db: DatabaseSync): void {
  if (!hasAuthority(db)) return;
  for (const row of db.prepare("SELECT * FROM project_authority").iterate()) authorityRow.parse(row);
}
export function readAuthority(db: DatabaseSync, projectId: string): JsonObject {
  try {
    if (!hasAuthority(db)) return { status:"writable", write_allowed:true, managed:false, automatic_forwarding:false, claims_verified:false };
    const row = db.prepare("SELECT * FROM project_authority WHERE project_id=?").get(projectId);
    if (!row) return { status:"writable", write_allowed:true, managed:false, automatic_forwarding:false, claims_verified:false };
    const a=authorityRow.parse(row);
    return { status:a.state === "writable" ? "writable" : "fenced", write_allowed:a.state === "writable", managed:true,
      transfer_id:a.transfer_id,generation:a.generation,current_copy:a.role,updated_at:a.updated_at,
      automatic_forwarding:false,automatic_replay:false,claims_verified:false };
  } catch { return {status:"unavailable",write_allowed:false,automatic_forwarding:false,claims_verified:false}; }
}
export function assertWritable(db: DatabaseSync, projectId: string): void {
  if (readAuthority(db,projectId)["write_allowed"] !== true) throw new MemoryError("project_write_blocked", "This project copy is fenced for transfer. Read its authority status; no forwarding or automatic retry.");
}
export function putAuthority(db: DatabaseSync, kind: AuthorityKind, row: AuthorityRow, linked = true): void {
  authorityRow.parse(row);
  db.exec(authoritySql(kind,linked,Number(db.prepare("PRAGMA user_version").get()?.["user_version"])>=16));
  const existing=db.prepare("SELECT * FROM project_authority WHERE project_id=? OR project_key=?").get(row.project_id,row.project_key);
  if(existing) {
    const old=authorityRow.parse(existing);
    if(old.project_id!==row.project_id || old.project_key!==row.project_key || old.generation>row.generation
      || (old.transfer_id!==row.transfer_id && (old.state!=="writable" || old.generation>=row.generation)))
      throw new MemoryError("authority_conflict","Another transfer owns this project copy. Nothing was activated.");
  }
  db.prepare(`INSERT INTO project_authority VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET
    transfer_id=excluded.transfer_id,generation=excluded.generation,role=excluded.role,state=excluded.state,updated_at=excluded.updated_at`)
    .run(row.project_id,row.project_key,row.transfer_id,row.generation,row.role,row.state,row.updated_at);
}
