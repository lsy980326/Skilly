import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, dirname, basename, isAbsolute } from "node:path";

export const SERVICE = "skilly-viewer-manager-v1";
export type ViewerCommand = "status" | "connect" | "restart" | "stop";
export type ControlReply = { service: string; db: string; status: string; pid?: number; origin?: string; url?: string; error?: string; restart_mode?: string; sourceProjects?: string[]; message?: string };

export function privateDirectory(path: string) {
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
    throw new Error("관리 폴더의 소유자·권한을 확인해 주세요. 기존 항목은 변경하지 않았습니다.");
  }
}
export function controlPaths(dbPath: string) {
  if (process.platform === "win32") throw new Error("현재 서버 관리는 macOS·Linux에서 지원합니다. Windows에서는 기존 npm run view를 사용하세요.");
  if (!isAbsolute(dbPath)) throw new Error("DB의 절대 경로를 지정해 주세요.");
  // Locate an existing control endpoint even when the DB file itself has disappeared.
  const db = join(realpathSync(dirname(dbPath)), basename(dbPath));
  const root = join(Buffer.byteLength(tmpdir()) > 35 ? "/tmp" : tmpdir(), `skilly-viewer-${process.getuid?.()}`);
  privateDirectory(root);
  const directory = join(root, createHash("sha256").update(db).digest("hex").slice(0, 24));
  privateDirectory(directory);
  const socket = join(directory, "control.sock");
  if (Buffer.byteLength(socket) > 100) throw new Error("관리 소켓 경로가 너무 깁니다. 더 짧은 임시 폴더를 사용하세요.");
  return { db, directory, socket, lock: join(directory, "starting") };
}
export function inspectSocket(path: string) {
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error("신뢰할 수 없는 관리 소켓입니다. 기존 항목은 변경하지 않았습니다.");
  }
  return stat;
}
export async function control(db: string, path: string, command: ViewerCommand): Promise<ControlReply> {
  inspectSocket(path);
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let data = "";
    socket.setTimeout(2500, () => socket.destroy(Object.assign(new Error("관리 응답이 없습니다. 프로세스를 임의로 종료하지 않았습니다."), { code: "CONTROL_TIMEOUT" })));
    socket.once("connect", () => socket.write(`${JSON.stringify({ service: SERVICE, db, command })}\n`));
    socket.on("data", chunk => {
      data += chunk.toString();
      if (Buffer.byteLength(data) > 4096) socket.destroy(new Error("관리 응답이 너무 큽니다."));
    });
    socket.once("error", reject);
    socket.once("end", () => {
      try {
        if (!data.trim()) throw Object.assign(new Error("관리 연결이 응답 전에 종료됐습니다."), { code: "CONTROL_EOF" });
        const reply = JSON.parse(data) as ControlReply;
        if (reply.service !== SERVICE || reply.db !== db || !["running", "degraded", "stopped", "error"].includes(reply.status)) throw new Error("Skilly 관리 서버의 응답이 아닙니다.");
        if (reply.status === "error") throw new Error(reply.error || "관리 요청 실패");
        resolve(reply);
      } catch (error) { reject(error); }
    });
  });
}
export const secureSocket = (path: string) => chmodSync(path, 0o600);
