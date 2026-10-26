import { z } from 'zod';
import { cloudWriteSchema,type CloudWrite } from '../../core/access/commands.js';
import { RemoteWriteRecovery,validateReceipt } from '../../core/access/remote-recovery.js';
import { RemoteCallError } from '../../core/access/remote-outbox.js';
import { MemoryError,parseJsonObject,type JsonObject } from '../../core/memory/model.js';
import { AccessError } from '../../core/access/model.js';
import { listCloudTools,parseCloudTool } from '../../transport/mcp/cloud-tools.js';
import { SqliteRemoteOutbox } from '../storage/sqlite/remote-outbox.js';
import { CloudMcpConnection } from './cloud-mcp-connection.js';

const temporary=new Set(['connection_failed','connection_timeout','remote_unavailable','authentication_required','invalid_credential','rate_limited','connection_busy']);
const object=(v:unknown):JsonObject=>parseJsonObject(JSON.stringify(v));
export const recoveryInput=z.strictObject({request_ids:z.array(z.uuid()).min(1).max(3).optional()});
/** One explicit host session; no polling, login, source execution or local memory-DB fallback. */
export class RemoteHostSession {
 private connected=false;
 private running:Promise<unknown>|undefined;
 private closed=false;
 private last:JsonObject|null=null;
 private readonly recovery:RemoteWriteRecovery;
 constructor(private readonly store:SqliteRemoteOutbox,private readonly connection:CloudMcpConnection,private readonly enabled:()=>boolean){
  this.recovery=new RemoteWriteRecovery(store,connection,enabled);
 }
 status(offset=0):JsonObject{return {...this.recovery.status(offset),configured:true,scope:object(this.store.destination.scope),recording_enabled:this.enabled(),busy:!!this.running,last_recovery:this.last};}
 private guard=()=>{if(this.closed||!this.enabled())throw new RemoteCallError('recording_disabled');};
 private async connectedHost(){
  this.guard();await this.connection.initialize(this.guard);
  const remote=await this.connection.listTools(this.guard);this.guard();
  if(listCloudTools().some(t=>!remote.some(r=>r.name===t.name)))throw new RemoteCallError('unsupported_capability');
  this.assertScope(await this.connection.call('memory_resolve_project',{},this.guard));
  this.connected=true;
 }
 private assertScope(value:JsonObject){
  const scope=value['scope'],expected=this.store.destination.scope;
  if(!scope||typeof scope!=='object'||Array.isArray(scope)||(['project_id','repository','environment'] as const).some(k=>scope[k]!==expected[k]))throw new RemoteCallError('scope_mismatch');
 }
 private async recoverOriginals(ids?:string[]){
  this.guard();const value=await this.recovery.recover(ids);
  const items=value['results'];
  // Work response bodies are for their original MCP caller, never the status screen.
  this.last={results:Array.isArray(items)?items.map(item=>{
   if(!item||typeof item!=='object'||Array.isArray(item))return null;
   const {result:_,...safe}=item;return safe;
  }):[],claims_verified:false};
  return value;
 }
 recover(input:unknown={}){const selected=recoveryInput.parse(input);return this.exclusive(async()=>{
  await this.recoverOriginals(selected.request_ids);this.connected=false;return this.status();
 });}
 async call(name:string,raw:unknown):Promise<JsonObject|null>{
  const command=parseCloudTool(name,raw,this.store.destination.scope);
  const parsed=cloudWriteSchema.safeParse(command);
  if(parsed.success)return this.exclusive(()=>this.write(parsed.data));
  return this.exclusive(async()=>{
   if(!this.connected){await this.connectedHost();await this.recoverOriginals();}
   this.guard();const result=await this.connection.callValue(name,name==='memory_resolve_project'?{}:{...object(raw),...this.store.destination.scope},this.guard);
   if(name==='memory_resolve_project'){if(!result)throw new RemoteCallError('invalid_response');this.assertScope(result);}
   return result;
  });
 }
 private async write(command:CloudWrite):Promise<JsonObject>{
  this.guard();let id=this.store.find(command);
  if(!id){
   let ticket=this.store.ticket(command.operation);
   try{
    if(!this.connected)await this.connectedHost();
    ticket=await this.recovery.prepare(command.operation);this.guard();this.store.remember(ticket);
   }catch(error){
    this.connected=false;
    if(!(error instanceof RemoteCallError)||!temporary.has(error.code)||!ticket)throw error;
   }
   if(!ticket)throw new RemoteCallError('unsupported_capability');
   this.guard();id=String(this.recovery.enqueue(command,ticket)['request_id']);
  }
  let recovered:JsonObject;
  try{recovered=await this.recoverOriginals([id]);}
  catch{this.connected=false;return {status:'save_unconfirmed',request_id:id,local_retained:true,remote_persistence:'unknown',claims_verified:false};}
  const results=recovered['results'],first=Array.isArray(results)?results[0]:undefined;
  if(first&&typeof first==='object'&&!Array.isArray(first)&&first['state']==='saved'){
   const result=first['result'];if(result&&typeof result==='object'&&!Array.isArray(result))return result;
   // An identical already-saved retry needs the original complete business receipt.
   try{
    const retained=this.store.get(id)!;
    const receipt=await this.connection.call('memory_get_receipt',{...this.store.destination.scope,write_operation:command.operation,
     idempotency_key:command.input.idempotency_key,expected_write_context:retained.ticket.context_id},this.guard);
    const original=receipt['result'];if(receipt['found']===true&&original&&typeof original==='object'&&!Array.isArray(original)){
     validateReceipt(original,command,this.store.destination.scope);
     const expected=this.store.receipt(id);if(!expected)throw new RemoteCallError('invalid_response');
     for(const key of ['record_id','installation_id','assignment_id','skill_key','version','plan_key','update_id','link_id'])if(expected[key]!==undefined&&expected[key]!==original[key])throw new RemoteCallError('invalid_response');
     const run=original['run'];const actualRun=run&&typeof run==='object'&&!Array.isArray(run)?run['id']:original['run_id'];
     if(expected['run_id']!==undefined&&expected['run_id']!==actualRun)throw new RemoteCallError('invalid_response');
     return original;
    }
   }catch{/* Its saved summary remains available; do not invent a replacement task receipt. */}
  }
  this.connected=false;
  const stored=this.store.get(id),saved=stored?.state==='saved';
  return {status:saved?'saved_response_unavailable':'save_unconfirmed',request_id:id,local_retained:true,remote_persistence:saved?'persisted':stored?.write_dispatched?'unknown':'not_confirmed',
   recovery:this.last,claims_verified:false,completeness:'retained_requests_only'};
 }
 private exclusive<T>(work:()=>Promise<T>):Promise<T>{
  this.guard();if(this.running)throw new RemoteCallError('host_busy');
  const job=work();this.running=job;
  return job.finally(()=>{this.running=undefined;});
 }
 async close(){if(this.closed)return;this.closed=true;await this.running?.catch(()=>{});this.store.close();}
}
export function remoteHostError(error:unknown):JsonObject {
 const code=error instanceof RemoteCallError||error instanceof MemoryError?error.code:error instanceof AccessError?'access_denied':error instanceof z.ZodError?'invalid_input':'host_unavailable';
 return {status:'not_retained',local_retained:false,claims_verified:false,error:{code,message:'저장을 확인하지 못했습니다. 원격 저장 상태에서 보관 여부를 확인해 주세요.'}};
}
