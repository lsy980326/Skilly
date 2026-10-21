import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SqliteViewer } from "../../adapters/storage/sqlite/viewer.js";
import { installSkillPackage, readSkillPackage, verifySkillPackage } from "../../adapters/skills/package-files.js";
import { createSkillPackage } from "../../core/skills/package.js";
import { registerSkillSchema } from "../../core/skills/model.js";
import { MemoryError } from "../../core/memory/model.js";

type Options = { db?: string; input?: string; output?: string; project?: string; "project-id"?: string; skill?: string; version?: string; tool?: string; folder?: string };
export function skillPackageCommand(command: string, options: Options) {
  if (command === "skill-export") {
    if (!options.db || !options["project-id"] || !options.skill || !options.output || !isAbsolute(options.output)) throw new MemoryError("invalid_input", "skill-export requires --db, --project-id, --skill and an absolute --output file.");
    if (options.input || options.project || options.tool || options.folder) throw new MemoryError("invalid_input", "Unsupported export options.");
    const reader = new SqliteViewer(options.db);
    try {
      const data = reader.skills(options["project-id"], { key: options.skill, ...(options.version ? { version: options.version } : {}) });
      const raw = data.skill as Record<string, unknown>;
      const content = registerSkillSchema.parse({ project_id: raw.project_id, skill_key: raw.skill_key, version: raw.version, source: raw.source,
        name: raw.name, description: raw.description, body: raw.body, files: raw.files, install_instructions: raw.install_instructions, idempotency_key: "export" });
      const p = createSkillPackage({ ...content, content_hash: String(raw.content_hash), created_at: String(raw.created_at) });
      writeFileSync(options.output, JSON.stringify(p, null, 2)+"\n", { flag: "wx", mode: 0o600 });
      return { status: "exported", path: options.output, skill_key: p.skill_key, version: p.version, content_hash: p.content_hash, includes_project_records: false };
    } finally { reader.close(); }
  }
  if (!options.input || !options.project || !["codex", "cursor"].includes(options.tool ?? "")) throw new MemoryError("invalid_input", "Use --input /absolute/package.json --project /absolute/existing-project --tool codex|cursor.");
  if (options.db || options.output || options["project-id"] || options.skill || options.version) throw new MemoryError("invalid_input", "Install/verify read only the supplied package and target; no DB options.");
  const p = readSkillPackage(options.input), tool = options.tool as "codex" | "cursor";
  const result = command === "skill-install" ? installSkillPackage(p, options.project, tool, options.folder) : verifySkillPackage(p, options.project, tool, options.folder);
  if (result.state !== "matches") process.exitCode = 2;
  return result;
}
