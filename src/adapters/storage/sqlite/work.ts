import { unreviewedRunSql, SqliteRunReviews } from "./run-reviews.js";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { MemoryError, parseJsonObject, type JsonObject } from "../../../core/memory/model.js";
import type { OverviewQuery, StructuredReport, WorkIdentity, WorkMutation, WorkReader } from "../../../core/work/model.js";
import { reportSchema } from "../../../core/work/schema.js";
import { activityFor } from "../../../core/viewer/model.js";
import { featureActivity, featureExecutions } from "./feature-status.js";
import { FeatureDiscovery, writeFeatureDiscovery } from "./feature-discovery.js";

type Row = Record<string, SQLOutputValue>;
function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new MemoryError("invalid_data", "Invalid work metadata.");
  return value;
}
function json(value: unknown): JsonObject { return parseJsonObject(JSON.stringify(value)); }

/** Shared projection for MCP and HTTP. Reads never create/migrate/enrich data. */
export class SqliteWorkReader implements WorkReader {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = Date.now) {}
  private version(): number { return Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"]); }

  identity(projectId: string, runId: string): WorkIdentity {
    if (this.version() < 4) return { components: [], features: [] };
    const details = this.db.prepare("SELECT title, branch FROM run_details WHERE project_id = ? AND run_id = ?").get(projectId, runId);
    const componentsTotal = Number(this.db.prepare("SELECT count(*) AS n FROM run_components WHERE project_id=? AND run_id=?").get(projectId, runId)?.["n"]);
    const featuresTotal = Number(this.db.prepare("SELECT count(*) AS n FROM run_features WHERE project_id=? AND run_id=?").get(projectId, runId)?.["n"]);
    return {
      ...(typeof details?.["title"] === "string" ? { title: details["title"] } : {}),
      ...(typeof details?.["branch"] === "string" ? { branch: details["branch"] } : {}),
      components: this.db.prepare(`SELECT c.key, c.name FROM components c JOIN run_components x
        ON x.project_id = c.project_id AND x.component_key = c.key WHERE x.project_id = ? AND x.run_id = ? ORDER BY c.key LIMIT 12`)
        .all(projectId, runId).map(r => ({ key: text(r, "key"), name: text(r, "name") })),
      features: this.db.prepare(`SELECT f.key, f.name, f.description FROM features f JOIN run_features x
        ON x.project_id = f.project_id AND x.feature_key = f.key WHERE x.project_id = ? AND x.run_id = ? ORDER BY f.key LIMIT 12`)
        .all(projectId, runId).map(r => ({ key: text(r, "key"), name: text(r, "name"), description: text(r, "description") })),
      components_total: componentsTotal, features_total: featuresTotal, links_truncated: componentsTotal > 12 || featuresTotal > 12,
    };
  }

  report(projectId: string, recordId: string): StructuredReport | undefined {
    if (this.version() < 4) return undefined;
    const row = this.db.prepare("SELECT report_json FROM record_reports WHERE project_id = ? AND record_id = ?").get(projectId, recordId);
    return row ? reportSchema.parse(JSON.parse(text(row, "report_json"))) : undefined;
  }

  private latest(projectId: string, runId: string) {
    if (this.version() < 4) return null;
    const row = this.db.prepare(`SELECT r.id, r.observed_at, r.source_fingerprint, r.report_origin,
      json_extract(p.report_json, '$.summary') AS summary FROM records r JOIN record_reports p
      ON p.project_id = r.project_id AND p.record_id = r.id
      WHERE r.project_id = ? AND r.run_id = ? AND r.superseded_by IS NULL AND r.report_origin = 'contemporaneous'
      ORDER BY r.observed_at DESC, r.seq DESC LIMIT 1`).get(projectId, runId);
    return row ? { ...row, verified: false } : null;
  }

  overview(input: OverviewQuery, options: { unreviewed?: boolean } = {}): JsonObject {
    const { project_id: pid, view, offset, limit } = input;
    const version = this.version();
    const discovery = new FeatureDiscovery(this.db, version);
    const conditions = ["r.project_id = ?"], params: SQLInputValue[] = [pid];
    for (const field of ["repository", "environment"] as const) {
      if (input[field]) { conditions.push(`r.${field} = ?`); params.push(input[field]); }
    }
    if (input.component) {
      if (version < 4) conditions.push(input.component === "unclassified" ? "1" : "0");
      else if (input.component === "unclassified") conditions.push("NOT EXISTS (SELECT 1 FROM run_components x WHERE x.project_id = r.project_id AND x.run_id = r.id)");
      else { conditions.push("EXISTS (SELECT 1 FROM run_components x WHERE x.project_id = r.project_id AND x.run_id = r.id AND x.component_key = ?)"); params.push(input.component); }
    }
    if (input.feature) {
      if (version < 4) conditions.push("0");
      else { conditions.push("EXISTS (SELECT 1 FROM run_features x WHERE x.project_id = r.project_id AND x.run_id = r.id AND x.feature_key = ?)"); params.push(input.feature); }
    }
    const where = conditions.join(" AND ");
    const unclassified = version >= 4 ? "NOT EXISTS (SELECT 1 FROM run_components x WHERE x.project_id = r.project_id AND x.run_id = r.id)" : "1";
    const summary = this.db.prepare(`SELECT count(*) AS total, coalesce(sum(r.state = 'active'),0) AS unfinished,
      coalesce(sum(r.state = 'interrupted'),0) AS interrupted, coalesce(sum(${unclassified}),0) AS unclassified
      FROM runs r WHERE ${where}`).get(...params);
    let rows: Row[];
    if (view === "tasks") {
      const filters = [...conditions], values = [...params];
      if (options.unreviewed && version >= 9) filters.push(unreviewedRunSql);
      if (input.state && input.state !== "all") { filters.push("r.state = ?"); values.push(input.state); }
      if (input.query) {
        const matched = version >= 4 ? discovery.predicate("f", input, true) : null;
        filters.push("(instr(lower(r.goal),lower(?)) > 0 OR instr(lower(r.repository),lower(?)) > 0" +
          (version >= 4 ? " OR EXISTS (SELECT 1 FROM run_details d WHERE d.project_id = r.project_id AND d.run_id = r.id AND instr(lower(d.title),lower(?)) > 0)" : "") +
          (matched ? ` OR EXISTS (SELECT 1 FROM run_features x JOIN features f ON f.project_id=x.project_id AND f.key=x.feature_key WHERE x.project_id=r.project_id AND x.run_id=r.id AND ${matched.sql})` : "") + ")");
        values.push(input.query, input.query); if (version >= 4) values.push(input.query);
        if (matched) values.push(...matched.params);
      }
      rows = this.db.prepare(`SELECT r.*${version >= 3 ? ", a.actor" : ", NULL AS actor"} FROM runs r
        ${version >= 3 ? "LEFT JOIN run_actors a ON a.run_id = r.id" : ""}
        WHERE ${filters.join(" AND ")} ORDER BY r.updated_at DESC, r.id DESC LIMIT ? OFFSET ?`).all(...values, limit + 1, offset);
    } else if (version < 4) rows = [];
    else {
      const table = view === "components" ? "components" : "features";
      const links = view === "components" ? "run_components" : "run_features";
      const key = view === "components" ? "component_key" : "feature_key";
      const scoped = Boolean(input.repository || input.environment || input.component || input.feature);
      const matched = view === "features" && input.query ? discovery.predicate("c",input) : null;
      rows = this.db.prepare(`SELECT c.*, (SELECT count(*) FROM ${links} x JOIN runs r ON r.project_id=x.project_id AND r.id=x.run_id
          WHERE x.project_id=c.project_id AND x.${key}=c.key AND ${where}) AS total,
        (SELECT count(*) FROM ${links} x JOIN runs r ON r.project_id=x.project_id AND r.id=x.run_id
          WHERE x.project_id=c.project_id AND x.${key}=c.key AND ${where} AND r.state='active') AS unfinished
        FROM ${table} c WHERE c.project_id = ?
        ${scoped ? `AND EXISTS (SELECT 1 FROM ${links} x JOIN runs r ON r.project_id=x.project_id AND r.id=x.run_id WHERE x.project_id=c.project_id AND x.${key}=c.key AND ${where})` : ""}
        ${matched ? `AND ${matched.sql}` : ""}
        ORDER BY c.key LIMIT ? OFFSET ?`).all(...params, ...params, pid, ...(scoped ? params : []), ...(matched?.params ?? []), limit + 1, offset);
    }
    const items: JsonObject[] = [];
    const response: JsonObject = { project_id: pid, view, summary: json(summary), items, next_offset: null,
      scope: json({ repository: input.repository ?? null, environment: input.environment ?? null, component: input.component ?? null, feature: input.feature ?? null }),
      capture: "agent_reports_only", claims_verified: false, observed_at: new Date(this.now()).toISOString() };
    if (input.query) response["search"] = { query: input.query, matching: "literal_names_aliases_and_path_segments", classification: "unchanged", metadata_source: "explicit_declarations", file_access: "not_performed" };
    for (const row of rows.slice(0, limit)) {
      let item: JsonObject;
      if (view === "tasks") {
        const state = text(row, "state");
        if (state !== "active" && state !== "completed" && state !== "interrupted") throw new MemoryError("invalid_data", "Invalid task state.");
        const identity = this.identity(pid, text(row, "id"));
        item = json({ ...row, ...identity, features: identity.features.map(({ key, name }) => ({ key, name })), latest_report: this.latest(pid, text(row, "id")),
          user_review: new SqliteRunReviews(this.db).status(pid, text(row, "id"), text(row, "updated_at")),
          actor_source: row["actor"] ? "self_reported" : "not_collected", activity: activityFor(state, text(row, "updated_at"), this.now()) });
        if (input.query) {
          const taskScope = { ...input, repository: text(row,"repository"), environment: text(row,"environment") };
          const reasons: unknown[] = [];
          for (const [field,label] of [["goal","작업 요청"],["repository","저장소"],["title","작업 제목"]] as const) {
            const value = item[field];
            if (typeof value === "string" && value.toLowerCase().includes(input.query.toLowerCase())) reasons.push({kind:field,label,value});
          }
          if (version >= 4) {
            const matched = discovery.predicate("f",taskScope);
            const features = this.db.prepare(`SELECT f.* FROM features f JOIN run_features x ON x.project_id=f.project_id AND x.feature_key=f.key
              WHERE x.project_id=? AND x.run_id=? AND ${matched.sql} ORDER BY f.key LIMIT 9`).all(pid,text(row,"id"),...matched.params);
            for (const feature of features) reasons.push(...discovery.reasons({key:text(feature,"key"),name:text(feature,"name"),description:text(feature,"description")},taskScope));
            item["match_reasons_truncated"] = reasons.length > 8 || features.length > 8;
          }
          item["match_reasons"] = json({items:reasons.slice(0,8)})["items"]!;
        }
      }
      else if (view === "features") {
        const latest = this.db.prepare(`SELECT r.id AS record_id, r.observed_at, r.environment, r.repository,
          r.source_fingerprint, j.value AS update_json FROM records r JOIN run_features x
          ON x.project_id = r.project_id AND x.run_id = r.run_id
          JOIN record_reports p ON p.project_id = r.project_id AND p.record_id = r.id,
          json_each(p.report_json, '$.feature_updates') j
          WHERE r.project_id = ? AND x.feature_key = ? AND json_extract(j.value,'$.key') = x.feature_key
          AND r.superseded_by IS NULL AND r.report_origin = 'contemporaneous'
          ${input.repository ? "AND r.repository = ?" : ""} ${input.environment ? "AND r.environment = ?" : ""}
          ${input.feature ? "AND EXISTS (SELECT 1 FROM run_features selected WHERE selected.project_id=r.project_id AND selected.run_id=r.run_id AND selected.feature_key=?)" : ""}
          ${input.component === "unclassified" ? "AND NOT EXISTS (SELECT 1 FROM run_components rc WHERE rc.project_id=r.project_id AND rc.run_id=r.run_id)"
            : input.component ? "AND EXISTS (SELECT 1 FROM run_components rc WHERE rc.project_id=r.project_id AND rc.run_id=r.run_id AND rc.component_key=?)" : ""}
          ORDER BY r.observed_at DESC, r.seq DESC LIMIT 1`).get(pid, text(row, "key"),
            ...(input.repository ? [input.repository] : []), ...(input.environment ? [input.environment] : []), ...(input.feature ? [input.feature] : []), ...(input.component && input.component !== "unclassified" ? [input.component] : []));
        item = json({ ...row, discovery: discovery.metadata(pid,text(row,"key"),input), match_reasons: discovery.reasons({key:text(row,"key"),name:text(row,"name"),description:text(row,"description")},input), latest_report: latest ? { ...latest, update: parseJsonObject(text(latest, "update_json")), update_json: undefined, verified: false } : null,
          latest_activity: featureActivity(this.db, input, text(row, "key")), execution_evidence: featureExecutions(this.db, input, text(row, "key")) });
      } else item = json(row);
      items.push(item);
      if (new TextEncoder().encode(JSON.stringify(response)).byteLength > 30 * 1024) {
        items.pop();
        if (items.length === 0) {
          // Even valid strings can expand sixfold when JSON escapes controls.
          // A tiny explicit projection guarantees forward progress; originals
          // stay available by run/record ID and are never rewritten.
          const compact: JsonObject = { projection_truncated: true };
          for (const field of ["id", "project_id", "key", "name", "goal", "title", "branch", "state", "actor", "activity", "repository", "environment", "created_at", "updated_at"]) {
            const value = item[field];
            if (typeof value === "string") compact[field] = Array.from(value).slice(0, field === "goal" ? 200 : 100).join("");
          }
          for (const field of ["total", "unfinished", "components_total", "features_total"]) if (typeof item[field] === "number") compact[field] = item[field];
          const firstReason = Array.isArray(item["match_reasons"]) ? item["match_reasons"][0] : undefined;
          if (firstReason && typeof firstReason === "object" && !Array.isArray(firstReason)) {
            const reason: JsonObject = {};
            for (const field of ["kind", "label", "value", "feature_key", "feature_name", "source_run_id"]) {
              const value = firstReason[field];
              if (typeof value === "string") reason[field] = Array.from(value).slice(0, 100).join("");
            }
            compact["match_reasons"] = [reason];
            compact["match_reasons_truncated"] = true;
          }
          if (view === "tasks") { compact["components"] = []; compact["features"] = []; compact["links_truncated"] = true; }
          items.push(compact);
        }
        break;
      }
    }
    if (rows.length > items.length) response["next_offset"] = offset + items.length;
    return response;
  }
}

/** Called only inside the same transaction as the run/record/receipt. */
export function writeWork(db: DatabaseSync, projectId: string, input: WorkMutation): void {
  for (const component of input.components ?? []) {
    const existing = db.prepare("SELECT name FROM components WHERE project_id=? AND key=?").get(projectId, component.key);
    if (existing && existing["name"] !== component.name) throw new MemoryError("catalog_conflict", "Component key already has another name.");
    db.prepare("INSERT INTO components VALUES (?,?,?) ON CONFLICT DO NOTHING").run(projectId, component.key, component.name);
    if (input.run_id) db.prepare("INSERT INTO run_components VALUES (?,?,?) ON CONFLICT DO NOTHING").run(projectId, input.run_id, component.key);
  }
  for (const feature of input.features ?? []) {
    const existing = db.prepare("SELECT name, description FROM features WHERE project_id=? AND key=?").get(projectId, feature.key);
    if (existing && (existing["name"] !== feature.name || (feature.description && existing["description"] !== feature.description))) {
      throw new MemoryError("catalog_conflict", "Feature key already has another definition.");
    }
    db.prepare("INSERT INTO features VALUES (?,?,?,?) ON CONFLICT DO NOTHING").run(projectId, feature.key, feature.name, feature.description ?? "");
    writeFeatureDiscovery(db,projectId,input.run_id,feature);
    if (input.run_id) db.prepare("INSERT INTO run_features VALUES (?,?,?) ON CONFLICT DO NOTHING").run(projectId, input.run_id, feature.key);
  }
  if (input.run_id && (input.title || input.branch)) {
    db.prepare("INSERT INTO run_details VALUES (?,?,?,?) ON CONFLICT DO NOTHING").run(projectId, input.run_id, input.title ?? null, input.branch ?? null);
  }
  if (input.record_id && input.report) {
    for (const update of input.report.feature_updates ?? []) {
      if (!db.prepare("SELECT 1 FROM run_features WHERE project_id=? AND run_id=? AND feature_key=?").get(projectId, input.run_id ?? "", update.key)) {
        throw new MemoryError("scope_mismatch", "Feature update must refer to a feature linked to this task.");
      }
    }
    db.prepare("INSERT INTO record_reports VALUES (?,?,?)").run(projectId, input.record_id, JSON.stringify(input.report));
  }
}
