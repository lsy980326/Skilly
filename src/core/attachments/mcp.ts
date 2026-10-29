import { z } from "zod";
import { attachmentName, ATTACHMENT_LIMITS } from "./model.js";
import type { JsonObject } from "../memory/model.js";

export const attachmentScope = { project_id:z.uuid(), run_id:z.uuid() };
export const prepareAttachment = z.strictObject({ ...attachmentScope, record_id:z.uuid().optional(), name:attachmentName,
  bytes:z.int().min(0).max(ATTACHMENT_LIMITS.file_bytes), sha256:z.string().regex(/^[a-f0-9]{64}$/),
  selection:z.strictObject({kind:z.literal("user_selected"),reference:z.string().trim().min(1).max(200)}) });
export const uploadScope = z.strictObject({...attachmentScope,upload_id:z.uuid()});
export const putAttachmentPart = uploadScope.extend({part:z.int().min(0).max(63),data_base64:z.string().max(Math.ceil(ATTACHMENT_LIMITS.chunk_bytes/3)*4)});
export const listTaskAttachments = z.strictObject({...attachmentScope,offset:z.int().min(0).max(1_000_000).default(0)});
export const getAttachmentPart = z.strictObject({...attachmentScope,attachment_id:z.uuid(),part:z.int().min(0).max(63).default(0)});

export interface AttachmentLibrary {
  prepare(input:z.infer<typeof prepareAttachment>):Promise<JsonObject>;
  put(input:z.infer<typeof putAttachmentPart>):Promise<JsonObject>;
  commit(input:z.infer<typeof uploadScope>):Promise<JsonObject>;
  list(input:z.infer<typeof listTaskAttachments>):Promise<JsonObject>;
  read(input:z.infer<typeof getAttachmentPart>):Promise<JsonObject>;
}
