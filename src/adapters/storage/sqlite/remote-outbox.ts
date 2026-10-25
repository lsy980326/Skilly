import { DatabaseSync,type SQLOutputValue } from 'node:sqlite';
import { closeSync,constants,lstatSync,openSync } from 'node:fs';
import { isAbsolute,join,parse,resolve } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { cloudWriteSchema } from '../../../core/access/commands.js';
import { remoteDestinationSchema,writeTicketSchema,outboxStateSchema,type RemoteDestination,type RemoteOutboxStore,type OutboxRequest,type OutboxState,type WriteTicket } from '../../../core/access/remote-outbox.js';
import { MemoryError,parseJsonObject,type JsonObject } from '../../../core/memory/model.js';
import { canonical } from '../d1/query.js';
import type { z } from 'zod';

const APP=1397444418,MAX_BYTES=1024*1024;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function safePath(path:string){
 if(!isAbsolute(path)||resolve(path)!==path)throw new MemoryError('invalid_input','An explicit normalized outbox path is required.');
 let current=parse(path).root;
 for(const part of path.slice(current.length).split('/').slice(0,-1)){current=join(current,part);if(lstatSync(current).isSymbolicLink())throw new MemoryError('outbox_unavailable','Symlinked outbox path.');}
}
/** Separate, explicitly selected local queue. Never open a project's memory DB as an outbox. */
export class SqliteRemoteOutbox implements RemoteOutboxStore {
 readonly destination:RemoteDestination;
 private readonly db:DatabaseSync;
 constructor(path:string,destination:RemoteDestination){
  const parsed=remoteDestinationSchema.parse(structuredClone(destination));this.destination=Object.freeze({...parsed,scope:Object.freeze(parsed.scope)});
  Object.defineProperty(this,'destination',{value:this.destination,writable:false,configurable:false,enumerable:true});safePath(path);let created=false;
  try{closeSync(openSync(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600));created=true;}
  catch(e){if(!(e instanceof Error)||!('code' in e)||e.code!=='EEXIST')throw new MemoryError('outbox_unavailable','Could not open the explicit outbox.');}
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new MemoryError('outbox_unavailable','Outbox must be a private regular file. Existing files were preserved.');
  const db=new DatabaseSync(path,{enableDoubleQuotedStringLiterals:false});
  try{
   const app=db.prepare('PRAGMA application_id').get()?.['application_id'],version=db.prepare('PRAGMA user_version').get()?.['user_version'];
   if(created&&app===0&&version===0){db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE destination(value TEXT NOT NULL) STRICT;
    CREATE TABLE requests(id TEXT PRIMARY KEY,operation TEXT NOT NULL,request_key TEXT NOT NULL,hash TEXT NOT NULL,ticket_json TEXT NOT NULL,
     input_json TEXT,state TEXT NOT NULL CHECK(state IN ('recovery_pending','persistence_unknown','auth_required','access_denied','blocked','saved')),
     attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,receipt_seen INTEGER NOT NULL DEFAULT 0,write_dispatched INTEGER NOT NULL DEFAULT 0,
     last_error TEXT,result_json TEXT,lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,UNIQUE(operation,request_key)) STRICT;
    CREATE INDEX pending ON requests(state,next_attempt_at,created_at,id);
    PRAGMA application_id=${APP};PRAGMA user_version=1;`);
    db.prepare('INSERT INTO destination VALUES(?)').run(canonical(this.destination));db.exec('COMMIT');
   }else if(app!==APP||version!==1)throw new MemoryError('outbox_unavailable','Unsupported outbox; existing data was preserved.');
   if(db.prepare('SELECT value FROM destination').get()?.['value']!==canonical(this.destination))throw new MemoryError('scope_mismatch','Outbox belongs to another destination.');
   db.exec('PRAGMA busy_timeout=250;PRAGMA synchronous=FULL;PRAGMA cache_size=-1024;');this.db=db;
  }catch(e){db.close();throw e;}
 }
 close(){this.db.close();}
 retain(raw:z.input<typeof cloudWriteSchema>,rawTicket:WriteTicket):JsonObject {
  const command=cloudWriteSchema.parse(structuredClone(raw)),ticket=writeTicketSchema.parse(structuredClone(rawTicket));
  if(ticket.operation!==command.operation||command.operation==='skill-register'&&command.input.project_id!==this.destination.scope.project_id)throw new MemoryError('scope_mismatch','Request and pinned destination differ.');
  const input=canonical(command),digest=hash(input),key=command.input.idempotency_key;
  // Include the JSON-RPC envelope, fixed scope and context tag in the wire limit.
  if(Buffer.byteLength(canonical({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'memory_checkpoint_skill_usage',arguments:{...command.input,...this.destination.scope,expected_write_context:ticket.context_id}}}))>65472)
   throw new MemoryError('resource_limit','Request exceeds the remote wire limit; nothing was retained.');
  this.db.exec('BEGIN IMMEDIATE');
  try{
   const prior=this.db.prepare('SELECT * FROM requests WHERE operation=? AND request_key=?').get(command.operation,key);
   if(prior){if(prior['hash']!==digest||prior['ticket_json']!==canonical(ticket))throw new MemoryError('idempotency_conflict','Preserve the original input, key and context.');
    this.db.exec('COMMIT');return this.status(prior);}
   const total=this.db.prepare('SELECT count(*) n,sum(input_json IS NOT NULL) pending,coalesce(sum(length(CAST(input_json AS BLOB))),0) bytes FROM requests').get()!;
   if(Number(total['n'])>=1000||Number(total['pending'])>=100||Number(total['bytes'])+Buffer.byteLength(input)>MAX_BYTES)throw new MemoryError('outbox_full','Queue capacity reached; no existing request was discarded and no remote write was attempted.');
   const id=randomUUID();this.db.prepare("INSERT INTO requests(id,operation,request_key,hash,ticket_json,input_json,state,created_at) VALUES(?,?,?,?,?,?,'recovery_pending',?)")
    .run(id,command.operation,key,digest,canonical(ticket),input,new Date().toISOString());this.db.exec('COMMIT');return this.listOne(id);
  }catch(e){this.db.exec('ROLLBACK');throw e;}
 }
 get(id:string):OutboxRequest|undefined {
  const row=this.db.prepare('SELECT * FROM requests WHERE id=?').get(id);if(!row)return undefined;
  const ticket=writeTicketSchema.parse(JSON.parse(String(row['ticket_json']))),command=row['input_json']===null?null:cloudWriteSchema.parse(JSON.parse(String(row['input_json'])));
  if(command&&(hash(canonical(command))!==row['hash']||command.operation!==row['operation']||command.input.idempotency_key!==row['request_key']||ticket.operation!==command.operation))
   throw new MemoryError('invalid_data','Original retained request no longer matches.');
  return {id,command,ticket,state:outboxStateSchema.parse(row['state']),attempts:Number(row['attempts']),next_attempt_at:Number(row['next_attempt_at']),receipt_seen:row['receipt_seen']===1,write_dispatched:row['write_dispatched']===1};
 }
 list(offset=0):JsonObject {
  if(!Number.isSafeInteger(offset)||offset<0||offset>1000)throw new MemoryError('invalid_input','Invalid outbox page.');
  const rows=this.db.prepare('SELECT * FROM requests ORDER BY created_at,id LIMIT 21 OFFSET ?').all(offset);
  return {items:rows.slice(0,20).map(r=>this.status(r)),next_offset:rows.length>20?offset+20:null,claims_verified:false,
   missing_record_count:null,completeness:'retained_requests_only',automatic_replay:false};
 }
 pending(now:number){return this.db.prepare("SELECT id FROM requests WHERE state NOT IN ('saved','blocked') AND next_attempt_at<=? ORDER BY created_at,id LIMIT 3").all(now).map(r=>String(r['id']));}
 claim(id:string,owner:string,now:number){return this.db.prepare("UPDATE requests SET lease_owner=?,lease_until=? WHERE id=? AND state NOT IN ('saved','blocked') AND lease_until<=? AND next_attempt_at<=?")
  .run(owner,now+120000,id,now,now).changes===1;}
 dispatch(id:string,owner:string){
  if(this.db.prepare("UPDATE requests SET state='persistence_unknown',write_dispatched=1,attempts=attempts+1 WHERE id=? AND lease_owner=? AND state!='saved'").run(id,owner).changes!==1)
   throw new MemoryError('lease_lost','Another recovery owns this request.');
 }
 settle(id:string,owner:string,state:OutboxState,code:string|null,next:number,seen:boolean,result?:JsonObject){
  if(result&&Buffer.byteLength(canonical(result))>4096)throw new MemoryError('resource_limit','Receipt summary exceeds local limit.');
  return this.db.prepare(`UPDATE requests SET state=?,last_error=?,next_attempt_at=?,receipt_seen=?,result_json=?,lease_owner=NULL,lease_until=0,
   input_json=CASE WHEN ?='saved' THEN NULL ELSE input_json END WHERE id=? AND lease_owner=? AND state!='saved'`)
   .run(state,code,next,seen?1:0,result?canonical(result):null,state,id,owner).changes===1;
 }
 private listOne(id:string){return this.status(this.db.prepare('SELECT * FROM requests WHERE id=?').get(id)!);}
 private status(r:Record<string,SQLOutputValue>):JsonObject {return {request_id:String(r['id']),operation:String(r['operation']),state:String(r['state']),
  original_input_retained:r['input_json']!==null,local_retained:true,remote_saved:r['state']==='saved',remote_persistence:r['state']==='saved'?'persisted':r['write_dispatched']===1?'unknown':'not_confirmed',receipt_seen:r['receipt_seen']===1,
  attempts:Number(r['attempts']),next_attempt_at:Number(r['next_attempt_at']),last_error:r['last_error']===null?null:String(r['last_error']),
  receipt:r['result_json']===null?null:parseJsonObject(String(r['result_json'])),claims_verified:false};}
}
