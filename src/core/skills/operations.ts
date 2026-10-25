import { z } from "zod";
import { skillKey } from "./schema.js";
import { skillUsagesSchema } from "./usage.js";
import { reportSchema } from "../work/schema.js";
const key=z.string().min(1).max(128);
export const assignSkillSchema=z.strictObject({skill_key:skillKey,version:z.string().min(1).max(80),tool:z.enum(["codex","cursor"]),
  folder:skillKey,expected_assignment_id:z.uuid().nullable(),idempotency_key:key});
export const inspectSkillSchema=z.strictObject({installation_id:z.uuid(),idempotency_key:key});
export const skillCheckpointSchema=z.strictObject({run_id:z.uuid(),topic:z.string().min(1).max(160),
  kind:z.enum(["note","decision","change","issue","summary"]),body:z.string().min(1).max(48000),
  report_origin:z.enum(["unspecified","contemporaneous","retrospective"]).default("contemporaneous"),
  supersedes:z.uuid().optional(),report:reportSchema.optional(),skill_usage:skillUsagesSchema,idempotency_key:key});
