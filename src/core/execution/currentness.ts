import { z } from "zod";

export const sourceObservationSchema = z.strictObject({
  version: z.literal(1), root_hash: z.string().regex(/^[a-f0-9]{64}$/),
  project_key: z.string().min(1).max(80), repository: z.string().min(1).max(100), environment: z.string().min(1).max(100),
  observed_at: z.iso.datetime(), status: z.enum(["clean", "dirty", "unavailable"]),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  reason: z.enum(["working_tree_changed", "git_unavailable", "not_repository_root", "index_entries_unobserved"]).nullable(),
}).refine(x => x.status === "clean" ? x.commit !== null && x.reason === null
  : x.status === "dirty" ? x.commit !== null && x.reason === "working_tree_changed"
    : x.commit === null && x.reason !== null, "Inconsistent source observation.");
export type SourceObservation = z.infer<typeof sourceObservationSchema>;
export const executionSourceRowSchema = z.strictObject({ execution_id: z.uuid(), project_id: z.uuid(),
  before_json: z.string().max(2048), after_json: z.string().max(2048).nullable() }).superRefine((row, ctx) => {
  for (const value of [row.before_json, row.after_json]) {
    if (value === null) continue;
    try { if (sourceObservationSchema.safeParse(JSON.parse(value)).success) continue; } catch { /* invalid stored data */ }
    ctx.addIssue({ code: "custom", message: "Invalid source observation." });
  }
});
export type SourceProvider = (recorded: SourceObservation) => SourceObservation | undefined;

/** Version compatibility only. Never promotes agent reports or test outcomes to verified facts. */
export function compareExecutionSource(before?: SourceObservation, after?: SourceObservation, current?: SourceObservation) {
  const base = { claims_verified: false, scope: "git_commit_and_nonignored_worktree", checked_at: current?.observed_at ?? null,
    dependencies_and_runtime_verified: false, ignored_files_observed: false };
  const result = (status: "same_version" | "changed" | "unknown", reason: string) => ({ ...base, status, reason });
  if (!before) return result("unknown", "legacy_not_collected");
  if (!after) return result("unknown", "execution_unfinished");
  if ([before, after].some(x => x.status === "unavailable")) return result("unknown", "source_unavailable");
  if (before.root_hash !== after.root_hash || before.project_key !== after.project_key || before.repository !== after.repository || before.environment !== after.environment)
    return result("unknown", "execution_scope_mismatch");
  if (before.commit !== after.commit) return result("changed", "changed_during_execution");
  if (before.status !== "clean" || after.status !== "clean") return result("unknown", "uncommitted_changes");
  if (!current) return result("unknown", "comparison_root_not_configured");
  if (current.root_hash !== before.root_hash || current.project_key !== before.project_key || current.repository !== before.repository || current.environment !== before.environment)
    return result("unknown", "comparison_scope_mismatch");
  if (current.status === "unavailable") return result("unknown", "source_unavailable");
  if (current.commit !== before.commit) return result("changed", "different_commit");
  if (current.status !== "clean") return result("unknown", "uncommitted_changes");
  return result("same_version", "matching_clean_observations");
}
