import { fork } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, rmdirSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startViewer } from "../../transport/viewer/server.js";
import { control, controlPaths, inspectSocket, secureSocket, SERVICE, type ControlReply } from "./viewer-control.js";

function code(error: unknown) { return (error as NodeJS.ErrnoException).code; }
const missing = (error: unknown) => code(error) === "ENOENT";

async function worker(db: string, port: number, sessionToken?: string, sourceProjects: string[] = []) {
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
      const reply: ControlReply = { service: SERVICE, db, status: "running", pid: process.pid, sourceProjects, ...(viewer ? { origin: viewer.origin } : {}) };
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
  try { viewer = await startViewer({ db, port, sourceProjects, ...(sessionToken ? { sessionToken } : {}) }); }
  catch (error) { server.close(); throw error; }
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  process.send?.({ service: SERVICE, db, status: "running", pid: process.pid, sourceProjects, origin: viewer.origin, url: viewer.url });
  process.disconnect?.();
}

async function launch(db: string, port: number, sessionToken?: string, sourceProjects: string[] = []): Promise<ControlReply> {
  const child = fork(fileURLToPath(import.meta.url), ["--worker", "--db", db, "--port", String(port)], {
    detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], execArgv: [],
  });
  return new Promise((done, reject) => {
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("서버 준비 시간이 초과됐습니다.")); }, 8000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error("새 서버 시작 실패. status로 서버 상태와 DB·포트·관리 통로를 확인해 주세요.")); });
    child.once("message", reply => {
      clearTimeout(timer);
      const value = reply as ControlReply;
      if (value.service !== SERVICE || value.db !== db || value.status !== "running") { child.kill("SIGTERM"); reject(new Error("잘못된 준비 응답입니다.")); return; }
      child.unref(); done(value);
    });
    child.send({ service: SERVICE, sourceProjects, ...(sessionToken ? { sessionToken } : {}) }, error => {
      if (error) { clearTimeout(timer); child.kill("SIGTERM"); reject(new Error("새 서버에 시작 요청을 전달하지 못했습니다.")); }
    });
  });
}

export async function manageViewer(command: string, dbPath: string, port: number, sourceProjects?: string[]): Promise<ControlReply> {
  if (!["start", "status", "restart", "restart-code", "stop"].includes(command)) throw new Error("start, status, restart, restart-code, stop 중 하나를 사용하세요.");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("포트는 0–65535여야 합니다.");
  const paths = controlPaths(dbPath);
  // Status never cleans stale sockets or signals a PID.
  if (command !== "start" && command !== "restart-code") {
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
    if (command === "restart-code") {
      const previous = await control(paths.db, paths.socket, "connect");
      if (previous.status !== "running" || !previous.url || !previous.origin) throw new Error("정상 실행 중인 서버에서만 인증을 유지해 재시작할 수 있습니다. 기존 서버는 보존했습니다.");
      const address = new URL(previous.url);
      const sessionToken = new URLSearchParams(address.hash.slice(1)).get("token");
      if (address.origin !== previous.origin || address.hostname !== "127.0.0.1" || address.protocol !== "http:" || !sessionToken || !/^[a-f0-9]{64}$/.test(sessionToken))
        throw new Error("기존 서버의 주소와 인증을 확인하지 못했습니다. 기존 서버는 보존했습니다.");
      // Validate current code, assets and DB before stopping the authorized worker.
      const roots = sourceProjects ?? previous.sourceProjects ?? [];
      const probe = await startViewer({ db: paths.db, port: 0, sourceProjects: roots });
      try { probe.health(); } finally { await probe.close(); }
      await control(paths.db, paths.socket, "stop");
      const deadline = Date.now() + 5000;
      while (existsSync(paths.socket)) {
        if (Date.now() >= deadline) throw new Error("기존 서버 종료 확인 시간이 초과됐습니다. status로 상태를 확인해 주세요.");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const restarted = await launch(paths.db, Number(address.port), sessionToken, roots);
      if (restarted.url !== previous.url) throw new Error("재시작 후 기존 연결 일치를 확인하지 못했습니다.");
      return { ...restarted, restart_mode: "process_replaced" };
    }
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
    return await launch(paths.db, port, undefined, sourceProjects ?? []);
  } finally { rmdirSync(paths.lock); }
}

async function main() {
  const { values, positionals } = parseArgs({ options: { db: { type: "string" }, port: { type: "string", default: "50916" }, project: { type: "string", multiple: true }, help: { type: "boolean" }, worker: { type: "boolean" } }, allowPositionals: true });
  if (values.help) { process.stdout.write("npm run viewer -- start|status|restart|restart-code|stop [--db /absolute/memory.sqlite] [--port 50916] [--project /absolute/project]\n기본 DB: 현재 폴더/.skilly/memory.sqlite. 자동 시작 등록 없음. restart는 같은 프로세스에서 화면 자산·읽기 전용 DB를 다시 엽니다.\n"); return; }
  const db = resolve(values.db ?? ".skilly/memory.sqlite"), port = Number(values.port);
  if (values.worker) {
    const bootstrap = await new Promise<unknown>(resolve => process.once("message", resolve));
    const input = bootstrap as { service?: unknown; sessionToken?: unknown; sourceProjects?: unknown };
    if (!input || input.service !== SERVICE || (input.sessionToken !== undefined && (typeof input.sessionToken !== "string" || !/^[a-f0-9]{64}$/.test(input.sessionToken))))
      throw new Error("관리 프로세스의 시작 요청을 확인하지 못했습니다.");
    if (input.sourceProjects !== undefined && (!Array.isArray(input.sourceProjects) || input.sourceProjects.length > 16 || input.sourceProjects.some(x => typeof x !== "string"))) throw new Error("Invalid source project roots.");
    await worker(db, port, input.sessionToken as string | undefined, input.sourceProjects as string[] | undefined); return;
  }
  if (positionals.length !== 1) throw new Error("start, status, restart, restart-code, stop 명령 하나를 지정해 주세요.");
  const result = await manageViewer(positionals[0]!, db, port, values.project);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (["degraded", "unresponsive"].includes(result.status)) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Skilly 화면 관리 실패: ${error instanceof Error ? error.message : "알 수 없는 오류"}\n`); process.exitCode = 1; });
}
