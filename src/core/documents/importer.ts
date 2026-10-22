import { MemoryError, type Context, type JsonObject, type MemoryRecord } from "../memory/model.js";
import type { MemoryStore } from "../memory/ports.js";
import type { WorkMutation } from "../work/model.js";

export interface MarkdownSource { path: string; sha256: string; bytes: number; source_root: string; access: "host_supplied_text"; }
export interface MarkdownLibrary {
  preview(path: string, text: string): JsonObject;
  import(projectId: string, runId: string, path: string, text: string, expectedHash: string): Promise<JsonObject>;
}
export function markdownParts(text: string): string[] {
  const points = Array.from(text), parts: string[] = [];
  for (let at = 0; at < points.length; at += 6000) parts.push(points.slice(at, at + 6000).join(""));
  return parts;
}

/** An imported document is retrospective source material, never current verified knowledge. */
export class DocumentImporter {
  constructor(private readonly store: MemoryStore, private readonly context: Context) {}
  async import(projectId: string, runId: string, source: MarkdownSource, text: string): Promise<JsonObject> {
    const run = await this.store.getRun(projectId, runId);
    if (!run || run.state !== "active") throw new MemoryError("run_closed", "Use this project's active task for document import.");
    const key = "md:v1:" + this.context.hash([run.repository, run.environment, source.source_root, source.path, source.sha256]);
    // Caller run does not create duplicates of the same source bytes/root in this scope.
    const hash = this.context.hash({ operation: "import_markdown", repository: run.repository, environment: run.environment, source_root: source.source_root, path: source.path, sha256: source.sha256, text });
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.store.getReceipt(projectId, key);
      if (existing) {
        if (existing.hash !== hash) throw new MemoryError("idempotency_conflict", "Document identity conflicts with a saved import.");
        return existing.result;
      }
      const project = await this.store.getProject(projectId);
      if (!project) throw new MemoryError("not_found", "Project does not exist.");
      const currentRun = await this.store.getRun(projectId, runId);
      if (!currentRun || currentRun.state !== "active") throw new MemoryError("run_closed", "This task ended before document import.");
      const now = this.context.now(), parts = markdownParts(text);
      const records: Omit<MemoryRecord, "seq">[] = parts.map(body => ({ id: this.context.id(), project_id: projectId, run_id: runId,
        topic: "document-import", kind: "note", body, repository: run.repository, environment: run.environment,
        source_fingerprint: source.sha256, observed_at: now, recorded_at: now, supersedes: null, superseded_by: null, report_origin: "retrospective" }));
      const reports: WorkMutation[] = records.map((record, index) => ({ run_id: runId, record_id: record.id, report: {
        title: `가져온 문서 · ${source.path.slice(-100)} (${index + 1}/${parts.length})`,
        summary: "선택한 Markdown 원문을 보관했습니다. 자동 요약이나 내용 검증은 하지 않았습니다.",
        limitations: ["과거 문서의 주장입니다. 현재 구현·검사·배포 상태로 자동 판단하지 않습니다."],
        import_source: { ...source, part: index + 1, parts: parts.length },
      } }));
      const result: JsonObject = { status: "persisted", record_ids: records.map(record => record.id), source: { ...source },
        parts: parts.length, report_origin: "retrospective", claims_verified: false, source_path_verified: false, duplicate_safe: true };
      const status = await this.store.commit({ project: { ...project, revision: project.revision + 1 }, expected_revision: project.revision,
        run: { ...currentRun, updated_at: now }, records, reports, receipt: { scope: projectId, key, hash, result } });
      if (status === "committed") return result;
    }
    throw new MemoryError("conflict", "Document import was not confirmed. Retry the same file and expected hash.", true);
  }
}
