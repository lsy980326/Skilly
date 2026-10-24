import { z } from "zod";
import { skillKey } from "./model.js";
import type { JsonObject, Run } from "../memory/model.js";

/** A declared use of an immutable catalog version; never proof of model loading. */
export const skillUsageSchema = z.strictObject({
  skill_key: skillKey, version: z.string().min(1).max(80),
  purpose: z.string().trim().min(1).max(500), observation_id: z.uuid().optional(),
});
export const skillUsagesSchema = z.array(skillUsageSchema).min(1).max(8).refine(
  rows => new Set(rows.map(row => JSON.stringify([row.skill_key, row.version]))).size === rows.length,
  "Report each skill/version once per checkpoint.",
);
export type SkillUsage = z.infer<typeof skillUsageSchema>;
export const taskSkillUsageRowSchema = skillUsageSchema.omit({ observation_id: true }).extend({
  project_id: z.uuid(), record_id: z.uuid(), run_id: z.uuid(),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/), observation_id: z.uuid().nullable(),
});
export type TaskSkillUsageRow = z.infer<typeof taskSkillUsageRowSchema>;
export interface SkillUsageReader {
  prepare(run: Run, inputs: SkillUsage[], root?: string): Omit<TaskSkillUsageRow, "record_id">[];
  list(projectId: string, runId: string, offset: number, recordId?: string): JsonObject;
}
