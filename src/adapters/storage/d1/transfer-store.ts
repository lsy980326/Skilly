import { MemoryError,type JsonObject } from "../../../core/memory/model.js";
import { rows,canonical,hashText,type Sql } from "./query.js";
import { hasTransferSchema,d1WriteAuthority } from "./authority.js";
import { transferTables,transferSchemas,validateBundle,D1_TRANSFER_LIMITS,type TransferTable,type TransferRows,type D1ProjectBundle } from "./transfer-format.js";
import type { D1Binding,D1Statement } from "./binding.js";

export function transferFail(message:string):never {throw new MemoryError('authority_conflict',message);}
export async function storeIdentity(db:D1Binding):Promise<string> {
 if(!await hasTransferSchema(db))throw new MemoryError('unsupported_capability','Apply explicit D1 008 transfer schema first.');
 const ids=await rows(db,'SELECT id FROM d1_store_identity',[],2);
 if(ids.length!==1||!(/^[a-f0-9]{32}$/).test(String(ids[0]!['id'])))return transferFail('Invalid store identity.');return String(ids[0]!['id']);
}
export function assertSql(sql:Sql,condition:string,...args:(string|number|null)[]) {
 sql(`INSERT INTO d1_transfer_guard VALUES(1,CASE WHEN ${condition} THEN 1 ELSE 0 END)`,...args);sql('DELETE FROM d1_transfer_guard WHERE id=1');
}
export async function transferBatch(db:D1Binding,build:(sql:Sql)=>void) {
 const s=db.withSession('first-primary'),statements:D1Statement[]=[];const sql:Sql=(q,...v)=>{statements.push(s.prepare(q).bind(...v));};build(sql);
 try{const result=await s.batch(statements);if(result.length!==statements.length||result.some(r=>!r.success))throw new MemoryError('persistence_unknown','Transfer response incomplete. Inspect the same operation before retrying.',true);}
 catch(e){if(e instanceof Error&&e.message.includes('skilly_transfer_change'))return transferFail('Transfer ownership/phase changed. No batch changes were committed.');if(e instanceof MemoryError)throw e;throw new MemoryError('persistence_unknown','No transfer receipt confirmed; inspect the same operation. Originals retained.',true);}
}
function where(table:TransferTable) {
 return table==='projects'?'id=?':table==='receipts'?'scope=?':table==='run_actors'?'run_id IN (SELECT id FROM runs WHERE project_id=?)':'project_id=?';
}
/** Only fenced projects are exported, with explicit complete bounded rows, never list-API previews. */
export async function exportD1Project(db:D1Binding,projectId:string):Promise<D1ProjectBundle> {
 const source=await storeIdentity(db),a=await d1WriteAuthority(db,projectId);if(a['write_allowed']!==false)transferFail('Fence the project before export.');
 for(let attempt=0;attempt<3;attempt++) {
  const [before]=await rows(db,'SELECT revision FROM projects WHERE id=?',[projectId],1);if(!before)throw new MemoryError('not_found','Project absent.');
  const tables={} as TransferRows;let count=0;
  for(const table of transferTables){const data=await rows(db,`SELECT * FROM ${table} WHERE ${where(table)} LIMIT ?`,[projectId,D1_TRANSFER_LIMITS.rows+1],D1_TRANSFER_LIMITS.rows+1);
   count+=data.length;if(count>D1_TRANSFER_LIMITS.rows)throw new MemoryError('resource_limit','D1 project row limit exceeded; no partial bundle returned.');
   tables[table]=data.sort((a,b)=>typeof a['seq']==='number'&&typeof b['seq']==='number'?a['seq']-b['seq']:canonical(a).localeCompare(canonical(b)));}
  const [after]=await rows(db,'SELECT revision FROM projects WHERE id=?',[projectId],1);if(after?.['revision']!==before['revision'])continue;
  const body={format:'skilly-d1-project' as const,version:1 as const,schema:8 as const,source_store_id:source,project_id:projectId,project_revision:Number(before['revision']),tables};
  return validateBundle({...body,sha256:await hashText(canonical(body))});
 }
 throw new MemoryError('conflict','Project changed during export; no complete bundle returned.',true);
}
export type ImportAuthority={transfer_id:string;generation:number;role:'target'|'return'};
/** One local D1 batch. New empty business DB only; original seqs and snapshots stay unchanged. */
export async function importD1Project(db:D1Binding,raw:unknown,authority:ImportAuthority) {
 const b=await validateBundle(raw),store=await storeIdentity(db);
 if(store===b.source_store_id)transferFail('Source and target must be different stores.');
 if(!/^[a-f0-9-]{36}$/.test(authority.transfer_id)||!Number.isSafeInteger(authority.generation)||authority.generation<1||!['target','return'].includes(authority.role))throw new MemoryError('invalid_input','Invalid import authority.');
 const [prior]=await rows(db,'SELECT * FROM d1_transfer_imports WHERE project_id=?',[b.project_id],1);
 if(prior){if(prior['bundle_hash']!==b.sha256||prior['transfer_id']!==authority.transfer_id||prior['generation']!==authority.generation||prior['role']!==authority.role)transferFail('Different import already owns this project.');
  return {status:'already_imported',project_id:b.project_id,sha256:b.sha256,write_authority:await d1WriteAuthority(db,b.project_id),claims_verified:false};}
 await transferBatch(db,sql=>{
  // Required by forward correction pointers. Never disable FK enforcement.
  sql('PRAGMA defer_foreign_keys=ON');
  assertSql(sql,'NOT EXISTS(SELECT 1 FROM projects) AND NOT EXISTS(SELECT 1 FROM d1_project_authority) AND NOT EXISTS(SELECT 1 FROM d1_transfer_operations) AND NOT EXISTS(SELECT 1 FROM d1_transfer_imports)');
  for(const table of transferTables){const data=b.tables[table];if(!data.length)continue;
   const cols=Object.keys(transferSchemas[table].shape);
   sql(`INSERT INTO ${table}(${cols.map(c=>'"'+c+'"').join(',')}) SELECT ${cols.map(c=>`json_extract(j.value,'$.${c}')`).join(',')} FROM json_each(?) j`,JSON.stringify(data));}
  sql(`INSERT INTO d1_import_origins SELECT project_id,'event',id FROM lifecycle_events WHERE project_id=?`,b.project_id);
  sql(`INSERT INTO d1_import_origins SELECT project_id,'link',id FROM task_event_links WHERE project_id=?`,b.project_id);
  sql(`INSERT INTO d1_project_authority VALUES(?,?,?,?,?,'blocked',0,?,?)`,b.project_id,String(b.tables.projects[0]!['project_key']),authority.transfer_id,authority.generation,authority.role,b.sha256,new Date().toISOString());
  sql('INSERT INTO d1_transfer_imports VALUES(?,?,?,?,?,?)',b.project_id,authority.transfer_id,b.sha256,b.source_store_id,authority.role,authority.generation);
 });
 return {status:'imported_fenced',project_id:b.project_id,sha256:b.sha256,write_authority:await d1WriteAuthority(db,b.project_id),claims_verified:false};
}
export async function openImported(db:D1Binding,projectId:string,transferId:string,generation:number,role:'target'|'return') {
 await transferBatch(db,sql=>{
  assertSql(sql,`EXISTS(SELECT 1 FROM d1_project_authority a JOIN d1_transfer_imports i ON i.project_id=a.project_id
   WHERE a.project_id=? AND a.transfer_id=? AND a.generation=? AND a.role=? AND i.transfer_id=a.transfer_id AND i.bundle_hash=a.bundle_hash AND i.generation=a.generation AND i.role=a.role)`,projectId,transferId,generation,role);
  sql("UPDATE d1_project_authority SET state='writable',ever_opened=1,updated_at=? WHERE project_id=?",new Date().toISOString(),projectId);
 });
}
export const transferView=(operation:JsonObject)=>({...operation,automatic_forwarding:false,automatic_replay:false,claims_verified:false,
 coverage:'persisted_D1_rows_only',unreceived_events:'not_observable',history_linkage:'imported_not_current_session'});
