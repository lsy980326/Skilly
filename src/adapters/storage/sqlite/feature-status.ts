import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { OverviewQuery } from "../../../core/work/model.js";
import { parseJsonObject } from "../../../core/memory/model.js";

/** Latest task report is context, not an inferred feature state or verified fact. */
function featureScope(input: OverviewQuery, featureKey: string) {
  const filters = ["r.project_id = ?", "x.feature_key = ?"], params: SQLInputValue[] = [input.project_id, featureKey];
  for (const field of ["repository", "environment"] as const) {
    if (input[field]) { filters.push(`r.${field} = ?`); params.push(input[field]); }
  }
  if (input.feature) {
    filters.push("EXISTS (SELECT 1 FROM run_features selected WHERE selected.project_id=r.project_id AND selected.run_id=r.id AND selected.feature_key=?)");
    params.push(input.feature);
  }
  if (input.component === "unclassified") filters.push("NOT EXISTS (SELECT 1 FROM run_components c WHERE c.project_id=r.project_id AND c.run_id=r.id)");
  else if (input.component) {
    filters.push("EXISTS (SELECT 1 FROM run_components c WHERE c.project_id=r.project_id AND c.run_id=r.id AND c.component_key=?)");
    params.push(input.component);
  }
  return { filters, params };
}

export function featureExecutions(db: DatabaseSync, input: OverviewQuery, featureKey: string) {
  if (Number(db.prepare("PRAGMA user_version").get()?.["user_version"]) < 6) return { status: "not_collected", verified: false };
  const { filters, params } = featureScope(input, featureKey);
  const row = db.prepare(`SELECT count(*) AS total, coalesce(sum(e.outcome='unconfirmed'),0) AS unconfirmed
    FROM executions e JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id
    JOIN run_features x ON x.project_id=r.project_id AND x.run_id=r.id WHERE ${filters.join(" AND ")}`).get(...params);
  if (!Number(row?.["total"])) return { status: "not_collected", verified: false };
  return { status: Number(row?.["total"]) ? "observations_available" : "not_collected", total: Number(row?.["total"]),
    unconfirmed: Number(row?.["unconfirmed"]), verified: false, coverage: "explicit_runner_only" };
}

export function featureActivity(db: DatabaseSync, input: OverviewQuery, featureKey: string) {
  const { filters, params } = featureScope(input, featureKey);
  const row = db.prepare(`SELECT e.id AS record_id, e.run_id, e.observed_at, e.recorded_at,
    e.repository, e.environment, e.report_origin, e.source_fingerprint, p.report_json, a.actor
    FROM runs r JOIN run_features x ON x.project_id=r.project_id AND x.run_id=r.id
    JOIN records e ON e.project_id=r.project_id AND e.run_id=r.id
    JOIN record_reports p ON p.project_id=e.project_id AND p.record_id=e.id
    LEFT JOIN run_actors a ON a.run_id=r.id
    WHERE ${filters.join(" AND ")} AND e.superseded_by IS NULL AND e.report_origin='contemporaneous'
    ORDER BY e.observed_at DESC, e.seq DESC LIMIT 1`).get(...params);
  if (!row) return null;
  const full = parseJsonObject(String(row["report_json"]));
  // Preserve bounded human fields. Technical originals stay available by record/run ID.
  const report = Object.fromEntries(["title", "summary", "changes", "checks", "limitations", "next_steps"]
    .filter(key => full[key] !== undefined).map(key => [key, full[key]]));
  return { ...row, report_json: undefined, report, provenance: "agent_report", verified: false };
}
