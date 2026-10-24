import { z } from "zod";

export const skillKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const text = (max: number) => z.string().min(1).max(max);
export const packagePath = z.string().max(160).refine(path => path === "agents/openai.yaml" ||
  /^(references|scripts|assets)\/[a-zA-Z0-9_/-]+\.(md|txt|py|js|mjs|ts|sh|yaml|yml|json)$/.test(path), "Unsupported package file.")
  .refine(path => !path.split("/").some(part => !part || /(^\.|secret|credential|private|auth|token|password|config|\.pem$|\.key$)/i.test(part)), "Private or unsafe file path.");
export const registerSkillSchema = z.strictObject({ project_id: z.uuid(), skill_key: skillKey, version: text(80),
  source: text(500), name: text(100), description: z.string().max(500).default(""),
  body: text(48_000), files: z.array(z.strictObject({ path: packagePath, content: z.string().max(16_000) })).max(16).default([]),
  install_instructions: text(4000), idempotency_key: text(128),
}).refine(input => new TextEncoder().encode(JSON.stringify(input)).length <= 100 * 1024, "Skill package exceeds 100 KiB.")
  .refine(input => new Set(input.files.map(file => file.path)).size === input.files.length, "Duplicate package file.");
export const observationFilesSchema = z.array(z.strictObject({
  path: z.union([z.literal("SKILL.md"), packagePath]), state: z.enum(["matches", "modified", "missing", "unavailable"]),
  hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), bytes: z.int().min(0).max(256 * 1024).nullable(),
})).min(1).max(17);

/** Preserve the existing package hash representation across Node and Workers. */
export function skillContentText(body: string, files: { path: string; content: string }[]): string {
  const sorted = [{ path: "SKILL.md", content: body }, ...files].sort((a, b) => a.path.localeCompare(b.path));
  return JSON.stringify(sorted.map(file => ({ content: file.content, path: file.path })));
}
