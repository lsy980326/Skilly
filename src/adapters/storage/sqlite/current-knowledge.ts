import type { DatabaseSync } from "node:sqlite";
import { currentKnowledgeQuery, type CurrentKnowledgeQuery, type CurrentKnowledgeReader } from "../../../core/work/current-knowledge.js";
import { MemoryError, type JsonObject, type JsonValue } from "../../../core/memory/model.js";
import { planProgress } from "../../../core/plans/model.js";
import type { SourceProvider } from "../../../core/execution/currentness.js";
import { SqliteDecisions } from "./decisions.js";
import { SqlitePlans } from "./plans.js";
import { SqliteWorkReader } from "./work.js";

function rows(value: JsonValue | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter((v): v is JsonObject => v !== null && typeof v === "object" && !Array.isArray(v)) : [];
}
function pick(row: JsonObject, keys: string[]): JsonObject {
  return Object.fromEntries(keys.filter(k => row[k] !== undefined).map(k => [k, row[k]!]));
}
function compactKnowledge(value: JsonValue | undefined): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { ...pick(value, ["status", "reason", "counts", "truncated", "scanned", "limit", "evidence_truncated", "conflicts", "conflicts_truncated", "claims_verified", "coverage", "agent_reports_promoted"]),
    evidence: rows(value["evidence"]).map(e => pick(e, ["execution_id", "run_id", "record_id", "repository", "environment", "status", "result", "reason", "counts"])) };
}
function clipped(value: JsonValue | undefined, max: number): string | null { return typeof value === "string" ? value.slice(0, max) : null; }
function boundedPage(page: JsonObject, offset: number): JsonObject {
  const items = rows(page["items"]), included: JsonObject[] = [];
  for (const item of items) {
    if (Buffer.byteLength(JSON.stringify([...included, item])) > 24 * 1024) break;
    included.push(item);
  }
  // Forward progress even for unusually escaped strings: retain identity and
  // progress only, and explicitly send the caller to the original detail.
  if (!included.length && items.length) included.push({ ...pick(items[0]!, ["subject", "title", "repository", "environment", "component_key", "feature_key", "status", "last_record_id", "plan_key", "version", "progress", "selected_progress", "key", "name"]), projection_truncated: true, claims_verified: false });
  return { ...page, items: included, next_offset: included.length < items.length ? offset + included.length : page["next_offset"] ?? null,
    response_truncated: included.length < items.length || included.some(i => i["projection_truncated"] === true) };
}

/** One read snapshot of existing verdicts. No inference, cache writes or source-path discovery. */
export class SqliteCurrentKnowledge implements CurrentKnowledgeReader {
  constructor(private readonly db: DatabaseSync, private readonly sources?: SourceProvider, private readonly now = Date.now) {}
  query(raw: CurrentKnowledgeQuery): JsonObject {
    const input = currentKnowledgeQuery.parse(raw);
    this.db.exec("SAVEPOINT current_knowledge_read");
    try { return this.read(input); } finally { this.db.exec("RELEASE current_knowledge_read"); }
  }
  private read(input: CurrentKnowledgeQuery): JsonObject {
    const project = this.db.prepare("SELECT id,name,revision FROM projects WHERE id=?").get(input.project_id);
    if (!project) throw new MemoryError("not_found", "Project not found.");
    const cache = new Map<string, ReturnType<SourceProvider>>();
    const sources: SourceProvider = recorded => {
      const key = JSON.stringify([recorded.root_hash, recorded.project_key, recorded.repository, recorded.environment]);
      if (!cache.has(key)) cache.set(key, this.sources?.(recorded));
      return cache.get(key);
    };
    const scope = { project_id: input.project_id, ...(input.repository ? {repository: input.repository} : {}), ...(input.environment ? {environment: input.environment} : {}) };
    const decisionPage = new SqliteDecisions(this.db).query({ ...scope, component: input.component, query: "", offset: input.decisions_offset, limit: input.limit });
    const plans = new SqlitePlans(this.db, sources);
    const planPage = plans.query(scope, { component: input.component, offset: input.plans_offset, limit: input.limit, sort: "active" });
    const planItems = rows(planPage["items"]).map(plan => {
      const detail = plans.query({ project_id: input.project_id, repository: String(plan["repository"]), environment: String(plan["environment"]) }, { plan_key: String(plan["plan_key"]) });
      const all = rows(detail["items"]);
      const selected = input.component ? all.filter(i => input.component === "unclassified" ? !i["component_key"] : i["component_key"] === input.component) : all;
      const remaining = selected.filter(i => i["state"] !== "completed");
      return { ...plan, progress_scope: "whole_plan", selected_progress: planProgress(selected.map(i => ({ required: i["required"] !== false, state: String(i["state"]) }))),
        remaining_total: remaining.length, remaining_truncated: remaining.length > 8,
        remaining_items: remaining.slice(0, 8).map(i => ({ ...pick(i, ["key", "title", "required", "component_key", "feature_key", "state", "run_id", "record_id", "updated_at", "task", "evidence"]),
          note: clipped(i["note"], 240), criteria: rows(i["criteria"]).slice(0, 2).map(c => {
            const result = rows(i["criteria_results"]).find(r => r["key"] === c["key"]);
            return {key: c["key"]!, text: clipped(c["text"], 160), reported_met: result?.["met"] ?? null, report_detail: clipped(result?.["detail"], 160), claims_verified: false};
          }),
          criteria_truncated: rows(i["criteria"]).length > 2 })), claims_verified: false };
    });
    const featurePage = new SqliteWorkReader(this.db, this.now, sources).overview({ ...scope, component: input.component, view: "features", offset: input.features_offset, limit: input.limit }, { sort: "latest" });
    return {
      project_id: input.project_id, project_name: String(project["name"]), project_revision: Number(project["revision"]), observed_at: new Date(this.now()).toISOString(),
      scope: { repository: input.repository ?? null, environment: input.environment ?? null, component: input.component ?? null },
      available_scopes: this.db.prepare("SELECT DISTINCT repository,environment FROM runs WHERE project_id=? ORDER BY repository,environment LIMIT 21").all(input.project_id).slice(0,20).map(r => ({repository:String(r["repository"]),environment:String(r["environment"])})),
      available_components: Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"]) >= 4
        ? this.db.prepare("SELECT key,name FROM components WHERE project_id=? ORDER BY key LIMIT 21").all(input.project_id).slice(0,20).map(r => ({key:String(r["key"]),name:String(r["name"])})) : [],
      components_truncated: Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"]) >= 4
        && Number(this.db.prepare("SELECT count(*) n FROM components WHERE project_id=?").get(input.project_id)?.["n"]) > 20,
      scope_catalog_meaning: "project_scope_candidates_not_connection_authorization",
      scopes_truncated: Number(this.db.prepare("SELECT count(*) n FROM (SELECT DISTINCT repository,environment FROM runs WHERE project_id=?)").get(input.project_id)?.["n"]) > 20,
      decisions: boundedPage({ ...decisionPage, items: rows(decisionPage["items"]).map(i => pick(i, ["subject", "title", "repository", "environment", "component_key", "feature_key", "component_name", "feature_name", "status", "active_choices", "active_choices_truncated", "events_total", "last_record_id", "updated_at", "truncated", "claims_verified"])) }, input.decisions_offset),
      plans: boundedPage({ items: planItems, next_offset: planPage["next_offset"] ?? null, schema_supported: planPage["schema_supported"] ?? true, claims_verified: false }, input.plans_offset),
      checks: boundedPage({ items: rows(featurePage["items"]).map(i => ({ ...pick(i, ["key", "name", "components", "projection_truncated"]), current_knowledge: compactKnowledge(i["current_knowledge"]),
        agent_report: i["latest_report"] && typeof i["latest_report"] === "object" && !Array.isArray(i["latest_report"]) ? pick(i["latest_report"], ["record_id", "repository", "environment", "observed_at", "update", "verified"]) : null })), next_offset: featurePage["next_offset"] ?? null, claims_verified: false }, input.features_offset),
      claims_verified: false, agent_reports_promoted: false, completeness: "bounded_sections", snapshot: "single_database_read",
      meaning: "Decision applicability, reported plan progress and direct check compatibility are separate. No combined verified verdict. Unlinked work and unreceived events remain unknown.",
    };
  }
}
