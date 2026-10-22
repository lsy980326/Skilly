import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { previewMarkdown, SubmittedMarkdownLibrary } from "../../adapters/documents/markdown.js";
import { SqliteMemoryStore } from "../../adapters/storage/sqlite/store.js";
import type { SqliteViewer } from "../../adapters/storage/sqlite/viewer.js";
import { DocumentImporter } from "../../core/documents/importer.js";
import { MemoryService } from "../../core/memory/service.js";
import { ViewerError } from "../../core/viewer/model.js";
import { createMemoryContext } from "../../adapters/storage/sqlite/context.js";

const inputSchema = z.strictObject({ project_id: z.uuid(), target_run_id: z.uuid().optional(), target_scope: z.strictObject({
  repository: z.string().trim().min(1).max(100), environment: z.string().trim().min(1).max(100) }).optional(), component_key: z.string().max(80),
  path: z.string().min(1).max(300), text: z.string().min(1).max(65536), preview_token: z.string().max(100).optional() }).refine(input => Boolean(input.target_run_id) !== Boolean(input.target_scope), { message: "Choose one destination" });
const context = createMemoryContext();

export async function documentBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? ""))
    throw new ViewerError("invalid_input", "문서 요청은 JSON 형식이어야 합니다.");
  const chunks: Buffer[] = []; let bytes = 0, overflow = false;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 128 * 1024) { overflow = true; chunks.length = 0; }
    else if (!overflow) chunks.push(chunk);
  }
  if (overflow) throw new ViewerError("invalid_input", "문서 요청이 너무 큽니다. 48 KiB 이하의 문서를 선택해 주세요.");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ViewerError("invalid_input", "문서 요청을 읽지 못했습니다. 원문을 다시 선택해 주세요."); }
}

/** Only explicit authenticated import POSTs open a writer. Previews never do. */
export class ViewerDocuments {
  constructor(private readonly db: string, private readonly secret: string) {}
  async call(operation: "preview" | "import", raw: unknown, reader: SqliteViewer) {
    const parsed = inputSchema.safeParse(raw);
    if (!parsed.success) throw new ViewerError("invalid_input", "문서와 저장 위치를 다시 확인해 주세요.");
    const input = parsed.data;
    const target = reader.documentTarget(input.project_id, input.target_run_id, input.component_key, input.target_scope);
    const sourceRoot = target.component ? "component:" + target.component.key : "viewer";
    const preview = previewMarkdown(sourceRoot, input.path, input.text);
    // Sign the reviewed snapshot and destination. A changed file or target needs a fresh preview.
    const snapshot = JSON.stringify([input.project_id, target.repository, target.environment, input.component_key, input.path, preview.source.sha256]);
    const signature = createHmac("sha256", this.secret).update(snapshot).digest("hex");
    const key = "viewer-md:v1:" + context.hash(snapshot);
    const existing = reader.documentStatus(input.project_id, target, preview.source, input.text, key);
    if (operation === "preview") return { ...preview, preview_token: signature, existing };
    const supplied = Buffer.from(input.preview_token ?? ""); const expected = Buffer.from(signature);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new ViewerError("invalid_input", "미리보기 이후 문서나 저장 위치가 바뀌었습니다. 다시 미리보기해 주세요.");
    if (existing.state === "stored") return { status: "persisted", run_id: existing.run_id, import_run_id: existing.import_run_id, record_ids: existing.record_ids,
      report_origin: "retrospective", claims_verified: false, source_path_verified: false, source: preview.source };
    const store = new SqliteMemoryStore(this.db);
    try {
      const service = new MemoryService(store, context);
      const importer = new DocumentImporter(store, context);
      const started = await service.beginTask({ project_id: input.project_id, repository: target.repository, environment: target.environment,
        mode: "change", actor: "로컬 화면", title: `문서 가져오기 · ${input.path.slice(-100)}`,
        goal: `선택한 문서 ${input.path}의 원문을 소급·미검증 자료로 보관합니다. 원본 파일을 수정하지 않습니다. 내용 SHA-256: ${preview.source.sha256}`,
        ...(target.component ? { components: [target.component] } : {}), idempotency_key: key });
      const runId = z.object({ id: z.uuid() }).parse(started["run"]).id;
      const run = await store.getRun(input.project_id, runId);
      if (run?.state === "active") {
        const documents = new SubmittedMarkdownLibrary(sourceRoot, importer);
        await documents.import(input.project_id, runId, input.path, input.text, preview.source.sha256);
        await service.finishTask({ project_id: input.project_id, run_id: runId, outcome: "completed", idempotency_key: key + ":finish",
          report_origin: "retrospective", summary: `선택한 문서 ${input.path}를 소급·미검증 자료로 보관했습니다. 원본과 기존 기록은 변경하지 않았습니다.`,
          report: { title: "문서 가져오기 완료", summary: "선택한 문서의 원문을 소급·미검증 기록으로 저장했습니다. 내용 검증이나 현재 기능 상태 판정은 하지 않았습니다.",
            limitations: ["문서 경로는 사용자가 제공한 이름이며 실제 파일 위치를 자동 입증하지 않습니다."] } });
      }
      const saved = await importer.stored(input.project_id, target, preview.source, input.text);
      const recordIds = z.array(z.uuid()).min(1).parse(saved?.["record_ids"]);
      const first = await store.getRecord(input.project_id, recordIds[0]!);
      if (!first || first.repository !== target.repository || first.environment !== target.environment || first.source_fingerprint !== preview.source.sha256)
        throw new ViewerError("unavailable", "저장된 원문 연결을 확인하지 못했습니다. 같은 문서로 다시 시도해 주세요.");
      // An earlier MCP import can own the receipt; show that original task without closing it.
      return { status: "persisted", run_id: first.run_id, import_run_id: runId, record_ids: recordIds,
        report_origin: "retrospective", claims_verified: false, source_path_verified: false, source: preview.source };
    } finally { store.close(); }
  }
}
