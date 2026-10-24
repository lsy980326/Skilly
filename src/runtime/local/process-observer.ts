import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { MemoryError } from "../../core/memory/model.js";
import type { ExecutionSink, ExecutionStart } from "../../core/execution/recording.js";
import type { SourceObservation } from "../../core/execution/currentness.js";
import { prepareVitest } from "./vitest-collector.js";
import { nodeTestArguments, testCollector } from "./test-collector.js";

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

/** The same explicit process collector for local storage and host-injected async sinks.
 * A failed storage receipt NEVER causes a command replay. Not an agent-facing execution API. */
export async function observeCommand(options:{command:string;args:string[];root:string;timeout:number;testFormat:"auto"|"vitest";
  start:Pick<ExecutionStart,"project_id"|"run_id"|"record_id">;sink:ExecutionSink;source:()=>SourceObservation}) {
  const {command,args,root,timeout}=options;
  let vitest:ReturnType<typeof prepareVitest>|undefined;
  try {
    if(options.testFormat==="vitest")vitest=prepareVitest(command,args,root);
    const name=basename(command),executable=/^[a-zA-Z0-9._+-]{1,80}$/.test(name)?name:"local-command";
    const id=await options.sink.start({...options.start,source_observation:options.source(),executable,
      command_hash:createHash("sha256").update(JSON.stringify([command,...args])).digest("hex")});
    const out = counter(), err = counter(), at = performance.now();
    let interrupted = false, timedOut = false, incomplete = false, launchError: string | null = null;
    const collectedArgs = vitest?.args ?? nodeTestArguments(command, args, root), tests = testCollector(Boolean(collectedArgs));
    const child = spawn(command, collectedArgs ?? args, { cwd: root, ...(vitest ? { env: vitest.env } : {}), shell: false, detached: true, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    const detailStream = child.stdio[3], stdoutStream = child.stdout, stderrStream = child.stderr;
    if (!(detailStream instanceof Readable) || !stdoutStream || !stderrStream) throw new MemoryError("execution_pipe_failed", "Process streams unavailable; execution remains unconfirmed.");
    detailStream.on("data", (chunk: Buffer) => tests.add(chunk));
    detailStream.on("error", () => { incomplete = true; });
    stdoutStream.on("data", (chunk: Buffer) => out.add(chunk));
    stderrStream.on("data", (chunk: Buffer) => err.add(chunk));
    stdoutStream.on("error", () => { incomplete = true; });
    stderrStream.on("error", () => { incomplete = true; });
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
      drainTimer ??= setTimeout(() => { incomplete = true; stdoutStream.destroy(); stderrStream.destroy(); detailStream.destroy(); }, 2500);
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
      await options.sink.finish(id, { outcome, exit_code: result.code, signal: result.signal, error_code: launchError,
        duration_ms: Math.round(performance.now() - at), stdout_bytes: stdout.bytes, stderr_bytes: stderr.bytes,
        stdout_hash: stdout.hash, stderr_hash: stderr.hash, stdout_hashed_bytes: stdout.hashed, stderr_hashed_bytes: stderr.hashed, output_complete: incomplete ? 0 : 1 }, (vitest ?? tests).finish(outcome === "exited" && !incomplete), options.source());
    } catch {
      throw new MemoryError("execution_save_failed", "Process ended but result storage is unconfirmed. Never replay the command to retry storage.", false,
        { execution_id: id, persistence: "unconfirmed", automatic_replay: false });
    }
    return {execution_id:id,outcome,exit_code:result.code,signal:result.signal,
      code:launchError?127:interrupted?130:timedOut?124:result.code??128};
  } finally {vitest?.close();}
}
