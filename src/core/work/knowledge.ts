import { compareExecutionSource, type SourceObservation } from "../execution/currentness.js";
import type { TestDetails } from "../execution/test-details.js";

export type KnowledgeObservation = {
  id: string; run_id: string; record_id: string | null; repository: string; environment: string;
  command_hash: string; outcome: string; exit_code: number | null; output_complete: number;
  before?: SourceObservation; after?: SourceObservation; current?: SourceObservation;
  test_details: TestDetails;
};

/** Read-time compatibility of observed checks, never a verdict on feature correctness. */
export function assessFeatureKnowledge(observations: KnowledgeObservation[], truncated = false) {
  const evidence = observations.map(row => {
    const comparison = compareExecutionSource(row.before, row.after, row.current);
    const details = row.test_details;
    let result: "passed" | "failed" | "unknown" = "unknown";
    if (row.outcome === "exited" && row.output_complete === 1 && details.status === "collected"
      && details.counts.tests > 0 && details.counts.cancelled === 0 && details.counts.todo === 0) {
      if (row.exit_code === 0 && details.suite_success && details.counts.passed > 0 && details.counts.failed === 0) result = "passed";
      else if (row.exit_code !== null && row.exit_code !== 0 && !details.suite_success && details.counts.failed > 0) result = "failed";
    }
    const uncertainSource = [row.before, row.after, row.current].some(source => source && source.status !== "clean");
    const status: "current" | "stale" | "unknown" = result === "unknown" || uncertainSource ? "unknown"
      : comparison.status === "changed" ? "stale" : comparison.status === "same_version" ? "current" : "unknown";
    return { execution_id: row.id, run_id: row.run_id, record_id: row.record_id,
      repository: row.repository, environment: row.environment, command_hash: row.command_hash,
      commit: row.before?.commit ?? null, current_commit: row.current?.commit ?? null, root_hash: row.before?.root_hash ?? null,
      status, result, reason: result === "unknown" ? "test_verdict_unavailable" : uncertainSource ? "source_not_clean" : comparison.reason,
      counts: details.status === "collected" ? details.counts : null,
      comparison, claims_verified: false };
  });
  const groups = new Map<string, typeof evidence>();
  for (const row of evidence.filter(x => x.status === "current")) {
    const key = JSON.stringify([row.repository, row.environment, row.root_hash, row.commit, row.command_hash]);
    const group = groups.get(key) ?? []; group.push(row); groups.set(key, group);
  }
  const conflicts = [...groups.values()].filter(group => group.some(x => x.result === "passed") && group.some(x => x.result === "failed"))
    .map(group => ({ execution_ids: group.map(x => x.execution_id), command_hash: group[0]!.command_hash,
      repository: group[0]!.repository, environment: group[0]!.environment, commit: group[0]!.commit,
      reason: "opposing_test_observations_same_command_and_version" }));
  const counts = { current: 0, stale: 0, unknown: 0, passed: 0, failed: 0 };
  for (const row of evidence) { counts[row.status]++; if (row.status === "current" && row.result !== "unknown") counts[row.result]++; }
  // A bounded window cannot rule out omitted conflicts. Never promote a partial read.
  const status = conflicts.length ? "conflict" : truncated || counts.unknown ? "unknown"
    : counts.current ? "current" : counts.stale ? "stale" : "unknown";
  const reason = conflicts.length ? "opposing_test_observations" : truncated ? "observation_limit_exceeded"
    : counts.unknown ? "incomparable_observations" : counts.current ? "compatible_test_observations"
      : counts.stale ? "source_version_changed" : "no_direct_test_observations";
  return { status, reason, counts, conflicts, evidence, truncated, claims_verified: false,
    meaning: "Current means comparable direct test observations at the configured Git version, not verified feature correctness.",
    coverage: "explicit_runner_only", dependencies_and_runtime_verified: false, ignored_files_observed: false,
    agent_reports_promoted: false };
}
