import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { ViewerError } from "../../core/viewer/model.js";
import { SqliteViewer } from "../../adapters/storage/sqlite/viewer.js";

const assets = new Map([
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/style.css", { file: "style.css", type: "text/css; charset=utf-8" }],
]);
function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
function offset(url: URL): number {
  const raw = url.searchParams.get("offset") ?? "0";
  if (!/^\d{1,7}$/.test(raw)) throw new ViewerError("invalid_input", "목록 위치가 올바르지 않습니다.");
  return Number(raw);
}

export async function startViewer(options: { db: string; port?: number }) {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ViewerError("invalid_input", "포트는 0–65535여야 합니다.");
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const contents = new Map([...assets].map(([route, asset]) => [route, {
    ...asset, body: readFileSync(new URL(`../../../ui/${asset.file}`, import.meta.url)),
  }]));
  const reader = new SqliteViewer(options.db);
  let origin = "";
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    response.setHeader("X-Frame-Options", "DENY");
    if (`http://${request.headers.host}` !== origin
      || (request.headers.origin !== undefined && request.headers.origin !== origin)
      || request.headers["sec-fetch-site"] === "cross-site") {
      json(response, 403, { error: "이 컴퓨터의 Skilly 화면에서만 접근할 수 있습니다." }); return;
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      json(response, 405, { error: "조회만 지원합니다." }); return;
    }
    try {
      const url = new URL(request.url ?? "/", origin);
      if (url.origin !== origin) { json(response, 403, { error: "다른 주소는 지원하지 않습니다." }); return; }
      const asset = contents.get(url.pathname);
      if (asset) {
        response.writeHead(200, { "Content-Type": asset.type });
        response.end(asset.body); return;
      }
      const supplied = Buffer.from(request.headers.authorization ?? "");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        json(response, 401, { error: "터미널에 표시된 연결 주소로 다시 열어 주세요." }); return;
      }
      const allowed = new Set(["project", "offset", "query", "state", "before"]);
      if ([...url.searchParams.keys()].some(key => !allowed.has(key))) {
        throw new ViewerError("invalid_input", "지원하지 않는 조회 조건입니다.");
      }
      if (url.pathname === "/api/projects") { json(response, 200, reader.projects(offset(url))); return; }
      const project = url.searchParams.get("project") ?? "";
      if (url.pathname === "/api/runs") {
        json(response, 200, reader.runs(project, { offset: offset(url), query: url.searchParams.get("query") ?? "", state: url.searchParams.get("state") ?? "all" })); return;
      }
      if (url.pathname === "/api/recovery") { json(response, 200, reader.recovery(project, offset(url))); return; }
      const detail = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
      if (detail?.[1]) {
        const raw = url.searchParams.get("before");
        if (raw !== null && !/^\d{1,16}$/.test(raw)) throw new ViewerError("invalid_input", "기록 위치가 올바르지 않습니다.");
        json(response, 200, reader.detail(project, detail[1], raw === null ? undefined : Number(raw))); return;
      }
      json(response, 404, { error: "페이지를 찾을 수 없습니다." });
    } catch (error) {
      const status = error instanceof ViewerError ? { invalid_input: 400, not_found: 404, unavailable: 503 }[error.code] : 503;
      json(response, status, { error: error instanceof ViewerError ? error.message : "DB를 읽지 못했습니다. 파일 상태를 확인한 뒤 새로고침해 주세요." });
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 2000;
  server.maxConnections = 16;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") { reject(new Error("Missing listener address.")); return; }
        origin = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  } catch (error) { reader.close(); throw error; }
  let closing: Promise<void> | undefined;
  return {
    origin, url: `${origin}/#token=${token}`,
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => { reader.close(); error ? reject(error) : resolve(); });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
