import type { DatabaseSync } from "node:sqlite";
import { executionSourceRowSchema, executionWorktreeRowSchema, sourceObservationSchema, worktreeFingerprintSchema, type SourceObservation } from "../../../core/execution/currentness.js";

/** Fingerprints are separate from the legacy JSON so already-running readers keep working. */
export function readExecutionSources(db: DatabaseSync, projectId: string, executionId: string): {before?: SourceObservation; after?: SourceObservation} {
  const row = db.prepare("SELECT * FROM execution_sources WHERE execution_id=? AND project_id=?").get(executionId, projectId);
  if (!row) return {};
  const parsed = executionSourceRowSchema.parse(row);
  const version = Number(db.prepare("PRAGMA user_version").get()?.["user_version"]);
  const stored = version >= 12 ? db.prepare("SELECT * FROM execution_worktrees WHERE execution_id=? AND project_id=?").get(executionId, projectId) : undefined;
  const fingerprints = stored ? executionWorktreeRowSchema.parse(stored) : undefined;
  const before = sourceObservationSchema.parse(JSON.parse(parsed.before_json));
  const after = parsed.after_json ? sourceObservationSchema.parse(JSON.parse(parsed.after_json)) : undefined;
  return { before: fingerprints?.before_json ? { ...before, worktree: worktreeFingerprintSchema.parse(JSON.parse(fingerprints.before_json)) } : before,
    ...(after ? { after: fingerprints?.after_json ? { ...after, worktree: worktreeFingerprintSchema.parse(JSON.parse(fingerprints.after_json)) } : after } : {}) };
}
