import { z } from 'zod';
import type { AccessScope } from './model.js';
import { cloudWriteSchema,type CloudWrite } from './commands.js';
import { remoteWriteTools,writeTicketSchema,RemoteCallError,type RemoteMcpConnection,type RemoteOutboxStore,type WriteTicket,type OutboxState } from './remote-outbox.js';
import { MemoryError,parseJsonObject,type JsonObject } from '../memory/model.js';

const permanent=new Set(['write_context_changed','invalid_input','invalid_data','idempotency_conflict','conflict','plan_conflict','assignment_conflict',
 'source_conflict','version_conflict','stale_anchor','task_finished','run_closed','project_write_blocked','scope_mismatch','unsupported_capability','resource_limit','completion_conditions_missing','invalid_evidence','not_found','link_conflict']);
/** Explicit host-owned cycle. Never polls, logs into accounts, replays commands or switches destinations. */
export class RemoteWriteRecovery {
 constructor(private readonly store:RemoteOutboxStore,private readonly connection:RemoteMcpConnection,private readonly enabled:()=>boolean,private readonly now=()=>Date.now(),private readonly cycleTimeoutMs=30000){
  if(!Number.isSafeInteger(cycleTimeoutMs)||cycleTimeoutMs<25||cycleTimeoutMs>60000)throw new MemoryError('invalid_input','Invalid recovery cycle deadline.');
  if(store.destination.endpoint!==connection.destination.endpoint||(['project_id','repository','environment'] as const).some(k=>store.destination.scope[k]!==connection.destination.scope[k]))throw new MemoryError('scope_mismatch','Connection differs from the retained destination.');
 }
 private guard=()=>{if(!this.enabled())throw new RemoteCallError('recording_disabled');};
 async prepare(operation:CloudWrite['operation']):Promise<WriteTicket>{
  const deadline=performance.now()+this.cycleTimeoutMs,guard=()=>{this.guard();if(performance.now()>=deadline)throw new RemoteCallError('recovery_timeout');};
  guard();await this.connection.initialize(guard,deadline);guard();
  const raw=await this.connection.call('memory_get_write_context',{...this.store.destination.scope,write_operation:operation},guard,deadline);guard();
  const ticket=writeTicketSchema.parse({operation:raw['operation'],context_id:raw['context_id']});
  if(ticket.operation!==operation)throw new RemoteCallError('invalid_response');return ticket;
 }
 enqueue(command:CloudWrite,ticket:WriteTicket){this.guard();return this.store.retain(cloudWriteSchema.parse(command),ticket);}
 async submit(command:CloudWrite,ticket:WriteTicket){const receipt=this.enqueue(command,ticket);return this.recover([String(receipt['request_id'])]);}
 status(offset=0){return this.store.list(offset);}
 async recover(ids?:string[]):Promise<JsonObject>{
  const deadline=performance.now()+this.cycleTimeoutMs,guard=()=>{this.guard();if(performance.now()>=deadline)throw new RemoteCallError('recovery_timeout');};
  guard();const selected=ids??this.store.pending(this.now());
  if(selected.length>3||selected.some(id=>!id))throw new MemoryError('invalid_input','One recovery cycle accepts at most three retained request IDs.');
  const results:JsonObject[]=[];
  for(const id of selected){
   guard();const original=this.store.get(id);if(!original)throw new MemoryError('not_found','Original request was not retained.');
   if(original.state==='saved'){results.push({request_id:id,state:'saved',claims_verified:false});continue;}
   if(!original.command||original.state==='blocked')continue;
   const owner=crypto.randomUUID();if(!this.store.claim(id,owner,this.now()))continue;
   let seen=original.receipt_seen,dispatched=original.write_dispatched;
   try{
    await this.connection.initialize(guard,deadline);guard();
    const scope=this.store.destination.scope,command=original.command;
    const receipt=await this.connection.call('memory_get_receipt',{...scope,write_operation:command.operation,idempotency_key:command.input.idempotency_key,
     expected_write_context:original.ticket.context_id},guard,deadline);guard();
    if(typeof receipt['found']!=='boolean')throw new RemoteCallError('invalid_response');seen=seen||receipt['found'];
    // A found key alone does not prove this input. Replay the original write so the server checks its payload hash.
    this.store.dispatch(id,owner);dispatched=true;guard();
    const value=await this.connection.call(remoteWriteTools[command.operation],parseJsonObject(JSON.stringify({...command.input,...scope,expected_write_context:original.ticket.context_id})),guard,deadline);
    guard();validateReceipt(value,command,scope);
    const summary:JsonObject={status:'persisted',claims_verified:false};
    for(const key of ['run_id','record_id','installation_id','assignment_id','skill_key','version','plan_key','update_id','link_id']){
     const v=value[key];if(typeof v==='string'&&v.length<=200||typeof v==='number'&&Number.isSafeInteger(v))summary[key]=v;
    }
    const run=value['run'];if(run&&typeof run==='object'&&!Array.isArray(run)&&typeof run['id']==='string')summary['run_id']=run['id'];
    if(!this.store.settle(id,owner,'saved',null,0,true,summary))results.push({request_id:id,state:'association_unconfirmed',claims_verified:false});
    else results.push({request_id:id,state:'saved',receipt:summary,result:value,claims_verified:false});
   }catch(e){
    if(!this.enabled()){results.push({request_id:id,state:'recording_disabled',remote_persistence:dispatched?'unknown':'not_confirmed',claims_verified:false});break;}
    const code=e instanceof RemoteCallError||e instanceof MemoryError?e.code:'local_ack_unconfirmed';
    const auth=e instanceof RemoteCallError&&(e.status===401||e.code==='authentication_required'),denied=e instanceof RemoteCallError&&(e.status===403||e.code==='access_denied');
    const state:OutboxState=auth?'auth_required':denied?'access_denied':permanent.has(code)?'blocked':dispatched?'persistence_unknown':'recovery_pending';
    const next=auth||denied||state==='blocked'?0:this.now()+Math.max(1000,Math.min(60000,e instanceof RemoteCallError?e.retryAfterMs:1000));
    let retained=false;try{retained=this.store.settle(id,owner,state,code,next,seen);}catch{/* Keep the pre-dispatch durable state; never claim the local acknowledgement succeeded. */}
    results.push({request_id:id,state:retained?state:'association_unconfirmed',last_error:code,saved_confirmed:false,remote_persistence:dispatched?'unknown':'not_confirmed',receipt_seen:seen,claims_verified:false});
    break;
   }
  }
  return {results,claims_verified:false,automatic_replay:false,missing_record_count:null,completeness:'retained_requests_only'};
 }
}

/** Validate the business receipt, not merely a well-formed JSON-RPC success envelope. */
export function validateReceipt(value:JsonObject,command:CloudWrite,scope:AccessScope){
 const s=value['scope'],uuid=(v:unknown)=>z.uuid().safeParse(v).success;
 const fail=()=>{throw new RemoteCallError('invalid_response');};
 if(value['status']!=='persisted'||value['claims_verified']!==false||!s||typeof s!=='object'||Array.isArray(s)
  ||s['project_id']!==scope.project_id||s['repository']!==scope.repository||s['environment']!==scope.environment)fail();
 switch(command.operation){
  case 'begin':{const run=value['run'];if(!run||typeof run!=='object'||Array.isArray(run)||!uuid(run['id'])||run['project_id']!==scope.project_id
    ||run['repository']!==scope.repository||run['environment']!==scope.environment||run['goal']!==command.input.goal)fail();break;}
  case 'checkpoint':case 'finish':if(!uuid(value['record_id'])||value['run_id']!==command.input.run_id)fail();break;
  case 'skill-checkpoint':if(!uuid(value['record_id']))fail();break;
  case 'event-link':if(!uuid(value['link_id'])||value['run_id']!==command.input.run_id)fail();break;
  case 'skill-register':if(value['skill_key']!==command.input.skill_key||value['version']!==command.input.version||!z.string().regex(/^[a-f0-9]{64}$/).safeParse(value['content_hash']).success)fail();break;
  case 'skill-assign':if(!uuid(value['installation_id'])||!uuid(value['assignment_id'])||value['version']!==command.input.version)fail();break;
  case 'save-plan':if(value['plan_key']!==command.input.plan_key||value['version']!==command.input.expected_version+1)fail();break;
  case 'update-plan':if(!uuid(value['update_id'])||value['plan_key']!==command.input.plan_key||value['version']!==command.input.version||value['item_key']!==command.input.item_key)fail();break;
 }
}
