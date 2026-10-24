import { observeCommand } from "./process-observer.js";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadProjectBinding } from "../../adapters/project/binding.js";
import { MemoryError } from "../../core/memory/model.js";
import { openLocal } from "./app.js";
import { observeSource } from "../../adapters/project/source-version.js";

/** Explicit opt-in process boundary. No imported caller-supplied exit code is accepted. */
export async function executeCommand(argv: string[]): Promise<number> {
  const separator = argv.indexOf("--");
  if (separator < 0) throw new MemoryError("invalid_input", "Use exec --db /absolute/db --project /absolute/root --run-id UUID -- executable args.");
  const { values } = parseArgs({ args: argv.slice(0, separator), options: {
    db: { type: "string" }, project: { type: "string" }, "run-id": { type: "string" }, "record-id": { type: "string" },
    "timeout-ms": { type: "string", default: "60000" }, "test-format": { type: "string", default: "auto" },
  } });
  const [command, ...args] = argv.slice(separator + 1);
  const timeout = Number(values["timeout-ms"]);
  if (!["auto", "vitest"].includes(values["test-format"]!) || !command || command.includes("\0") || args.some(arg => arg.includes("\0")) || args.length > 128 || Buffer.byteLength(JSON.stringify([command, ...args])) > 32768
    || !/^\d+$/.test(values["timeout-ms"]!) || !Number.isSafeInteger(timeout) || timeout < 10 || timeout > 3600000
    || !values.db || !isAbsolute(values.db) || !values.project || !isAbsolute(values.project)
    || !z.uuid().safeParse(values["run-id"]).success || (values["record-id"] && !z.uuid().safeParse(values["record-id"]).success)) {
    throw new MemoryError("invalid_input", "Execution requires a command, existing DB, project, task UUID and timeout 10–3600000ms.");
  }
  if (!["darwin", "linux"].includes(process.platform)) throw new MemoryError("unsupported_platform", "This runner currently supports macOS/Linux process groups.");
  const file = lstatSync(values.db);
  if (!file.isFile() || file.isSymbolicLink()) throw new MemoryError("invalid_path", "Use an existing regular DB file.");
  const root = realpathSync(values.project), binding = loadProjectBinding(root);
  const app = openLocal(values.db, binding, root);
  try {
    const resolved = await app.dispatcher.call("memory_resolve_project", {});
    const project = z.object({ id: z.uuid() }).parse(resolved["project"]);
    const runId = values["run-id"]!;
    await app.dispatcher.call("memory_get_status", { project_id: project.id, run_id: runId });
    if (values["record-id"]) await app.dispatcher.call("memory_get_evidence", { project_id: project.id, record_id: values["record-id"] });
    const result = await observeCommand({command,args,root,timeout,testFormat:values["test-format"] as "auto"|"vitest",
      sink:app.executions,source:()=>observeSource(root,binding),start:{project_id:project.id,run_id:runId,
        ...(values["record-id"]?{record_id:values["record-id"]}:{})}});
    process.stdout.write(`${JSON.stringify({ status: "persisted", execution_id: result.execution_id, project_id: project.id, run_id: runId,
      outcome: result.outcome, exit_code: result.exit_code, signal: result.signal, claims_verified: false, content_stored: false })}\n`);
    return result.code;
  } finally { await app.close(); }
}
