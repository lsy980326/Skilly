import { z } from "zod";
import { MemoryError } from "../memory/model.js";
import { registerSkillSchema, skillContentHash, type SkillVersion } from "./model.js";

const fields = registerSkillSchema.shape;
/** Share content only: no project identity, absolute paths, installation observations or receipts. */
export const skillPackageSchema = z.strictObject({
  format: z.literal("skilly-skill"), format_version: z.literal(1),
  skill_key: fields.skill_key, version: fields.version, source: fields.source, name: fields.name,
  description: fields.description, body: fields.body, files: fields.files,
  install_instructions: fields.install_instructions, content_hash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type SkillPackage = z.infer<typeof skillPackageSchema>;
export function parseSkillPackage(value: unknown): SkillPackage {
  const parsed = skillPackageSchema.safeParse(value);
  if (!parsed.success) throw new MemoryError("invalid_package", "Invalid skill package fields.");
  const p = parsed.data;
  // Reuse registration's combined size and duplicate-path contracts as well.
  const { format: _format, format_version: _formatVersion, content_hash: _hash, ...content } = p;
  const valid = registerSkillSchema.safeParse({ ...content,
    project_id: "00000000-0000-4000-8000-000000000000", idempotency_key: "package" });
  if (!valid.success) throw new MemoryError("invalid_package", "Invalid skill package content or paths.");
  if (skillContentHash(p.body, p.files) !== p.content_hash) throw new MemoryError("invalid_package", "Skill package content hash mismatch.");
  return p;
}
export function createSkillPackage(skill: SkillVersion): SkillPackage {
  return parseSkillPackage({ format: "skilly-skill", format_version: 1, skill_key: skill.skill_key, version: skill.version,
    source: skill.source, name: skill.name, description: skill.description, body: skill.body, files: skill.files,
    install_instructions: skill.install_instructions, content_hash: skill.content_hash });
}
