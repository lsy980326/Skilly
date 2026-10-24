import { writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { SqliteViewer } from "../../adapters/storage/sqlite/viewer.js";
import { installSkillPackage, readSkillPackage, verifySkillPackage } from "../../adapters/skills/package-files.js";
import { createSkillPackage } from "../../core/skills/package.js";
import { registerSkillSchema } from "../../core/skills/model.js";
import { MemoryError } from "../../core/memory/model.js";
import { applySkillUpdate, previewSkillUpdate, recoverSkillUpdate } from "../../adapters/skills/update.js";

type Options = { db?: string; input?: string; output?: string; project?: string; "project-id"?: string; skill?: string; version?: string; tool?: string; folder?: string;
  from?: string; expect?: string; state?: string };
export function skillPackageCommand(command: string, options: Options) {
  if (command.startsWith("skill-update")) return updateCommand(command, options);
  if (options.from || options.expect || options.state) throw new MemoryError("invalid_input", "Update options require a skill-update command.");
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

function updateCommand(command: string, options: Options) {
  if (!options.project || !["codex", "cursor"].includes(options.tool ?? "") || options.db || options.output || options["project-id"] || options.skill || options.version)
    throw new MemoryError("invalid_input", "Update uses explicit --project, --tool and package/state files; no DB options.");
  const tool = options.tool as "codex" | "cursor";
  if (command === "skill-update-recover") {
    if (!options.state || !options.folder || options.from || options.input || options.expect) throw new MemoryError("invalid_input", "Recovery requires --state and --folder; no package or approval options.");
    const result = recoverSkillUpdate({ root: options.project, tool, folder: options.folder, state: options.state });
    if (result.status === "recovery_blocked" || result.lock_status === "release_failed") process.exitCode = 2;
    return result;
  }
  if (!options.from || !options.input) throw new MemoryError("invalid_input", "Preview/update require both --from old-package and --input new-package.");
  const input = { before: readSkillPackage(options.from), after: readSkillPackage(options.input), root: options.project, tool, folder: options.folder };
  if (command === "skill-update-preview") {
    if (options.expect || options.state) throw new MemoryError("invalid_input", "Preview is read-only; do not supply state or approval options.");
    const result = previewSkillUpdate(input); if (!result.applicable) process.exitCode = 2; return result;
  }
  if (!options.expect || !options.state) throw new MemoryError("invalid_input", "Apply requires the reviewed --expect preview hash and a fresh --state directory.");
  const result = applySkillUpdate(input, { expect: options.expect, state: options.state });
  if (result.status !== "applied" || result.lock_status === "release_failed") process.exitCode = 2;
  return result;
}
