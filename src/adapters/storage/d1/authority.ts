import { MemoryError,type JsonObject } from "../../../core/memory/model.js";
import { rows,type Sql } from "./query.js";
import type { D1Binding } from "./binding.js";

export async function hasTransferSchema(db:D1Binding) {
  return (await rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='d1_project_authority'",[],1)).length===1;
}
/** Host-selected generation, captured by each writer. Never supplied by an AI mutation. */
export function withD1Generation(db:D1Binding,generation:number):D1Binding {
  if(!Number.isSafeInteger(generation)||generation<0)throw new MemoryError("invalid_input","Invalid host write generation.");
  return {writeGeneration:generation,withSession:c=>db.withSession(c)};
}
export async function d1WriteAuthority(db:D1Binding,projectId:string):Promise<JsonObject> {
  if(!await hasTransferSchema(db))return {status:"writable",write_allowed:true,managed:false,generation:0,claims_verified:false};
  const [a]=await rows(db,"SELECT * FROM d1_project_authority WHERE project_id=?",[projectId],1);
  return a?{...a,status:a["state"]==="writable"?"writable":"fenced",write_allowed:a["state"]==="writable",managed:true,
    automatic_forwarding:false,automatic_replay:false,claims_verified:false}:{status:"writable",write_allowed:true,managed:false,generation:0,claims_verified:false};
}
export async function prepareWriteGuard(db:D1Binding,projectId:string,generation:number) {
  const a=await d1WriteAuthority(db,projectId);
  if(!a["write_allowed"]||a["generation"]!==generation)throw new MemoryError("project_write_blocked","This connection's write generation is fenced. No automatic forwarding or replay.");
  if(!await hasTransferSchema(db))return undefined;
  return (sql:Sql)=>{
    sql(`INSERT INTO d1_write_guard VALUES(1,CASE WHEN coalesce((SELECT state='writable' AND generation=? FROM d1_project_authority WHERE project_id=?),?=0) THEN 1 ELSE 0 END)`,generation,projectId,generation);
    sql("DELETE FROM d1_write_guard WHERE id=1");
  };
}
export async function nativeOnly(db:D1Binding,alias:string,kind:"event"|"link") {
  return await hasTransferSchema(db)?`NOT EXISTS(SELECT 1 FROM d1_import_origins o WHERE o.project_id=${alias}.project_id AND o.kind='${kind}' AND o.row_id=${alias}.id)`:"1";
}
