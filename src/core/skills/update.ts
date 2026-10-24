import { createHash } from "node:crypto";
import { z } from "zod";
import { MemoryError } from "../memory/model.js";
import { parseSkillPackage, skillPackageSchema, type SkillPackage } from "./package.js";
import { packagePath, skillKey } from "./model.js";

export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const managedPath = z.union([z.literal("SKILL.md"), packagePath]);
export const fileIdentity = z.strictObject({ dev: z.string(), ino: z.string(), mode: z.number().int(),
  size: z.string(), mtime: z.string(), ctime: z.string() });
export const snapshotSchema = z.strictObject({ path: managedPath, state: z.enum(["present", "missing", "unavailable"]),
  hash: z.string().nullable(), identity: fileIdentity.nullable() });
export type Snapshot = z.infer<typeof snapshotSchema>;
export type UpdateInput = { before: SkillPackage; after: SkillPackage; root: string; tool: "codex" | "cursor"; folder?: string | undefined };
export const packageFiles = (p: SkillPackage) => [{ path: "SKILL.md", content: p.body }, ...p.files];
export function updatePair(input: UpdateInput) {
  const before = parseSkillPackage(input.before), after = parseSkillPackage(input.after);
  const folder = skillKey.parse(input.folder ?? before.skill_key);
  if (before.skill_key !== after.skill_key || before.source !== after.source)
    throw new MemoryError("source_conflict", "Update requires the same skill key and source.");
  if (before.version === after.version && JSON.stringify(before) !== JSON.stringify(after))
    throw new MemoryError("version_conflict", "Changed package content or metadata requires a new version.");
  const paths = [...new Set([...packageFiles(before), ...packageFiles(after)].map(f => f.path))].sort();
  if (new Set(paths.map(p => p.toLowerCase())).size !== paths.length)
    throw new MemoryError("path_conflict", "Case-insensitive package paths collide.");
  return { before, after, folder, paths };
}

export function describeUpdate(before: SkillPackage, after: SkillPackage, snapshots: Snapshot[]) {
  const old = new Map(packageFiles(before).map(f => [f.path, f.content]));
  const next = new Map(packageFiles(after).map(f => [f.path, f.content]));
  return snapshots.map(file => {
    const from = old.get(file.path), to = next.get(file.path);
    const conflicts: string[] = [];
    if (from !== undefined && (file.state !== "present" || file.hash !== digest(from))) conflicts.push("local_modified_or_unreadable");
    if (from === undefined && file.state !== "missing") conflicts.push("new_path_occupied_or_unreadable");
    if (to === undefined) conflicts.push("package_file_removal_not_allowed");
    return { path: file.path, change: from === undefined ? "added" : to === undefined ? "removed" : from === to ? "unchanged" : "changed",
      local_state: file.state, conflicts, before: from ?? null, after: to ?? null };
  });
}

export const updateManifestSchema = z.strictObject({
  format: z.literal("skilly-skill-update"), format_version: z.literal(1), id: z.uuid(),
  root: z.string(), tool: z.enum(["codex", "cursor"]), folder: skillKey,
  root_identity: z.string(), target_identity: z.string(), preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
  before: skillPackageSchema, after: skillPackageSchema,
  snapshots: z.array(snapshotSchema).min(1).max(34), staged: z.array(snapshotSchema).max(17),
});
export type UpdateManifest = z.infer<typeof updateManifestSchema>;
