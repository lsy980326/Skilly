import { z } from 'zod';
import { MemoryError } from '../../../core/memory/model.js';

const count = z.int().min(1).max(1_000_000_000);
export const usageResources = z.strictObject({ requests: count, batches: count, rows_read: count, rows_written: count });
export const usagePolicySchema = z.strictObject({
 daily: usageResources, user_daily: usageResources,
 request: usageResources.omit({ requests: true }).extend({ statements: z.int().min(1).max(256) }),
 accepted_write_bytes: count,
}).refine(p => (['batches', 'rows_read', 'rows_written'] as const).every(k => p.request[k] <= p.daily[k] && p.request[k] <= p.user_daily[k]),
 'A request reservation must fit both daily budgets.');
export type UsagePolicy = z.infer<typeof usagePolicySchema>;
export type Usage = z.infer<typeof usageResources>;
export const usageKeys = ['requests', 'batches', 'rows_read', 'rows_written'] as const;
export const zeroUsage = (): Usage => ({ requests: 0, batches: 0, rows_read: 0, rows_written: 0 });
export const usageDay = (now: number) => Math.floor(now / 86_400_000);
export class UsageLimit extends MemoryError {
 constructor(readonly retryAfterSeconds: number, code = 'usage_limit') { super(code, 'Usage budget unavailable; keep the original request.'); }
}
export const completionSchema = z.strictObject({
 requests: z.literal(1), batches: z.int().nonnegative(), rows_read: z.int().nonnegative(), rows_written: z.int().nonnegative(),
 measurement: z.enum(['observed', 'unknown']),
});
export type UsageCompletion = z.infer<typeof completionSchema>;
