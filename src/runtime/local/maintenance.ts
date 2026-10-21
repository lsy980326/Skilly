import { MemoryError } from "../../core/memory/model.js";
import { backupDatabase, restoreDatabase } from "../../adapters/storage/transfer/snapshot.js";
import { exportProject, importProject } from "../../adapters/storage/transfer/project.js";

export async function maintenance(command: string, options: {
  db?: string; input?: string; output?: string; "project-id"?: string; project?: string;
}) {
  if (!options.output || options.project) throw new MemoryError("invalid_input", "Maintenance requires --output and does not use --project bindings.");
  if (command === "backup" && options.db && !options.input && !options["project-id"]) {
    return backupDatabase(options.db, options.output);
  }
  if (command === "restore" && options.input && !options.db && !options["project-id"]) {
    return restoreDatabase(options.input, options.output);
  }
  if (command === "export" && options.db && options["project-id"] && !options.input) {
    return exportProject(options.db, options["project-id"], options.output);
  }
  if (command === "import" && options.input && !options["project-id"]) {
    return importProject(options.input, options.output, options.db);
  }
  throw new MemoryError("invalid_input", "Invalid maintenance options. See --help. No destination was activated.");
}
