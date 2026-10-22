import { z } from "zod";
import { normalizeCodePath } from "./discovery.js";

export const workKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const text = (max: number) => z.string().trim().min(1).max(max);
export const componentSchema = z.strictObject({ key: workKey.refine(value => value !== "unclassified", "Reserved component key."), name: text(80) });
export const featureAlias = text(100).refine(value => !/[\u0000-\u001f\u007f]/.test(value), "Alias must be a single line.");
// Keep the public tool schema JSON-Schema compatible; normalize only at storage.
export const featureCodePath = text(240).refine(value => normalizeCodePath(value)!==null,"Use a public repository-relative code path.");
export const featureSchema = z.strictObject({ key: workKey, name: text(100), description: text(500).optional(),
  aliases: z.array(featureAlias).max(8).optional(), code_paths: z.array(featureCodePath).max(8).optional() });
const items = z.array(text(400)).max(8).optional();
export const reportSchema = z.strictObject({
  import_source: z.strictObject({ path: text(300), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.int().min(1).max(49152),
    source_root: text(100), access: z.literal("host_supplied_text"), part: z.int().min(1).max(9), parts: z.int().min(1).max(9) }).refine(value => value.part <= value.parts).optional(),
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
