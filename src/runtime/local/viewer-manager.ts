import { fork } from "node:child_process";
import { lstatSync, mkdirSync, rmdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startViewer } from "../../transport/viewer/server.js";
import { control, controlPaths, inspectSocket, secureSocket, SERVICE, type ControlReply } from "./viewer-control.js";

function code(error: unknown) { return (error as NodeJS.ErrnoException).code; }
const missing = (error: unknown) => code(error) === "ENOENT";

async function worker(db: string, port: number) {
  const paths = controlPaths(db);
  let viewer: Awaited<ReturnType<typeof startViewer>> | undefined;
  let stopping = false;
  const server = createServer(socket => {
    let input = "", handled = false;
    socket.setTimeout(1500, () => socket.destroy());
    socket.on("error", () => {});
    socket.on("data", chunk => {
      input += chunk.toString();
      if (Buffer.byteLength(input) > 1024) { socket.destroy(); return; }
      if (handled || !input.includes("\n")) return;
      handled = true;
      const reply: ControlReply = { service: SERVICE, db, status: "running", pid: process.pid, ...(viewer ? { origin: viewer.origin } : {}) };
      try {
        const request = JSON.parse(input);
        if (request.service !== SERVICE || request.db !== db || !["status", "connect", "restart", "stop"].includes(request.command)) throw new Error("지원하지 않는 관리 요청입니다.");
        if (!viewer || stopping) throw new Error("서버 준비 또는 종료 중입니다.");
        if (request.command === "restart") { viewer.reload(); reply.restart_mode = "reload_in_place"; }
        if (request.command === "connect" || request.command === "restart") reply.url = viewer.url;
        if (request.command === "stop") { stopping = true; reply.status = "stopped"; }
        else {
          try { viewer.health(); } catch { reply.status = "degraded"; reply.error = "기록 DB 조회를 확인하지 못했습니다."; }
        }
      } catch (error) { reply.status = "error"; reply.error = error instanceof Error ? error.message : "관리 요청 실패"; }
      socket.end(`${JSON.stringify(reply)}\n`, () => { if (stopping) void shutdown(); });
    });
  });
  const shutdown = async () => {
    stopping = true;
    await viewer?.close();
    server.close();
  };
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(paths.socket, done); });
  secureSocket(paths.socket);
  try { viewer = await startViewer({ db, port }); }
  catch (error) { server.close(); throw error; }
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  process.send?.({ service: SERVICE, db, status: "running", pid: process.pid, origin: viewer.origin, url: viewer.url });
  process.disconnect?.();
}

async function launch(db: string, port: number): Promise<ControlReply> {
  const child = fork(fileURLToPath(import.meta.url), ["--worker", "--db", db, "--port", String(port)], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [],
  });
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("서버 준비 시간이 초과됐습니다.")); }, 8000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("서버 시작 실패. DB·포트·관리 통로를 확인해 주세요. 기존 서버는 종료하지 않았습니다.")); });
    child.once("message", reply => {
      clearTimeout(timer);
      const value = reply as ControlReply;
      if (value.service !== SERVICE || value.db !== db || value.status !== "running") { child.kill("SIGTERM"); reject(new Error("잘못된 준비 응답입니다.")); return; }
      child.unref(); done(value);
    });
  });
}

export async function manageViewer(command: string, dbPath: string, port: number): Promise<ControlReply> {
  if (!["start", "status", "restart", "stop"].includes(command)) throw new Error("start, status, restart, stop 중 하나를 사용하세요.");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("포트는 0–65535여야 합니다.");
  const paths = controlPaths(dbPath);
  // Status never cleans stale sockets or signals a PID.
  if (command !== "start") {
    try {
      const status = await control(paths.db, paths.socket, "status");
      if (command === "status") return status;
      return await control(paths.db, paths.socket, command as "restart" | "stop");
    }
    catch (error) {
      if (missing(error)) return { service: SERVICE, db: paths.db, status: "stopped", message: "관리 통로가 없습니다. 관리 명령 없이 켠 다른 서버의 실행 여부는 판정하지 않습니다." };
      if (["ECONNREFUSED", "ECONNRESET", "EPIPE", "CONTROL_EOF", "CONTROL_TIMEOUT"].includes(code(error) ?? "")) {
        return { service: SERVICE, db: paths.db, status: "unresponsive", error: "관리 통로가 응답하지 않습니다. 상태를 다시 확인한 뒤 start로 복구를 시도하세요." };
      }
      throw error;
    }
  }
  try { mkdirSync(paths.lock, { mode: 0o700 }); }
  catch (error) { if (code(error) === "EEXIST") throw new Error("다른 시작 요청이 처리 중이거나 시작 잠금이 남아 있습니다. status를 확인하세요. 기존 잠금은 변경하지 않았습니다."); throw error; }
  try {
    try { return await control(paths.db, paths.socket, "connect"); }
    catch (error) {
      if (!missing(error) && code(error) !== "ECONNREFUSED") throw error;
      if (code(error) === "ECONNREFUSED") {
        // All managed starts hold this lock; remove only this owner's unchanged dead socket.
        const before = inspectSocket(paths.socket), after = lstatSync(paths.socket);
        if (before.ino !== after.ino || before.dev !== after.dev) throw new Error("관리 통로가 변경됐습니다. 다시 확인해 주세요.");
        unlinkSync(paths.socket);
      }
    }
    const dbFile = lstatSync(paths.db);
    if (!dbFile.isFile() || dbFile.isSymbolicLink()) throw new Error("기존 일반 DB 파일만 시작할 수 있습니다.");
    return await launch(paths.db, port);
  } finally { rmdirSync(paths.lock); }
}

async function main() {
  const { values, positionals } = parseArgs({ options: { db: { type: "string" }, port: { type: "string", default: "50916" }, help: { type: "boolean" }, worker: { type: "boolean" } }, allowPositionals: true });
  if (values.help) { process.stdout.write("npm run viewer -- start|status|restart|stop [--db /absolute/memory.sqlite] [--port 50916]\n기본 DB: 현재 폴더/.skilly/memory.sqlite. 자동 시작 등록 없음. restart는 같은 프로세스에서 화면 자산·읽기 전용 DB를 다시 엽니다.\n"); return; }
  const db = resolve(values.db ?? ".skilly/memory.sqlite"), port = Number(values.port);
  if (values.worker) { await worker(db, port); return; }
  if (positionals.length !== 1) throw new Error("start, status, restart, stop 명령 하나를 지정해 주세요.");
  const result = await manageViewer(positionals[0]!, db, port);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (["degraded", "unresponsive"].includes(result.status)) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Skilly 화면 관리 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}\n`); process.exitCode = 1; });
}
