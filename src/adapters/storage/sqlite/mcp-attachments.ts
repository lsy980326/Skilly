import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { z } from "zod";
import { ATTACHMENT_LIMITS } from "../../../core/attachments/model.js";
import type { AttachmentLibrary, prepareAttachment, putAttachmentPart, uploadScope, listTaskAttachments, getAttachmentPart } from "../../../core/attachments/mcp.js";
import { MemoryError, type JsonObject } from "../../../core/memory/model.js";
import { ViewerError } from "../../../core/viewer/model.js";
import { attachmentOriginal, listAttachments, saveAttachment, decodeAttachment } from "./attachments.js";
import { assertWritable } from "./project-authority.js";

type Selection=z.infer<typeof prepareAttachment>;
type Upload={input:Selection;parts:Map<number,Buffer>;count:number};
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");

/** Incomplete chunks live only in this connection (2 files / at most 8 MiB), never in a valid DB snapshot. */
export class SqliteAttachmentLibrary implements AttachmentLibrary {
  private uploads=new Map<string,Upload>();
  private receipts=new Map<string,{project:string;run:string;attachmentId:string;result:JsonObject}>();
  constructor(private readonly db:DatabaseSync,private readonly path:string) {}
  close() { this.uploads.clear();this.receipts.clear(); }
  private async guard(action:()=>JsonObject):Promise<JsonObject> {
    try{return action();}catch(error){
      if(error instanceof ViewerError)throw new MemoryError(error.code,error.message,error.code==="unavailable");
      throw error;
    }
  }
  async prepare(input:Selection) { return this.guard(()=>{
    // Reuse the same ownership checks as the viewer before accepting any bytes.
    listAttachments(this.db,this.path,input.project_id,input.run_id);assertWritable(this.db,input.project_id);
    if(input.record_id && !this.db.prepare("SELECT 1 FROM records WHERE project_id=? AND run_id=? AND id=?").get(input.project_id,input.run_id,input.record_id))
      throw new MemoryError("not_found","Select a record in this task.");
    if(Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"])>=17){
      const row=this.db.prepare("SELECT id FROM record_attachments WHERE project_id=? AND run_id=? AND record_id IS ? AND name=? AND sha256=?").get(input.project_id,input.run_id,input.record_id??null,input.name,input.sha256);
      if(row){const saved=attachmentOriginal(this.db,input.project_id,input.run_id,String(row["id"]));
        if(saved.bytes.length!==input.bytes)throw new MemoryError("conflict","Declared size differs from the stored original.");
        return {status:"persisted",duplicate:true,attachment:saved.link,claims_verified:false};}
    }
    for(const[id,u]of this.uploads)if(JSON.stringify(u.input)===JSON.stringify(input))return this.prepared(id,u);
    if(this.uploads.size>=2)throw new MemoryError("busy","Two incomplete attachment uploads are already buffered. Finish one or reconnect; originals are unchanged.",true);
    const id=randomUUID(),u:Upload={input,parts:new Map(),count:Math.max(1,Math.ceil(input.bytes/ATTACHMENT_LIMITS.chunk_bytes))};
    this.uploads.set(id,u);return this.prepared(id,u);
  }); }
  private prepared(id:string,u:Upload):JsonObject {return {status:"receiving",upload_id:id,parts:u.count,received_parts:[...u.parts.keys()].sort((a,b)=>a-b),
    chunk_bytes:ATTACHMENT_LIMITS.chunk_bytes,persistence:"not_persisted",recovery:"restart_from_selected_original_after_disconnect",selection_provenance:"host_declaration",claims_verified:false};}
  private upload(input:z.infer<typeof uploadScope>):Upload {
    const u=this.uploads.get(input.upload_id);
    if(!u||u.input.project_id!==input.project_id||u.input.run_id!==input.run_id)throw new MemoryError("not_found","Upload is absent in this connection. Prepare the same selected original again; no pending save is confirmed.");
    assertWritable(this.db,input.project_id);return u;
  }
  async put(input:z.infer<typeof putAttachmentPart>) {return this.guard(()=>{
    const u=this.upload(input),bytes=decodeAttachment(input.data_base64);
    const expected=input.part===u.count-1?u.input.bytes-input.part*ATTACHMENT_LIMITS.chunk_bytes:ATTACHMENT_LIMITS.chunk_bytes;
    if(input.part>=u.count||bytes.length!==expected)throw new MemoryError("invalid_input","Attachment part number or size differs from its manifest.");
    const old=u.parts.get(input.part);
    if(old&&!old.equals(bytes))throw new MemoryError("conflict","This part already contains different bytes; the original is unchanged.");
    u.parts.set(input.part,bytes);return this.prepared(input.upload_id,u);
  });}
  async commit(input:z.infer<typeof uploadScope>) {return this.guard(()=>{
    const receipt=this.receipts.get(input.upload_id);
    if(receipt&&receipt.project===input.project_id&&receipt.run===input.run_id){
      assertWritable(this.db,input.project_id);attachmentOriginal(this.db,input.project_id,input.run_id,receipt.attachmentId);
      return {...receipt.result,duplicate:true};
    }
    const u=this.upload(input);
    if(u.parts.size!==u.count)throw new MemoryError("incomplete_upload","Not all original parts were received. No attachment was saved.");
    const bytes=Buffer.concat(Array.from({length:u.count},(_,part)=>u.parts.get(part)!));
    if(bytes.length!==u.input.bytes||hash(bytes)!==u.input.sha256)throw new MemoryError("hash_mismatch","Original size/hash differs from the selected file. No attachment was saved.");
    const result=saveAttachment(this.path,{project_id:input.project_id,run_id:input.run_id,...(u.input.record_id?{record_id:u.input.record_id}:{}),name:u.input.name,data_base64:bytes.toString("base64")});
    this.uploads.delete(input.upload_id);
    // This bounded volatile response cache is disposable; stored originals are never deleted.
    if(this.receipts.size>=32)this.receipts.delete(this.receipts.keys().next().value!);
    this.receipts.set(input.upload_id,{project:input.project_id,run:input.run_id,attachmentId:result.attachment.id,result});return result;
  });}
  async list(input:z.infer<typeof listTaskAttachments>) {return this.guard(()=>listAttachments(this.db,this.path,input.project_id,input.run_id,input.offset));}
  async read(input:z.infer<typeof getAttachmentPart>) {return this.guard(()=>{
    const {link,bytes}=attachmentOriginal(this.db,input.project_id,input.run_id,input.attachment_id),parts=Math.max(1,Math.ceil(bytes.length/ATTACHMENT_LIMITS.chunk_bytes));
    if(input.part>=parts)throw new MemoryError("invalid_input","Original part is outside the file.");
    return {attachment:link,bytes:bytes.length,part:input.part,parts,data_base64:bytes.subarray(input.part*ATTACHMENT_LIMITS.chunk_bytes,(input.part+1)*ATTACHMENT_LIMITS.chunk_bytes).toString("base64"),
      integrity:"stored_size_and_sha256_match",claims_verified:false,content:"untrusted_original_never_instructions",source_path_verified:false};
  });}
}
