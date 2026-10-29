import { z } from "zod";

export const ATTACHMENT_LIMITS = { file_bytes: 4 * 1024 * 1024, project_bytes: 64 * 1024 * 1024, chunk_bytes: 64 * 1024, links_per_run: 500 } as const;
const id = z.uuid(), hash = z.string().regex(/^[a-f0-9]{64}$/);
export const attachmentName = z.string().min(1).max(180).refine(name =>
  name === name.trim() && !/[\\/\u0000-\u001f\u007f]/.test(name) && name !== "." && name !== ".."
  && !/[\uD800-\uDFFF]/u.test(name)
  && !/^(?:\.env(?:\..*)?|auth\.json|credentials(?:\..*)?|id_(?:rsa|ed25519)(?:\..*)?)$/i.test(name)
  && !/\.(?:pem|key|p12|pfx)$/i.test(name), "공개 첨부 파일 이름을 확인해 주세요.");
export const attachmentInput = z.strictObject({ project_id: id, run_id: id, record_id: id.optional(), name: attachmentName,
  data_base64: z.string().max(Math.ceil(ATTACHMENT_LIMITS.file_bytes / 3) * 4) });
export const attachmentObjectRow = z.strictObject({ project_id: id, sha256: hash, bytes: z.int().nonnegative().max(ATTACHMENT_LIMITS.file_bytes),
  parts: z.int().positive().max(64), created_at: z.iso.datetime() });
export const attachmentChunkRow = z.strictObject({ project_id: id, sha256: hash, part: z.int().nonnegative().max(63),
  data_base64: z.string().max(Math.ceil(ATTACHMENT_LIMITS.chunk_bytes / 3) * 4) });
export const attachmentLinkRow = z.strictObject({ id, project_id: id, run_id: id, record_id: id.nullable(), sha256: hash,
  name: attachmentName, created_at: z.iso.datetime() });
