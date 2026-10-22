import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { SqliteMemoryStore } from "../../adapters/storage/sqlite/store.js";
import { ViewerError } from "../../core/viewer/model.js";

const inputSchema = z.strictObject({ project_id: z.uuid(), run_id: z.uuid(), expected_updated_at: z.iso.datetime() });
export async function acknowledgeRun(path: string, request: IncomingMessage) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers["content-type"] ?? ""))
    throw new ViewerError("invalid_input", "확인 요청은 JSON 형식이어야 합니다.");
  const chunks: Buffer[] = []; let bytes = 0, oversized = false;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2048) { oversized = true; chunks.length = 0; }
    else if (!oversized) chunks.push(chunk);
  }
  if (oversized) throw new ViewerError("invalid_input", "확인 요청이 너무 큽니다.");
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new ViewerError("invalid_input", "확인 요청을 읽지 못했습니다."); }
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) throw new ViewerError("invalid_input", "작업과 마지막 기록을 다시 확인해 주세요.");
  const store = new SqliteMemoryStore(path);
  try { return store.reviews.acknowledge(parsed.data.project_id, parsed.data.run_id, parsed.data.expected_updated_at); }
  finally { store.close(); }
}
