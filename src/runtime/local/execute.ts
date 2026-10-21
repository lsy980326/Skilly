import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { z } from "zod";
import { loadProjectBinding } from "../../adapters/project/binding.js";
import { MemoryError } from "../../core/memory/model.js";
import { openLocal } from "./app.js";

const HASH_LIMIT = 1024 * 1024;
function counter() {
  const hash = createHash("sha256");
  let bytes = 0, hashed = 0;
  return {
    add(chunk: Buffer) {
      bytes += chunk.length;
      const part = chunk.subarray(0, Math.max(0, HASH_LIMIT - hashed));
      hash.update(part); hashed += part.length;
    },
    result: () => ({ bytes, hashed, hash: hash.digest("hex") }),
  };
}

/** Explicit opt-in process boundary. No imported caller-supplied exit code is accepted. */
export async function executeCommand(argv: string[]): Promise<number> {
  const separator = argv.indexOf("--");
  if (separator < 0) throw new MemoryError("invalid_input", "Use exec --db /absolute/db --project /absolute/root --run-id UUID -- executable args.");
  const { values } = parseArgs({ args: argv.slice(0, separator), options: {
    db: { type: "string" }, project: { type: "string" }, "run-id": { type: "string" }, "record-id": { type: "string" },
    "timeout-ms": { type: "string", default: "60000" },
  } });
  const [command, ...args] = argv.slice(separator + 1);
  const timeout = Number(values["timeout-ms"]);
  if (!command || command.includes("\0") || args.some(arg => arg.includes("\0")) || args.length > 128 || Buffer.byteLength(JSON.stringify([command, ...args])) > 32768
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
    // Store a generic executable label only. Arguments, paths, cwd and environment are not persisted.
    const name = basename(command);
    const executable = /^[a-zA-Z0-9._+-]{1,80}$/.test(name) ? name : "local-command";
    const id = app.executions.start({ project_id: project.id, run_id: runId,
      ...(values["record-id"] ? { record_id: values["record-id"] } : {}), executable,
      command_hash: createHash("sha256").update(JSON.stringify([command, ...args])).digest("hex") });
    const out = counter(), err = counter(), at = performance.now();
    let interrupted = false, timedOut = false, incomplete = false, launchError: string | null = null;
    const child = spawn(command, args, { cwd: root, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => out.add(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.add(chunk));
    child.stdout.on("error", () => { incomplete = true; });
    child.stderr.on("error", () => { incomplete = true; });
    let killTimer: NodeJS.Timeout | undefined, drainTimer: NodeJS.Timeout | undefined;
    let stopSettled: Promise<void> | undefined;
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    };
    const stop = () => {
      signalGroup("SIGTERM");
      stopSettled ??= new Promise<void>(done => { killTimer = setTimeout(() => { signalGroup("SIGKILL"); done(); }, 1000); });
      // A detached descendant may keep pipes open. Mark hashing incomplete below.
      drainTimer ??= setTimeout(() => { incomplete = true; child.stdout.destroy(); child.stderr.destroy(); }, 2500);
    };
    const onSignal = () => { interrupted = true; stop(); };
    process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(done => {
      child.once("error", error => { launchError = "code" in error && typeof error.code === "string" ? error.code : "SPAWN_ERROR"; });
      child.once("close", (code, signal) => done({ code, signal }));
    });
    // close only describes the direct child/pipes. Its silent descendants may still be alive.
    clearTimeout(timer); await stopSettled; clearTimeout(killTimer); clearTimeout(drainTimer);
    process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
    const stdout = out.result(), stderr = err.result();
    const outcome = launchError ? "launch_failed" : interrupted ? "interrupted" : timedOut ? "timed_out" : "exited";
    try {
      app.executions.finish(id, { outcome, exit_code: result.code, signal: result.signal, error_code: launchError,
        duration_ms: Math.round(performance.now() - at), stdout_bytes: stdout.bytes, stderr_bytes: stderr.bytes,
        stdout_hash: stdout.hash, stderr_hash: stderr.hash, stdout_hashed_bytes: stdout.hashed, stderr_hashed_bytes: stderr.hashed, output_complete: incomplete ? 0 : 1 });
    } catch {
      throw new MemoryError("execution_save_failed", "Process ended but result storage is unconfirmed. Never replay the command to retry storage.", false,
        { execution_id: id, persistence: "unconfirmed", automatic_replay: false });
    }
    process.stdout.write(`${JSON.stringify({ status: "persisted", execution_id: id, project_id: project.id, run_id: runId,
      outcome, exit_code: result.code, signal: result.signal, claims_verified: false, content_stored: false })}\n`);
    return launchError ? 127 : interrupted ? 130 : timedOut ? 124 : result.code ?? 128;
  } finally { await app.close(); }
}
