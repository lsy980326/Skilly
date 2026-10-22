import type { DatabaseSync } from "node:sqlite";
import type { OverviewQuery } from "../../../core/work/model.js";
import { assessFeatureKnowledge, type KnowledgeObservation } from "../../../core/work/knowledge.js";
import { executionSourceRowSchema, sourceObservationSchema, type SourceProvider, type SourceObservation } from "../../../core/execution/currentness.js";
import { testDetailsRowSchema, type TestDetails } from "../../../core/execution/test-details.js";
import { featureScope } from "./feature-status.js";

const LIMIT = 40;
/** Bounded, scoped projection. Never follows paths from stored reports or writes derived state. */
export function featureKnowledge(db: DatabaseSync, input: OverviewQuery, key: string, sources?: SourceProvider) {
  const version = Number(db.prepare("PRAGMA user_version").get()?.["user_version"]);
  if (version < 6) return { ...assessFeatureKnowledge([]), scanned: 0, limit: LIMIT };
  const { filters, params } = featureScope(input, key);
  const rows = db.prepare(`SELECT e.*,r.repository,r.environment FROM executions e
    JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id
    JOIN run_features x ON x.project_id=r.project_id AND x.run_id=r.id
    WHERE ${filters.join(" AND ")} ORDER BY e.started_at DESC,e.id DESC LIMIT ?`).all(...params, LIMIT + 1);
  const current = new Map<string, SourceObservation | undefined>();
  const observations: KnowledgeObservation[] = rows.slice(0, LIMIT).map(row => {
    const source = version >= 8 ? db.prepare("SELECT * FROM execution_sources WHERE execution_id=? AND project_id=?").get(row["id"]!, input.project_id) : undefined;
    const parsed = source ? executionSourceRowSchema.parse(source) : undefined;
    const before = parsed ? sourceObservationSchema.parse(JSON.parse(parsed.before_json)) : undefined;
    const after = parsed?.after_json ? sourceObservationSchema.parse(JSON.parse(parsed.after_json)) : undefined;
    const cacheKey = before ? JSON.stringify([before.root_hash,before.project_key,before.repository,before.environment]) : "";
    if (before && !current.has(cacheKey)) current.set(cacheKey, sources?.(before));
    const details = version >= 7 ? db.prepare("SELECT * FROM execution_test_details WHERE execution_id=? AND project_id=?").get(row["id"]!, input.project_id) : undefined;
    const testDetails: TestDetails = details ? JSON.parse(testDetailsRowSchema.parse(details).details_json) as TestDetails
      : { status: "not_collected", reason: "legacy" };
    return { id: String(row["id"]), run_id: String(row["run_id"]), record_id: row["record_id"] === null ? null : String(row["record_id"]),
      repository: String(row["repository"]), environment: String(row["environment"]), command_hash: String(row["command_hash"]),
      outcome: String(row["outcome"]), exit_code: row["exit_code"] === null ? null : Number(row["exit_code"]), output_complete: Number(row["output_complete"]),
      ...(before ? { before } : {}), ...(after ? { after } : {}), ...(current.get(cacheKey) ? { current: current.get(cacheKey)! } : {}), test_details: testDetails };
  });
  const assessment = assessFeatureKnowledge(observations, rows.length > LIMIT);
  return { ...assessment, evidence: assessment.evidence.slice(0, 8), evidence_truncated: assessment.evidence.length > 8,
    conflicts: assessment.conflicts.slice(0, 8).map(group => ({ ...group, execution_ids: group.execution_ids.slice(0, 8),
      ids_truncated: group.execution_ids.length > 8 })), conflicts_truncated: assessment.conflicts.length > 8,
    scanned: observations.length, limit: LIMIT };
}
