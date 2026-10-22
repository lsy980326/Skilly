import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { Feature, OverviewQuery } from "../../../core/work/model.js";
import { MemoryError } from "../../../core/memory/model.js";
import { normalizeAlias, normalizeCodePath, pathMatches } from "../../../core/work/discovery.js";
import { featureAlias, featureCodePath } from "../../../core/work/schema.js";

type Reason = { kind: string; label: string; value: string; feature_key?: string; feature_name?: string; repository?: string; environment?: string; source_run_id?: string };
export const contains = (sql: string) => `instr(lower(${sql}),lower(?))>0`;
const pathPredicate = (column: string) => `(instr('/'||lower(${column})||'/','/'||lower(?)||'/')>0 OR substr(lower(?),1,length(${column})+1)=lower(${column})||'/')`;

export class FeatureDiscovery {
  constructor(private readonly db: DatabaseSync, private readonly version: number) {}
  private scope(alias: string, input: OverviewQuery, task = false) {
    const sql: string[] = [], params: SQLInputValue[] = [];
    for (const field of ["repository", "environment"] as const) {
      if (task) sql.push(`${alias}.${field}=r.${field}`);
      else if (input[field]) { sql.push(`${alias}.${field}=?`); params.push(input[field]); }
    }
    return { sql: sql.length ? " AND " + sql.join(" AND ") : "", params };
  }
  predicate(featureAlias: string, input: OverviewQuery, task = false) {
    const q = input.query ?? "", clauses = [contains(`${featureAlias}.name`), contains(`${featureAlias}.key`), contains(`${featureAlias}.description`)];
    const params: SQLInputValue[] = [q, q, q];
    if (this.version >= 10) {
      const alias = this.scope("a", input, task), path = this.scope("p", input, task), normalized = normalizeCodePath(q);
      clauses.push(`EXISTS (SELECT 1 FROM feature_aliases a WHERE a.project_id=${featureAlias}.project_id AND a.feature_key=${featureAlias}.key${alias.sql} AND instr(a.normalized_alias,?)>0)`);
      params.push(...alias.params, normalizeAlias(q));
      if (normalized) {
        clauses.push(`EXISTS (SELECT 1 FROM feature_code_paths p WHERE p.project_id=${featureAlias}.project_id AND p.feature_key=${featureAlias}.key${path.sql} AND ${pathPredicate("p.path")})`);
        params.push(...path.params, normalized, normalized);
      }
    }
    return { sql: `(${clauses.join(" OR ")})`, params };
  }
  metadata(projectId: string, featureKey: string, input: OverviewQuery, matchingOnly = false) {
    const result: Record<string, unknown> = { aliases: [], code_paths: [], truncated: false, provenance: "explicit_feature_metadata", file_access: "not_performed" };
    if (this.version < 10) return { ...result, schema_supported: false };
    const q = input.query ?? "", normalized = normalizeCodePath(q);
    for (const [table, field, key] of [["feature_aliases", "alias", "aliases"], ["feature_code_paths", "path", "code_paths"]] as const) {
      const scope = this.scope("m", input), params: SQLInputValue[] = [projectId, featureKey, ...scope.params];
      let match = "";
      if (matchingOnly) {
        if (key === "aliases") { match = " AND instr(m.normalized_alias,?)>0"; params.push(normalizeAlias(q)); }
        else if (normalized) { match = ` AND ${pathPredicate("m.path")}`; params.push(normalized, normalized); }
        else continue;
      }
      const rows = this.db.prepare(`SELECT ${field} AS value,repository,environment,source_run_id FROM ${table} m
        WHERE m.project_id=? AND m.feature_key=?${scope.sql}${match} ORDER BY ${field},repository,environment LIMIT 9`).all(...params);
      result[key] = rows.slice(0,8);
      if (rows.length > 8) result["truncated"] = true;
    }
    return result;
  }
  reasons(feature: { key: string; name: string; description?: string }, input: OverviewQuery): Reason[] {
    const q = input.query ?? "";
    if (!q) return [];
    const result: Reason[] = [], base = { feature_key: feature.key, feature_name: feature.name };
    for (const [kind, label, value] of [["feature_name", "기능 이름", feature.name], ["feature_key", "기능 ID", feature.key], ["feature_description", "기능 설명", feature.description ?? ""]] as const) {
      if (value.toLowerCase().includes(q.toLowerCase())) result.push({ kind, label, value, ...base });
    }
    const metadata = this.metadata(input.project_id, feature.key, input, true);
    for (const key of ["aliases", "code_paths"]) for (const row of metadata[key] as { value: string; repository: string; environment: string; source_run_id: string }[]) {
      // Keep reason semantics identical to the SQL search boundary.
      if (key === "code_paths" && !pathMatches(row.value,q)) continue;
      result.push({ kind: key === "aliases" ? "feature_alias" : "code_path", label: key === "aliases" ? "등록된 기능 별칭" : "등록된 코드 경로", ...row, ...base });
    }
    return result.slice(0,8);
  }
}

/** Only called inside the existing run/report/receipt transaction. No historical inference. */
export function writeFeatureDiscovery(db: DatabaseSync, projectId: string, runId: string | undefined, feature: Feature) {
  if (!feature.aliases?.length && !feature.code_paths?.length) return;
  const run = runId ? db.prepare("SELECT repository,environment FROM runs WHERE project_id=? AND id=?").get(projectId,runId) : undefined;
  if (!run) throw new MemoryError("scope_mismatch", "Feature discovery metadata requires its own saved task.");
  for (const alias of feature.aliases ?? []) db.prepare("INSERT INTO feature_aliases VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING")
    .run(projectId, feature.key, run["repository"]!, run["environment"]!, alias, normalizeAlias(alias), runId!);
  for (const declared of feature.code_paths ?? []) {
    const path=normalizeCodePath(declared);
    if(path===null)throw new MemoryError("invalid_input","Use a public repository-relative code path.");
    db.prepare("INSERT INTO feature_code_paths VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING")
      .run(projectId, feature.key, run["repository"]!, run["environment"]!, path, runId!);
  }
  for (const table of ["feature_aliases", "feature_code_paths"]) {
    const count = Number(db.prepare(`SELECT count(*) AS n FROM ${table} WHERE project_id=? AND feature_key=? AND repository=? AND environment=?`)
      .get(projectId,feature.key,run["repository"]!,run["environment"]!)?.["n"]);
    if (count > 64) throw new MemoryError("invalid_input", "At most 64 aliases and code paths per feature scope.");
  }
}

export function validateFeatureDiscoveryData(db: DatabaseSync) {
  for (const table of ["feature_aliases","feature_code_paths"]) {
    for (const row of db.prepare(`SELECT m.*,r.repository AS run_repository,r.environment AS run_environment,x.feature_key AS linked_feature FROM ${table} m
      JOIN runs r ON r.project_id=m.project_id AND r.id=m.source_run_id
      LEFT JOIN run_features x ON x.project_id=m.project_id AND x.run_id=m.source_run_id AND x.feature_key=m.feature_key`).iterate()) {
      if (row["repository"]!==row["run_repository"]||row["environment"]!==row["run_environment"]
        || row["linked_feature"]!==row["feature_key"]
        || (table==="feature_aliases" ? !featureAlias.safeParse(row["alias"]).success || normalizeAlias(String(row["alias"]))!==row["normalized_alias"]
          : !featureCodePath.safeParse(row["path"]).success || normalizeCodePath(String(row["path"]))!==row["path"]))
        throw new MemoryError("invalid_data","Feature discovery metadata is inconsistent with its declared source scope.");
    }
    if(db.prepare(`SELECT 1 FROM ${table} GROUP BY project_id,feature_key,repository,environment HAVING count(*)>64 LIMIT 1`).get())
      throw new MemoryError("invalid_data","Feature discovery metadata exceeds the scope limit.");
  }
}
