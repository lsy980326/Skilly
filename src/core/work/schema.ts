import { z } from "zod";

export const workKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
export const componentSchema = z.strictObject({ key: workKey.refine(value => value !== "unclassified", "Reserved component key."), name: text(80) });
export const featureSchema = z.strictObject({ key: workKey, name: text(100), description: text(500).optional() });
const items = z.array(text(400)).max(8).optional();
export const reportSchema = z.strictObject({
  title: text(160), summary: text(800), changes: items, limitations: items, next_steps: items,
  checks: z.array(z.strictObject({ name: text(160), result: z.enum(["passed", "failed", "not_run"]), detail: text(400).optional() })).max(8).optional(),
  technical: z.strictObject({
    files: items, symbols: items, commands: items,
    record_ids: z.array(z.uuid()).max(8).optional(),
    context: text(1200).optional(),
  }).optional(),
  feature_updates: z.array(z.strictObject({ key: workKey,
    state: z.enum(["planned", "in_progress", "implemented", "blocked", "retired"]), summary: text(400),
  })).max(8).optional(),
}).refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 12 * 1024, "Report exceeds 12 KiB.");
// Never add defaults here: omitted metadata must preserve legacy retry hashes.
export const workLinks = {
  components: z.array(componentSchema).max(12).optional(),
  features: z.array(featureSchema).max(12).optional(),
};
