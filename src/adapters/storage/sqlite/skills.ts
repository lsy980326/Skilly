import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { MemoryError, parseJsonObject, type JsonObject } from "../../../core/memory/model.js";
import { registerSkillSchema, skillContentHash, observationFilesSchema, type Installation, type SkillChange, type SkillRepository, type SkillVersion } from "../../../core/skills/model.js";
import { componentSelection, type InstallationComponent } from "../../../core/viewer/components.js";
import { componentProjection, componentWhere } from "./component-links.js";

const installationMatch="json_extract(b.value,'$.root')=i.project_root AND json_extract(b.value,'$.repository')=i.repository AND json_extract(b.value,'$.environment')=i.environment";

export class SqliteSkills implements SkillRepository {
  constructor(private readonly db: DatabaseSync, private readonly bindings: InstallationComponent[] = []) {}
  private componentBindings(projectId:string) {
    const key=this.db.prepare("SELECT project_key FROM projects WHERE id=?").get(projectId)?.["project_key"];
    return JSON.stringify(this.bindings.filter(b=>b.project_key===key));
  }
  private components(projectId:string,key:string) {
    return componentProjection(this.db.prepare(`SELECT DISTINCT json_extract(b.value,'$.key') AS key,json_extract(b.value,'$.name') AS name
      FROM skill_installations i JOIN json_each(?) b ON ${installationMatch} WHERE i.project_id=? AND i.skill_key=? ORDER BY key LIMIT 13`)
      .all(this.componentBindings(projectId),projectId,key),"installation_binding");
  }
  private project(id: string): void { if (!this.db.prepare("SELECT id FROM projects WHERE id=?").get(id)) throw new MemoryError("not_found", "Project not found."); }
  private supported(): boolean { return Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"]) >= 5; }
  version(projectId: string, key: string, version: string): SkillVersion | undefined {
    this.project(projectId);
    const row = this.db.prepare("SELECT * FROM skill_versions WHERE project_id=? AND skill_key=? AND version=?").get(projectId, key, version);
    if (!row) return undefined;
    const { files_json, content_hash, created_at, ...fields } = row;
    const { idempotency_key: _key, ...data } = registerSkillSchema.parse({ ...fields, files: JSON.parse(String(files_json)), idempotency_key: "stored" });
    if (skillContentHash(data.body, data.files) !== content_hash) throw new MemoryError("invalid_data", "Skill content hash does not match its version.");
    return { ...data, content_hash: String(content_hash), created_at: String(created_at) };
  }
  installation(projectId: string, id: string): Installation | undefined {
    this.project(projectId);
    const row = this.db.prepare("SELECT * FROM skill_installations WHERE project_id=? AND id=?").get(projectId, id);
    if (!row) return undefined;
    if (row["tool"] !== "codex" && row["tool"] !== "cursor") throw new MemoryError("invalid_data", "Invalid tool.");
    return { id: String(row["id"]), project_id: projectId, skill_key: String(row["skill_key"]), version: String(row["version"]), repository: String(row["repository"]), environment: String(row["environment"]),
      project_root: String(row["project_root"]), tool: row["tool"], folder: String(row["folder"]), assigned_at: String(row["assigned_at"]) };
  }
  receipt(projectId: string, key: string, hash: string): JsonObject | undefined {
    const row = this.db.prepare("SELECT * FROM receipts WHERE scope=? AND idempotency_key=?").get(projectId, key);
    if (!row) return undefined;
    if (row["payload_hash"] !== hash) throw new MemoryError("idempotency_conflict", "This key is already used for another input.");
    return parseJsonObject(String(row["result_json"]));
  }
  source(projectId: string, key: string): string | undefined {
    const row = this.db.prepare("SELECT source FROM skill_versions WHERE project_id=? AND skill_key=? LIMIT 1").get(projectId, key);
    return row ? String(row["source"]) : undefined;
  }
  save(projectId: string, key: string, hash: string, result: JsonObject, change: SkillChange): JsonObject {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.project(projectId);
      const receipt = this.receipt(projectId, key, hash);
      if (receipt) { this.db.exec("ROLLBACK"); return receipt; }
      if (change.version) {
        const v = change.version;
        const source = this.source(projectId, v.skill_key);
        if (source && source !== v.source) throw new MemoryError("source_conflict", "A different source already owns this skill key.");
        const existing = this.version(projectId, v.skill_key, v.version);
        if (existing) throw new MemoryError("version_conflict", "Version changed concurrently; retry with the original key.", true);
        this.db.prepare("INSERT INTO skill_versions VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(projectId, v.skill_key, v.version, v.source, v.name,
          v.description, v.body, JSON.stringify(v.files), v.content_hash, v.install_instructions, v.created_at);
      }
      if (change.installation) {
        const i = change.installation;
        const row = this.db.prepare(`INSERT INTO skill_installations VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(project_id,skill_key,repository,environment,project_root,tool,folder)
          DO UPDATE SET version=excluded.version, assigned_at=excluded.assigned_at RETURNING id`)
          .get(i.id, projectId, i.skill_key, i.version, i.repository, i.environment, i.project_root, i.tool, i.folder, i.assigned_at);
        result = { ...result, installation_id: String(row?.["id"]) };
      }
      if (change.observation) {
        const o = change.observation;
        const assigned = this.installation(projectId, o.installation_id);
        if (assigned?.version !== o.version) throw new MemoryError("conflict", "Assignment changed during inspection; no observation saved.", true);
        this.db.prepare("INSERT INTO skill_observations (id,project_id,installation_id,version,expected_hash,observed_at,state,files_json) VALUES (?,?,?,?,?,?,?,?)").run(o.id, projectId, o.installation_id, o.version,
          o.expected_hash, o.observed_at, o.state, JSON.stringify(o.files));
      }
      this.db.prepare("UPDATE projects SET revision=revision+1 WHERE id=?").run(projectId);
      this.db.prepare("INSERT INTO receipts VALUES (?,?,?,?)").run(projectId, key, hash, JSON.stringify(result));
      this.db.exec("COMMIT"); return result;
    } catch (error) { if (this.db.isTransaction) this.db.exec("ROLLBACK"); throw error; }
  }
  list(projectId: string, offset: number, limit: number, query: string, sort?: ListSort, component?:string): JsonObject {
    this.project(projectId);
    componentSelection(component);
    if (!this.supported()) return { items: [], next_offset: null, schema_supported: false };
    const relation=`SELECT 1 FROM skill_installations i JOIN json_each(?) b ON ${installationMatch} WHERE i.project_id=v.project_id AND i.skill_key=v.skill_key`;
    const selected=componentWhere(component,relation,"json_extract(b.value,'$.key')");
    const order=listOrder(sort,{name:"name",date:"registered_at",active:"0=1",tie:"skill_key",fallback:"skill_key"});
    const rows = this.db.prepare(`SELECT skill_key,name,source,count(*) AS versions,max(created_at) AS registered_at
      FROM skill_versions v WHERE project_id=? AND (instr(lower(name),lower(?))>0 OR instr(lower(skill_key),lower(?))>0) AND ${selected.sql}
      GROUP BY skill_key ORDER BY ${order} LIMIT ? OFFSET ?`).all(projectId, query, query,...(component?[this.componentBindings(projectId),...selected.params]:[]), limit + 1, offset);
    return { items: rows.slice(0, limit).map(row => ({ ...row, ...this.components(projectId,String(row["skill_key"])),
      installations: this.installations(projectId, String(row["skill_key"]),0,3,component).slice(0, 3).map(i => ({ id: i["id"]!, version: i["version"]!, repository: i["repository"]!, tool: i["tool"]!, folder: i["folder"]!, state: i["state"]!, observed_at: i["observed_at"] ?? null })),
      installations_total: this.db.prepare("SELECT count(*) AS n FROM skill_installations WHERE project_id=? AND skill_key=?").get(projectId, row["skill_key"]!)?.["n"] ?? 0,
    })) as JsonObject[], next_offset: rows.length > limit ? offset + limit : null, schema_supported: true, loading_status: "unknown" };
  }
  private installations(projectId: string, key: string, offset = 0, limit = 3, component?:string): JsonObject[] {
    const selected=componentWhere(component,`SELECT 1 FROM json_each(?) b WHERE ${installationMatch}`,"json_extract(b.value,'$.key')");
    return this.db.prepare(`SELECT i.*,o.id AS observation_id,o.observed_at,o.state,o.version AS observed_version,o.expected_hash
      FROM skill_installations i LEFT JOIN skill_observations o ON o.id=(SELECT id FROM skill_observations
        WHERE project_id=i.project_id AND installation_id=i.id ORDER BY observed_at DESC,seq DESC LIMIT 1)
      WHERE i.project_id=? AND i.skill_key=? AND ${selected.sql} ORDER BY i.repository,i.tool,i.folder,i.id LIMIT ? OFFSET ?`)
      .all(projectId, key,...(component?[this.componentBindings(projectId),...selected.params]:[]), limit, offset).map(row => ({ ...row, state: row["observed_version"] === row["version"] ? row["state"] : "not_checked",
        evidence: "last_saved_file_observation", loading_status: "unknown", current_machine_verified: false })) as JsonObject[];
  }
  detail(projectId: string, key: string, version?: string, installationOffset = 0): JsonObject {
    this.project(projectId);
    if (!this.supported()) throw new MemoryError("not_found", "No skill library in this older DB.");
    const versions = this.db.prepare("SELECT version,content_hash,created_at FROM skill_versions WHERE project_id=? AND skill_key=? ORDER BY created_at DESC,rowid DESC LIMIT 101").all(projectId, key);
    const chosen = version ?? (versions[0] ? String(versions[0]["version"]) : "");
    const selected = this.version(projectId, key, chosen);
    if (!selected) throw new MemoryError("not_found", "Skill version not found in this project.");
    const allInstallations = this.installations(projectId, key, installationOffset, 7), installations = allInstallations.slice(0, 6);
    return { skill: parseJsonObject(JSON.stringify(selected)), versions: versions.slice(0, 100) as JsonObject[], versions_truncated: versions.length > 100,
      installations: installations.map(i => ({ ...i, files: i["observation_id"] ? JSON.parse(String(this.db.prepare("SELECT files_json FROM skill_observations WHERE project_id=? AND id=?").get(projectId, String(i["observation_id"]))?.["files_json"])) : [] })) as JsonObject[],
      installation_offset: installationOffset, next_installation_offset: allInstallations.length > 6 ? installationOffset + 6 : null, content_is_untrusted: true, loading_status: "unknown" };
  }
}

/** Import/backup validation treats skill payloads as data, never runnable configuration. */
export function validateSkillData(db: DatabaseSync): void {
  const reader = new SqliteSkills(db);
  if (db.prepare("SELECT 1 FROM skill_versions GROUP BY project_id,skill_key HAVING count(DISTINCT source)>1 LIMIT 1").get()) throw new MemoryError("source_conflict", "Imported skill versions mix different sources under one key.");
  for (const row of db.prepare("SELECT project_id,skill_key,version FROM skill_versions").iterate()) {
    reader.version(String(row["project_id"]), String(row["skill_key"]), String(row["version"]));
  }
  for (const row of db.prepare("SELECT * FROM skill_observations ORDER BY seq").iterate()) {
    const installation = reader.installation(String(row["project_id"]), String(row["installation_id"]));
    const version = installation ? reader.version(String(row["project_id"]), installation.skill_key, String(row["version"])) : undefined;
    if (!version || version.content_hash !== row["expected_hash"]) throw new MemoryError("invalid_data", "Observation version/hash is not preserved.");
    const files = observationFilesSchema.parse(JSON.parse(String(row["files_json"])));
    const expectedPaths = ["SKILL.md", ...version.files.map(f => f.path)].sort();
    if (JSON.stringify(files.map(f => f.path).sort()) !== JSON.stringify(expectedPaths)) throw new MemoryError("invalid_data", "Observation files do not match the package.");
    const content = new Map([["SKILL.md", version.body], ...version.files.map(file => [file.path, file.content] as [string, string])]);
    for (const file of files) {
      const expected = content.get(file.path)!;
      const digest = createHash("sha256").update(expected).digest("hex");
      if ((file.state === "matches" && (file.hash !== digest || file.bytes !== Buffer.byteLength(expected)))
        || (file.state === "modified" && file.hash === digest)) throw new MemoryError("invalid_data", "Observed file state contradicts its saved hash.");
    }
    const state = files.some(f => f.state === "unavailable") ? "unavailable" : files.some(f => f.state === "missing") ? "missing" : files.some(f => f.state === "modified") ? "modified" : "matches";
    if (state !== row["state"] || files.some(f => ["matches", "modified"].includes(f.state) ? f.hash === null || f.bytes === null : f.hash !== null || f.bytes !== null)) {
      throw new MemoryError("invalid_data", "Observation status is inconsistent.");
    }
  }
}
import { listOrder } from "./list-sort.js";
import type { ListSort } from "../../../core/viewer/sorting.js";
