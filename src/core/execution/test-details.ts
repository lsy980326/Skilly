import { z } from "zod";

const count = z.number().int().nonnegative().safe();
export const testDetailsSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("collected"), framework: z.enum(["node_test", "vitest"]),
    counts: z.strictObject({ tests: count, passed: count, failed: count, cancelled: count, skipped: count, todo: count, suites: count }),
    suite_success: z.boolean(), failures: z.array(z.string().max(200)).max(20), failures_truncated: z.boolean(),
  }).refine(value => value.counts.tests === value.counts.passed + value.counts.failed + value.counts.cancelled + value.counts.skipped + value.counts.todo,
    "Inconsistent test counts."),
  z.strictObject({ status: z.literal("not_collected"), reason: z.enum(["unsupported_command", "legacy", "unfinished", "missing_summary", "interrupted", "invalid_report", "limit_exceeded"]) }),
]);
export type TestDetails = z.infer<typeof testDetailsSchema>;
export const testDetailsRowSchema = z.strictObject({ execution_id: z.uuid(), project_id: z.uuid(),
  details_json: z.string().max(16384).superRefine((value, context) => {
    try { if (testDetailsSchema.safeParse(JSON.parse(value)).success) return; } catch { /* Invalid input, never execute it. */ }
    context.addIssue({ code: "custom", message: "Invalid test observation." });
  }),
});
