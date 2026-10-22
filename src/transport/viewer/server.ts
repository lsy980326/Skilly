import { acknowledgeRun } from "./run-reviews.js";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { ViewerError } from "../../core/viewer/model.js";
import { SqliteViewer } from "../../adapters/storage/sqlite/viewer.js";
import { MemoryError } from "../../core/memory/model.js";
import { documentBody, ViewerDocuments } from "./documents.js";
import { sourceProvider } from "../../adapters/project/source-version.js";

const assets = new Map([
  ["/factory-geometry.js", { file: "factory-geometry.js", type: "text/javascript; charset=utf-8" }],
  ["/factory-motion.js", { file: "factory-motion.js", type: "text/javascript; charset=utf-8" }],
  ["/factory-scene.js", { file: "factory-scene.js", type: "text/javascript; charset=utf-8" }],
  ["/simple-dashboard.js", { file: "simple-dashboard.js", type: "text/javascript; charset=utf-8" }],
  ["/simple-dashboard.css", { file: "simple-dashboard.css", type: "text/css; charset=utf-8" }],
  ["/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/workstream.js", { file: "workstream.js", type: "text/javascript; charset=utf-8" }],
  ["/skills.js", { file: "skills.js", type: "text/javascript; charset=utf-8" }],
  ["/session.js", { file: "session.js", type: "text/javascript; charset=utf-8" }],
  ["/reports.js", { file: "reports.js", type: "text/javascript; charset=utf-8" }],
  ["/features.js", { file: "features.js", type: "text/javascript; charset=utf-8" }],
  ["/layout.js", { file: "layout.js", type: "text/javascript; charset=utf-8" }],
  ["/documents.js", { file: "documents.js", type: "text/javascript; charset=utf-8" }],
  ["/document-batch.js", { file: "document-batch.js", type: "text/javascript; charset=utf-8" }],
  ["/document-library.js", { file: "document-library.js", type: "text/javascript; charset=utf-8" }],
  ["/style.css", { file: "style.css", type: "text/css; charset=utf-8" }],
  ["/task-recording.js", { file: "task-recording.js", type: "text/javascript; charset=utf-8" }],
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

export async function startViewer(options: { db: string; port?: number; sessionToken?: string; sourceProjects?: string[] }) {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ViewerError("invalid_input", "포트는 0–65535여야 합니다.");
  if (options.sessionToken !== undefined && !/^[a-f0-9]{64}$/.test(options.sessionToken))
    throw new ViewerError("invalid_input", "기존 연결 인증을 확인하지 못했습니다.");
  const token = options.sessionToken ?? randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const loadContents = () => new Map([...assets].map(([route, asset]) => [route, {
    ...asset, body: readFileSync(new URL(`../../../ui/${asset.file}`, import.meta.url)),
  }]));
  let contents = loadContents();
  const sources = sourceProvider(options.sourceProjects ?? []);
  let reader = new SqliteViewer(options.db, Date.now, sources);
  const documents = new ViewerDocuments(options.db, token);
  let origin = "";
  const server = createServer(async (request, response) => {
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
    const documentPost = request.method === "POST" && /^\/api\/documents\/(preview|import)$/.test(request.url ?? "");
    const reviewPost = request.method === "POST" && request.url === "/api/runs/acknowledge";
    if (request.method !== "GET" && !documentPost && !reviewPost) {
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
      if (reviewPost) {
        if (request.headers.origin !== origin) { json(response, 403, { error: "Skilly 화면에서 확인 완료를 눌러 주세요." }); return; }
        json(response, 200, await acknowledgeRun(options.db, request)); return;
      }
      if (documentPost) {
        if (request.headers.origin !== origin) { json(response, 403, { error: "Skilly 화면에서 문서를 선택해 주세요." }); return; }
        const input = await documentBody(request);
        json(response, 200, await documents.call(url.pathname.endsWith("/preview") ? "preview" : "import", input, reader)); return;
      }
      const allowed = new Set(["project", "offset", "query", "state", "before", "component", "feature", "view", "skill", "version", "document", "compare", "review"]);
      if ([...url.searchParams.keys()].some(key => !allowed.has(key))) {
        throw new ViewerError("invalid_input", "지원하지 않는 조회 조건입니다.");
      }
      if (url.pathname === "/api/projects") { json(response, 200, reader.projects(offset(url))); return; }
      const project = url.searchParams.get("project") ?? "";
      if(url.pathname === "/api/documents") { json(response,200,reader.importedDocuments(project,{offset:offset(url),query:url.searchParams.get("query")??""}));return; }
      if(url.pathname === "/api/document") {
        const id=url.searchParams.get("document");if(!id) throw new ViewerError("invalid_input","문서를 선택해 주세요.");
        json(response,200,reader.importedDocuments(project,{id,offset:offset(url),...(url.searchParams.has("version")?{version:url.searchParams.get("version")!}:{}),...(url.searchParams.has("compare")?{compare:url.searchParams.get("compare")!}:{})}));return;
      }
      if (url.pathname === "/api/documents/targets") { json(response, 200, reader.documentTargets(project)); return; }
      if (url.pathname === "/api/skills") {
        json(response, 200, reader.skills(project, { offset: offset(url), query: url.searchParams.get("query") ?? "" })); return;
      }
      if (url.pathname === "/api/skill") {
        const key = url.searchParams.get("skill");
        if (!key) throw new ViewerError("invalid_input", "스킬을 선택해 주세요.");
        json(response, 200, reader.skills(project, { key, offset: offset(url), ...(url.searchParams.has("version") ? { version: url.searchParams.get("version")! } : {}) })); return;
      }
      if (url.pathname === "/api/overview") { json(response, 200, reader.overview(project, url.searchParams.get("view") ?? "components", offset(url))); return; }
      if (url.pathname === "/api/runs") {
        if (url.searchParams.has("review") && url.searchParams.get("review") !== "unread") throw new ViewerError("invalid_input", "확인 상태를 다시 선택해 주세요.");
        json(response, 200, reader.runs(project, { offset: offset(url), query: url.searchParams.get("query") ?? "", state: url.searchParams.get("state") ?? "all", unreviewed: url.searchParams.get("review") === "unread",
          ...(url.searchParams.has("component") ? { component: url.searchParams.get("component")! } : {}),
          ...(url.searchParams.has("feature") ? { feature: url.searchParams.get("feature")! } : {}) })); return;
      }
      if (url.pathname === "/api/recovery") { json(response, 200, reader.recovery(project, offset(url))); return; }
      const detail = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
      const executions = /^\/api\/runs\/([^/]+)\/executions$/.exec(url.pathname);
      if (executions?.[1]) { json(response, 200, reader.executions(project, executions[1], offset(url))); return; }
      if (detail?.[1]) {
        const raw = url.searchParams.get("before");
        if (raw !== null && !/^\d{1,16}$/.test(raw)) throw new ViewerError("invalid_input", "기록 위치가 올바르지 않습니다.");
        json(response, 200, reader.detail(project, detail[1], raw === null ? undefined : Number(raw))); return;
      }
      json(response, 404, { error: "페이지를 찾을 수 없습니다." });
    } catch (error) {
      if (error instanceof MemoryError) {
        if (reviewPost) { json(response, 503, { error: "확인 상태를 저장하지 못했습니다. 원래 기록은 그대로이며, 새로고침 후 다시 시도해 주세요." }); return; }
        const invalid = ["invalid_path", "invalid_document", "document_limit", "source_changed"].includes(error.code);
        json(response, invalid ? 400 : 503, { error: invalid ? "48 KiB 이하의 공개 UTF-8 Markdown 문서와 올바른 문서 이름을 선택해 주세요."
          : "저장 결과를 확인하지 못했습니다. 같은 문서와 저장 위치로 다시 시도해 주세요. 기존 기록은 삭제하지 않았습니다." }); return;
      }
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
    health(): void {
      if (!server.listening || closing) throw new Error("화면 서버가 요청을 받을 수 없습니다.");
      const file = lstatSync(options.db);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error("기록 DB 경로를 확인할 수 없습니다.");
      reader.projects(0);
    },
    reload(): void {
      if (closing) throw new Error("종료 중인 화면은 다시 열 수 없습니다.");
      // Stage both resources first so a failed reload leaves the authorized server usable.
      const nextContents = loadContents();
      const nextReader = new SqliteViewer(options.db, Date.now, sources);
      try { nextReader.projects(0); } catch (error) { nextReader.close(); throw error; }
      const previous = reader;
      reader = nextReader; contents = nextContents;
      previous.close();
    },
    close(): Promise<void> {
      closing ??= new Promise<void>((resolve, reject) => {
        server.close(error => { reader.close(); error ? reject(error) : resolve(); });
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
