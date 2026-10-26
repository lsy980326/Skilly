import { z } from "zod";

export const worktreeFingerprintSchema = z.discriminatedUnion("status", [
  z.strictObject({ policy: z.literal("public_source_v1"), status: z.literal("collected"), sha256: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.int().min(0).max(2048), bytes: z.int().min(0).max(16 * 1024 * 1024), excluded: z.int().min(0).max(2048),
    excluded_changes: z.int().min(0).max(2048).default(0) }),
  z.strictObject({ policy: z.literal("public_source_v1"), status: z.literal("unavailable"),
    reason: z.enum(["limit_exceeded", "inventory_limit_exceeded", "excluded_changes", "unsafe_entry", "unstable", "read_failed"]) }),
]);
export type WorktreeFingerprint = z.infer<typeof worktreeFingerprintSchema>;
export const executionWorktreeRowSchema = z.strictObject({ execution_id: z.uuid(), project_id: z.uuid(),
  before_json: z.string().max(1024).nullable(), after_json: z.string().max(1024).nullable() }).superRefine((row, ctx) => {
  if (row.before_json === null && row.after_json === null) ctx.addIssue({ code: "custom", message: "Empty fingerprints." });
  for (const value of [row.before_json, row.after_json]) {
    if (value === null) continue;
    try { if (worktreeFingerprintSchema.safeParse(JSON.parse(value)).success) continue; } catch { /* invalid stored data */ }
    ctx.addIssue({ code: "custom", message: "Invalid fingerprint." });
  }
});
export const sourceObservationSchema = z.strictObject({
  version: z.literal(1), root_hash: z.string().regex(/^[a-f0-9]{64}$/),
  project_key: z.string().min(1).max(80), repository: z.string().min(1).max(100), environment: z.string().min(1).max(100),
  observed_at: z.iso.datetime(), status: z.enum(["clean", "dirty", "unavailable"]),
  commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  reason: z.enum(["working_tree_changed", "git_unavailable", "not_repository_root", "index_entries_unobserved"]).nullable(),
  worktree: worktreeFingerprintSchema.optional(),
}).refine(x => x.status === "clean" ? x.commit !== null && x.reason === null
  : x.status === "dirty" ? x.commit !== null && x.reason === "working_tree_changed"
    : x.commit === null && x.reason !== null, "Inconsistent source observation.");
export type SourceObservation = z.infer<typeof sourceObservationSchema>;
export function sourceProjection(observation?: SourceObservation) {
  if (!observation) return null;
  const { worktree, ...metadata } = observation;
  return worktree ? { ...metadata, worktree } : metadata;
}
export const executionSourceRowSchema = z.strictObject({ execution_id: z.uuid(), project_id: z.uuid(),
  before_json: z.string().max(2048), after_json: z.string().max(2048).nullable() }).superRefine((row, ctx) => {
  for (const value of [row.before_json, row.after_json]) {
    if (value === null) continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !("worktree" in parsed) && sourceObservationSchema.safeParse(parsed).success) continue;
    } catch { /* invalid stored data */ }
    ctx.addIssue({ code: "custom", message: "Invalid source observation." });
  }
});
export type SourceProvider = (recorded: SourceObservation) => SourceObservation | undefined;

/** Version compatibility only. Never promotes agent reports or test outcomes to verified facts. */
export function compareExecutionSource(before?: SourceObservation, after?: SourceObservation, current?: SourceObservation) {
  const base = { claims_verified: false, scope: "git_commit_and_nonignored_worktree", checked_at: current?.observed_at ?? null,
    dependencies_and_runtime_verified: false, ignored_files_observed: false };
  const result = (status: "same_version" | "changed" | "unknown", reason: string, scope = base.scope) => ({ ...base, scope, status, reason });
  if (!before) return result("unknown", "legacy_not_collected");
  if (!after) return result("unknown", "execution_unfinished");
  if ([before, after].some(x => x.status === "unavailable")) return result("unknown", "source_unavailable");
  if (before.root_hash !== after.root_hash || before.project_key !== after.project_key || before.repository !== after.repository || before.environment !== after.environment)
    return result("unknown", "execution_scope_mismatch");
  if (before.commit !== after.commit) return result("changed", "changed_during_execution");
  const fingerprints = [before.worktree, after.worktree, current?.worktree];
  const excludedChanges = {
    before: before.worktree?.status === "collected" ? before.worktree.excluded_changes ?? 0 : null,
    after: after.worktree?.status === "collected" ? after.worktree.excluded_changes ?? 0 : null,
    current: current?.worktree?.status === "collected" ? current.worktree.excluded_changes ?? 0 : null,
    contents_observed: false,
  };
  if (before.worktree?.status === "collected" && after.worktree?.status === "collected"
    && before.worktree.sha256 !== after.worktree.sha256) return {
      ...result("changed", "source_changed_during_execution", "bounded_public_source_v1"),
      public_source: { status: "changed", reason: "source_changed_during_execution" }, excluded_changes: excludedChanges,
    };
  if (!current) return result("unknown", "comparison_root_not_configured");
  if (current.root_hash !== before.root_hash || current.project_key !== before.project_key || current.repository !== before.repository || current.environment !== before.environment)
    return result("unknown", "comparison_scope_mismatch");
  if (current.status === "unavailable") return result("unknown", "source_unavailable");
  if (current.commit !== before.commit) return result("changed", "different_commit");
  const unavailable = fingerprints.find(x => x?.status === "unavailable");
  if (unavailable?.status === "unavailable") return result("unknown", `fingerprint_${unavailable.reason}`);
  if (fingerprints.every(x => x?.status === "collected")) {
    const [first, , now] = fingerprints;
    if (first?.status === "collected" && now?.status === "collected") {
      const same = first.sha256 === now.sha256;
      const excluded = [excludedChanges.before, excludedChanges.after, excludedChanges.current].some(n => n !== null && n > 0);
      // A partial match is useful context, never proof that excluded configuration is unchanged.
      return {
        ...result(same ? excluded ? "unknown" : "same_version" : "changed",
          same ? excluded ? "fingerprint_excluded_changes" : "matching_source_fingerprints" : "source_fingerprint_changed"),
        scope: "bounded_public_source_v1", excluded_files_observed: false,
        public_source: { status: same ? "same_version" : "changed", reason: same ? "matching_source_fingerprints" : "source_fingerprint_changed" },
        excluded_changes: excludedChanges,
      };
    }
  }
  // Legacy clean metadata keeps its old semantics. Never invent fingerprints for old dirty rows.
  if ([before, after, current].some(x => x.status !== "clean")) {
    return result("unknown", "uncommitted_changes");
  }
  return result("same_version", "matching_clean_observations");
}
