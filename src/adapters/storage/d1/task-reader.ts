import { z } from "zod";
import { MemoryError, parseJsonObject, type JsonObject } from "../../../core/memory/model.js";
import { reportSchema, workKey } from "../../../core/work/schema.js";
import { D1Discovery } from "./discovery-reader.js";
import type { D1Binding } from "./binding.js";

const text = z.string().min(1).max(100);
const scopeSchema = z.strictObject({ project_id: text, repository: text, environment: text });
const pageSchema = z.strictObject({ offset: z.int().min(0).max(100000).optional(), limit: z.int().min(1).max(10).optional(),
  query: z.string().trim().max(200).optional(), component: workKey.optional(), feature: workKey.optional(), state: z.enum(["active", "completed", "interrupted"]).optional() });
type Scope = z.infer<typeof scopeSchema>;
const encoder = new TextEncoder();
export const D1_READ_LIMITS = Object.freeze({ page_bytes: 24 * 1024, detail_bytes: 128 * 1024, links: 12 });
const evidence = { capture: "agent_reports_only", claims_verified: false, execution_observations: "unsupported" };

function bounded(value: JsonObject, bytes: number): JsonObject {
  if (encoder.encode(JSON.stringify(value)).byteLength > bytes) throw new MemoryError("resource_limit", "Read exceeds the bounded D1 response contract.");
  return value;
}

// Each task, its links and latest reported summary come from ONE SQL read, not N replica reads.
const identity = `
  (SELECT title FROM run_details d WHERE d.project_id=r.project_id AND d.run_id=r.id) AS title,
  (SELECT branch FROM run_details d WHERE d.project_id=r.project_id AND d.run_id=r.id) AS branch,
  (SELECT count(*) FROM run_components x WHERE x.project_id=r.project_id AND x.run_id=r.id) AS components_total,
  (SELECT count(*) FROM run_features x WHERE x.project_id=r.project_id AND x.run_id=r.id) AS features_total,
  (SELECT json_group_array(json(item)) FROM (SELECT json_object('key',c.key,'name',c.name) AS item
    FROM components c JOIN run_components x ON x.project_id=c.project_id AND x.component_key=c.key
    WHERE x.project_id=r.project_id AND x.run_id=r.id ORDER BY c.key LIMIT 12)) AS components_json,
  (SELECT json_group_array(json(item)) FROM (SELECT json_object('key',f.key,'name',f.name,'description',f.description) AS item
    FROM features f JOIN run_features x ON x.project_id=f.project_id AND x.feature_key=f.key
    WHERE x.project_id=r.project_id AND x.run_id=r.id ORDER BY f.key LIMIT 12)) AS features_json,
  (SELECT json_object('record_id',m.id,'title',json_extract(p.report_json,'$.title'),
    'summary',json_extract(p.report_json,'$.summary'),'observed_at',m.observed_at,'report_origin',m.report_origin,
    'provenance','agent_report','claims_verified',json('false'))
    FROM records m JOIN record_reports p ON p.project_id=m.project_id AND p.record_id=m.id
    WHERE m.project_id=r.project_id AND m.run_id=r.id AND m.superseded_by IS NULL AND m.report_origin='contemporaneous'
    ORDER BY m.observed_at DESC,m.seq DESC LIMIT 1) AS latest_report_json`;

/** Narrow async query surface, NOT the synchronous WorkReader or a full MemoryStore.
 * Project/repository/environment are fixed by the caller's host binding, not request-body overrides.
 */
export class D1TaskReader {
  private readonly scope: Scope;
  constructor(private readonly binding: D1Binding, scope: Scope) {
    const parsed = scopeSchema.safeParse(scope);
    if (!parsed.success) throw new MemoryError("invalid_input", "An explicit project/repository/environment scope is required.");
    this.scope = parsed.data;
  }

  private async rows(sql: string, values: (string | number | null)[], max: number): Promise<JsonObject[]> {
    const result = await this.binding.withSession("first-primary").prepare(sql).bind(...values).all();
    if (!result.success || !Array.isArray(result.results) || result.results.length > max) {
      throw new MemoryError("storage_error", "D1 read did not return a bounded result.");
    }
    return result.results.map(row => parseJsonObject(JSON.stringify(row)));
  }
  private values(): string[] { return [this.scope.project_id, this.scope.repository, this.scope.environment]; }
  private task(row: JsonObject): JsonObject {
    const { components_json, features_json, latest_report_json, task_text_match, ...run } = row;
    if (typeof components_json !== "string" || typeof features_json !== "string") throw new MemoryError("invalid_data", "Invalid work links.");
    return { ...run, components: JSON.parse(components_json), features: JSON.parse(features_json),
      links_truncated: Number(row["components_total"]) > 12 || Number(row["features_total"]) > 12,
      latest_report: typeof latest_report_json === "string" ? parseJsonObject(latest_report_json) : null,
      ...(task_text_match!==undefined?{task_text_match:Boolean(task_text_match)}:{}),
      actor_source: row["actor"] === null ? "not_collected" : "self_reported", ...evidence };
  }

  async getTask(runId: string): Promise<JsonObject | null> {
    if (!z.uuid().safeParse(runId).success) throw new MemoryError("invalid_input", "Invalid task ID.");
    const rows = await this.rows(`SELECT r.*,a.actor,${identity} FROM runs r LEFT JOIN run_actors a ON a.run_id=r.id
      WHERE r.project_id=? AND r.repository=? AND r.environment=? AND r.id=?`, [...this.values(), runId], 1);
    return rows[0] ? bounded({ scope: { ...this.scope }, task: this.task(rows[0]), ...evidence }, D1_READ_LIMITS.detail_bytes) : null;
  }

  async getRecord(recordId: string): Promise<JsonObject | null> {
    if (!z.uuid().safeParse(recordId).success) throw new MemoryError("invalid_input", "Invalid record ID.");
    const rows = await this.rows(`SELECT m.*,p.report_json FROM records m
      LEFT JOIN record_reports p ON p.project_id=m.project_id AND p.record_id=m.id
      JOIN runs r ON r.project_id=m.project_id AND r.id=m.run_id
      WHERE r.project_id=? AND r.repository=? AND r.environment=? AND m.id=?
      AND m.repository=r.repository AND m.environment=r.environment`, [...this.values(), recordId], 1);
    if (!rows[0]) return null;
    const { report_json, ...record } = rows[0];
    let report: JsonObject | null = null;
    if (typeof report_json === "string") {
      report = parseJsonObject(report_json);
      if (!reportSchema.safeParse(report).success) throw new MemoryError("invalid_data", "Invalid saved report.");
    }
    return bounded({ scope: { ...this.scope }, record, report, provenance: "agent_report", knowledge_status: "unknown", ...evidence }, D1_READ_LIMITS.detail_bytes);
  }

  async listTasks(input: z.infer<typeof pageSchema> = {}): Promise<JsonObject> {
    const parsed = pageSchema.safeParse(input);
    if (!parsed.success) throw new MemoryError("invalid_input", "Invalid bounded task query.");
    const { offset = 0, limit = 5, component, feature, state, query = "" } = parsed.data;
    const discovery = await D1Discovery.open(this.binding, this.scope);
    const conditions: string[] = [], values: (string | number | null)[] = this.values();
    if (component === "unclassified") conditions.push("NOT EXISTS (SELECT 1 FROM run_components x WHERE x.project_id=r.project_id AND x.run_id=r.id)");
    else if (component) {
      conditions.push("EXISTS (SELECT 1 FROM run_components x WHERE x.project_id=r.project_id AND x.run_id=r.id AND x.component_key=?)"); values.push(component);
    }
    if (feature) {
      conditions.push("EXISTS (SELECT 1 FROM run_features x WHERE x.project_id=r.project_id AND x.run_id=r.id AND x.feature_key=?)"); values.push(feature);
    }
    if (state) { conditions.push("r.state=?"); values.push(state); }
    if (query) {
      const match=discovery.predicate("f",query);
      conditions.push(`(instr(lower(r.goal),lower(?))>0 OR EXISTS(SELECT 1 FROM run_details d WHERE d.project_id=r.project_id AND d.run_id=r.id AND instr(lower(d.title),lower(?))>0)
        OR EXISTS(SELECT 1 FROM run_features x JOIN features f ON f.project_id=x.project_id AND f.key=x.feature_key WHERE x.project_id=r.project_id AND x.run_id=r.id AND ${match.sql}))`);
      values.push(query,query,...match.params);
    }
    // A live offset page, deliberately not an immutable snapshot or a reusable cross-scope cursor.
    const rows = await this.rows(`SELECT r.id,r.project_id,substr(r.goal,1,240) AS goal,length(r.goal)>240 AS goal_truncated,
      r.mode,r.repository,r.environment,r.state,r.created_at,r.updated_at,a.actor,${identity},
      ${query?"(instr(lower(r.goal),lower(?))>0 OR EXISTS(SELECT 1 FROM run_details d WHERE d.project_id=r.project_id AND d.run_id=r.id AND instr(lower(d.title),lower(?))>0))":"0"} AS task_text_match
      FROM runs r LEFT JOIN run_actors a ON a.run_id=r.id WHERE r.project_id=? AND r.repository=? AND r.environment=?
      ${conditions.length ? " AND " + conditions.join(" AND ") : ""} ORDER BY r.updated_at DESC,r.id DESC LIMIT ? OFFSET ?`, [...(query?[query,query]:[]),...values, limit + 1, offset], limit + 1);
    const items: JsonObject[] = [];
    const page: JsonObject = { scope: { ...this.scope }, filters: parseJsonObject(JSON.stringify({ component, feature, state })),
      items, next_offset: null, pagination: "live_offset", discovery_schema_supported: discovery.supported, ...evidence };
    for (const row of rows.slice(0, limit)) {
      let item = this.task(row);
      if(query) {
        const match=discovery.predicate("f",query);
        const features=await this.rows(`SELECT f.* FROM features f JOIN run_features x ON x.project_id=f.project_id AND x.feature_key=f.key
          WHERE x.project_id=? AND x.run_id=? AND ${match.sql} ORDER BY f.key LIMIT 9`,[this.scope.project_id,String(row["id"]),...match.params],9);
        const reasons:JsonObject[]=[];let reasonsTruncated=false;
        for(const f of features.slice(0,8)) { const r=await discovery.reasons(f,query); reasonsTruncated ||= r["match_reasons_truncated"]===true; if(Array.isArray(r["match_reasons"]))reasons.push(...r["match_reasons"].filter((x):x is JsonObject=>x!==null&&typeof x==="object"&&!Array.isArray(x))); }
        item={...item,match_reasons:reasons.slice(0,8),match_reasons_truncated:reasonsTruncated||reasons.length>8||features.length>8};
      }
      items.push(item);
      if (encoder.encode(JSON.stringify(page)).byteLength > D1_READ_LIMITS.page_bytes - 200) {
        items.pop();
        if (items.length) break;
        item = { id: row["id"]!, state: row["state"]!, updated_at: row["updated_at"]!, projection_truncated: true, ...evidence };
        items.push(item);
        break;
      }
    }
    if (rows.length > items.length) {
      const next = offset + items.length;
      if (next <= 100000) page["next_offset"] = next;
      else { page["pagination_truncated"] = true; page["pagination_reason"] = "offset_limit"; }
    }
    return bounded(page, D1_READ_LIMITS.page_bytes);
  }
}
