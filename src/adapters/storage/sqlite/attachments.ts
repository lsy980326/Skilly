import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { ATTACHMENT_LIMITS, attachmentInput, attachmentObjectRow, attachmentChunkRow, attachmentLinkRow } from "../../../core/attachments/model.js";
import { ViewerError } from "../../../core/viewer/model.js";
import { assertWritable, authoritySql, hasAuthority } from "./project-authority.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const invalid = (message: string): never => { throw new ViewerError("invalid_input", message); };
const unavailable = (): never => { throw new ViewerError("unavailable", "첨부 원본의 크기·내용을 확인하지 못했습니다. 저장된 자료는 변경하지 않았습니다."); };
export function decodeAttachment(text: string): Buffer {
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text || bytes.length > ATTACHMENT_LIMITS.file_bytes) invalid("첨부는 4 MiB 이하의 파일을 선택해 주세요.");
  return bytes;
}
function number(db: DatabaseSync, sql: string, ...args: string[]): number {
  return z.number().parse(db.prepare(sql).get(...args)?.["n"]);
}
function fileBytes(path: string): number {
  try { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink()) return 0; return s.size; }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return 0; throw error; }
}
function target(db: DatabaseSync, project: string, run: string, record?: string) {
  if (!z.uuid().safeParse(project).success || !z.uuid().safeParse(run).success || (record !== undefined && !z.uuid().safeParse(record).success)) invalid("첨부를 연결할 작업·기록을 선택해 주세요.");
  if (!db.prepare("SELECT 1 FROM runs WHERE project_id=? AND id=?").get(project,run)
    || (record && !db.prepare("SELECT 1 FROM records WHERE project_id=? AND run_id=? AND id=?").get(project,run,record)))
    throw new ViewerError("not_found", "이 작업에 속한 기록을 찾지 못했습니다.");
}
function ready(db: DatabaseSync) { return Number(db.prepare("PRAGMA user_version").get()?.["user_version"]) >= 17; }
export function attachmentUsage(db: DatabaseSync, path: string, project: string) {
  if (!z.uuid().safeParse(project).success) invalid("프로젝트를 선택해 주세요.");
  if (!db.prepare("SELECT 1 FROM projects WHERE id=?").get(project)) throw new ViewerError("not_found", "프로젝트를 찾지 못했습니다.");
  const available = ready(db);
  const database = fileBytes(path), wal = fileBytes(path+"-wal"), shared = fileBytes(path+"-shm");
  return { original_bytes: available ? number(db,"SELECT coalesce(sum(bytes),0) n FROM attachment_objects WHERE project_id=?",project) : 0,
    unique_files: available ? number(db,"SELECT count(*) n FROM attachment_objects WHERE project_id=?",project) : 0,
    links: available ? number(db,"SELECT count(*) n FROM record_attachments WHERE project_id=?",project) : 0,
    encoded_bytes: available ? number(db,"SELECT coalesce(sum(length(data_base64)),0) n FROM attachment_chunks WHERE project_id=?",project) : 0,
    database_bytes: database, wal_bytes: wal, shared_memory_bytes: shared, database_total_bytes: database+wal+shared,
    database_scope: "all_projects", limits: ATTACHMENT_LIMITS, automatic_deletion: false, claims_verified: false };
}
export function listAttachments(db: DatabaseSync, path: string, project: string, run: string, offset=0) {
  target(db,project,run);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) invalid("첨부 목록 위치를 확인해 주세요.");
  const rows = ready(db) ? db.prepare(`SELECT a.*,o.bytes FROM record_attachments a JOIN attachment_objects o USING(project_id,sha256)
    WHERE a.project_id=? AND a.run_id=? ORDER BY a.created_at DESC,a.id LIMIT 21 OFFSET ?`).all(project,run,offset) : [];
  const items = rows.slice(0,20).map(row => { const {bytes,...link}=row; return {...attachmentLinkRow.parse(link),bytes:z.int().min(0).max(ATTACHMENT_LIMITS.file_bytes).parse(bytes),claims_verified:false}; });
  return {items,total:ready(db)?number(db,"SELECT count(*) n FROM record_attachments WHERE project_id=? AND run_id=?",project,run):0,
    next_offset:rows.length>20?offset+20:null,usage:attachmentUsage(db,path,project)};
}
export function attachmentOriginal(db: DatabaseSync, project: string, run: string, id: string) {
  target(db,project,run);
  if (!z.uuid().safeParse(id).success) invalid("첨부 식별자를 확인해 주세요.");
  const raw = ready(db) ? db.prepare("SELECT * FROM record_attachments WHERE project_id=? AND run_id=? AND id=?").get(project,run,id) : undefined;
  if (!raw) throw new ViewerError("not_found", "이 작업의 첨부를 찾지 못했습니다.");
  const link = attachmentLinkRow.parse(raw), bytes = originalBytes(db,project,link.sha256);
  return {link,bytes};
}
function originalBytes(db: DatabaseSync, project: string, hash: string): Buffer {
  const object = attachmentObjectRow.parse(db.prepare("SELECT * FROM attachment_objects WHERE project_id=? AND sha256=?").get(project,hash));
  const rows = db.prepare("SELECT * FROM attachment_chunks WHERE project_id=? AND sha256=? ORDER BY part LIMIT 65").all(project,hash);
  if (rows.length !== object.parts) return unavailable();
  const buffers = rows.map((row,index) => { const chunk=attachmentChunkRow.parse(row); if(chunk.part!==index) return unavailable(); return decodeAttachment(chunk.data_base64); });
  const bytes=Buffer.concat(buffers);
  if(bytes.length!==object.bytes || digest(bytes)!==hash) return unavailable();
  return bytes;
}
export function validateAttachmentData(db: DatabaseSync) {
  for(const row of db.prepare("SELECT * FROM attachment_objects").iterate()) { const o=attachmentObjectRow.parse(row); originalBytes(db,o.project_id,o.sha256); }
  for(const row of db.prepare("SELECT * FROM record_attachments").iterate()) { const link=attachmentLinkRow.parse(row);target(db,link.project_id,link.run_id,link.record_id??undefined); }
}

/** The only writer is an explicit upload. Original reports and source files are never edited. */
export function saveAttachment(path: string, raw: unknown) {
  const parsed=attachmentInput.safeParse(raw); if(!parsed.success) return invalid("첨부 파일과 연결할 작업·기록을 확인해 주세요.");
  const input=parsed.data, bytes=decodeAttachment(input.data_base64), hash=digest(bytes);
  const stat=lstatSync(path); if(!isAbsolute(path)||!stat.isFile()||stat.isSymbolicLink()) invalid("기존 로컬 DB 파일만 사용할 수 있습니다.");
  const db=new DatabaseSync(path,{enableForeignKeyConstraints:true,enableDoubleQuotedStringLiterals:false});
  try {
    db.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;");
    try {
      const version=Number(db.prepare("PRAGMA user_version").get()?.["user_version"]);
      if(db.prepare("PRAGMA application_id").get()?.["application_id"]!==1397446988 || ![15,16,17].includes(version)) invalid("첨부 저장은 최신 로컬 DB에서 지원합니다. 기존 파일은 변경하지 않았습니다.");
      target(db,input.project_id,input.run_id,input.record_id); assertWritable(db,input.project_id);
      if(version===15)db.exec(readFileSync(new URL("../../../../migrations/016-storage-origins.sql",import.meta.url),"utf8"));
      if(version<17)db.exec(readFileSync(new URL("../../../../migrations/017-attachments.sql",import.meta.url),"utf8"));
      if(hasAuthority(db))db.exec(authoritySql("main",true,true,true));
      const existing=db.prepare("SELECT * FROM record_attachments WHERE project_id=? AND run_id=? AND record_id IS ? AND name=? AND sha256=?").get(input.project_id,input.run_id,input.record_id??null,input.name,hash);
      if(existing) { originalBytes(db,input.project_id,hash); db.exec("COMMIT"); return {status:"persisted",duplicate:true,attachment:attachmentLinkRow.parse(existing),claims_verified:false}; }
      if(number(db,"SELECT count(*) n FROM record_attachments WHERE project_id=? AND run_id=?",input.project_id,input.run_id)>=ATTACHMENT_LIMITS.links_per_run)invalid("작업당 첨부는 500개까지 보관합니다. 기존 첨부는 그대로 유지합니다.");
      const found=db.prepare("SELECT 1 FROM attachment_objects WHERE project_id=? AND sha256=?").get(input.project_id,hash),now=new Date().toISOString();
      if(found) originalBytes(db,input.project_id,hash);
      else {
        if(number(db,"SELECT coalesce(sum(bytes),0) n FROM attachment_objects WHERE project_id=?",input.project_id)+bytes.length>ATTACHMENT_LIMITS.project_bytes) invalid("프로젝트 첨부 보관 한도 64 MiB를 넘습니다. 기존 원본은 삭제하지 않았습니다.");
        const parts=Math.max(1,Math.ceil(bytes.length/ATTACHMENT_LIMITS.chunk_bytes));
        db.prepare("INSERT INTO attachment_objects VALUES(?,?,?,?,?)").run(input.project_id,hash,bytes.length,parts,now);
        for(let part=0;part<parts;part++)db.prepare("INSERT INTO attachment_chunks VALUES(?,?,?,?)").run(input.project_id,hash,part,bytes.subarray(part*ATTACHMENT_LIMITS.chunk_bytes,(part+1)*ATTACHMENT_LIMITS.chunk_bytes).toString("base64"));
      }
      const link={id:randomUUID(),project_id:input.project_id,run_id:input.run_id,record_id:input.record_id??null,sha256:hash,name:input.name,created_at:now};
      db.prepare("INSERT INTO record_attachments VALUES(?,?,?,?,?,?,?)").run(link.id,link.project_id,link.run_id,link.record_id,hash,link.name,now);
      db.prepare("UPDATE projects SET revision=revision+1 WHERE id=?").run(input.project_id);
      db.exec("COMMIT");return {status:"persisted",duplicate:false,attachment:link,claims_verified:false};
    } catch(error) {db.exec("ROLLBACK");throw error;}
  } finally { db.close(); }
}
