import { z } from "zod";
import type { JsonObject } from "../memory/model.js";

export interface ExecutionReader { list(projectId: string, runId: string, offset?: number, recordId?: string): JsonObject; }

// Facts about a directly launched process, never a verdict on the supplied task.
export const executionRowSchema = z.strictObject({
  id: z.uuid(), project_id: z.uuid(), run_id: z.uuid(), record_id: z.uuid().nullable(),
  source: z.literal("local_runner"), executable: z.string().min(1).max(80), command_hash: z.string().regex(/^[a-f0-9]{64}$/),
  started_at: z.iso.datetime(), ended_at: z.iso.datetime().nullable(), duration_ms: z.number().int().nonnegative().nullable(),
  outcome: z.enum(["unconfirmed", "exited", "launch_failed", "timed_out", "interrupted"]),
  exit_code: z.number().int().nullable(), signal: z.string().nullable(), error_code: z.string().nullable(),
  stdout_bytes: z.number().int().nonnegative(), stderr_bytes: z.number().int().nonnegative(),
  stdout_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), stderr_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  stdout_hashed_bytes: z.number().int().nonnegative(), stderr_hashed_bytes: z.number().int().nonnegative(),
  output_complete: z.union([z.literal(0), z.literal(1)]),
}).superRefine((row, context) => {
  if ((row.outcome === "unconfirmed") !== (row.ended_at === null)
    || (row.ended_at === null) !== (row.duration_ms === null)
    || row.stdout_hashed_bytes > row.stdout_bytes || row.stderr_hashed_bytes > row.stderr_bytes
    || row.stdout_hashed_bytes > 1024 * 1024 || row.stderr_hashed_bytes > 1024 * 1024) {
    context.addIssue({ code: "custom", message: "Inconsistent process observation." });
  }
});
export type ExecutionRow = z.infer<typeof executionRowSchema>;
export function executionProjection(row: ExecutionRow) {
  return { ...row, provenance: "local_runner", claims_verified: false,
    meaning: "Direct process observation, not proof of task correctness or current code state.",
    content_stored: false, authenticity: "local_observation_not_attestation" };
}
