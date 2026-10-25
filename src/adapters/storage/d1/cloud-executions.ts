import { z } from 'zod';
import { accessScopeSchema,type AccessScope,type Authentication,type Principal } from '../../../core/access/model.js';
import type { ExecutionSink,ExecutionStart,ExecutionResult } from '../../../core/execution/recording.js';
import type { TestDetails } from '../../../core/execution/test-details.js';
import type { SourceObservation } from '../../../core/execution/currentness.js';
import { MemoryError,type JsonObject } from '../../../core/memory/model.js';
import type { D1Binding } from './binding.js';
import { D1Executions } from './executions.js';
import { D1AtomicCommitStore } from './atomic-store.js';
import { D1ProjectAccess } from './project-access.js';
import { cloudWriteKey } from './cloud-work.js';
import { executionFinishSchema } from './execution-mutation.js';
import { canonical } from './query.js';

export type CloudExecutionOperation='execution-start'|'execution-finish';
const requestKey=z.string().trim().min(1).max(200);
function checkScope(result:JsonObject,scope:AccessScope){
 if(canonical(result['scope'])!==canonical(scope))throw new MemoryError('scope_mismatch','Receipt scope differs.');
 return result;
}
/** The caller supplies an already authorized, guarded binding. No raw receipt keys are public. */
export async function cloudExecutionReceipt(db:D1Binding,scope:AccessScope,principal:Principal,operation:CloudExecutionOperation,key:string){
 const receipt=await new D1AtomicCommitStore(db,scope.project_id).getReceipt(scope.project_id,await cloudWriteKey(principal,scope,operation,requestKey.parse(key)));
 return {found:!!receipt,result:receipt?checkScope(receipt.result,scope):null,claims_verified:false};
}

/** One host-authorized command only. Never register this sink or its DTOs as AI tools.
 * Authentication is renewed per storage operation, not retained from an HTTP request lifetime. */
export class CloudExecutionCollector implements ExecutionSink {
 private readonly scope:AccessScope;
 private readonly key:string;
 private principal:Principal|undefined;
 private started=false;
 private id:string|undefined;
 private pending:z.infer<typeof executionFinishSchema>|undefined;
 constructor(private readonly db:D1Binding,scope:AccessScope,private readonly authenticate:()=>Promise<Authentication>,key:string){
  this.scope=accessScopeSchema.parse(structuredClone(scope));this.key=requestKey.parse(key);
 }
 private async access<T>(action:'read'|'write',operation:(db:D1Binding,auth:Authentication)=>Promise<T>):Promise<T>{
  const auth=await this.authenticate();await auth.assertFresh();
  const identity=structuredClone(auth.principal);
  if(this.principal&&canonical(this.principal)!==canonical(identity))throw new MemoryError('scope_mismatch','Collector principal changed.');
  this.principal??=identity;
  const permit=await new D1ProjectAccess(this.db).bind(identity,this.scope,action,()=>auth.assertFresh(),auth.credential);
  const result=await operation(permit.binding,auth);
  await permit.check();await auth.assertFresh();return result;
 }
 async start(input:ExecutionStart):Promise<string>{
  if(this.started)throw new MemoryError('execution_already_started','This collector is single-use. Inspect receipts; never replay the command.');
  this.started=true;
  if(input.project_id!==this.scope.project_id)throw new MemoryError('scope_mismatch','Collector project differs.');
  const {project_id,...data}=structuredClone(input);
  const result=await this.access('write',async(db,auth)=>{
   const key=await cloudWriteKey(auth.principal,this.scope,'execution-start',this.key);
   return checkScope(await new D1Executions(db,this.scope).startForProcess({...data,idempotency_key:key}),this.scope);
  });
  this.id=z.uuid().parse(result['execution_id']);return this.id;
 }
 async finish(id:string,result:ExecutionResult,details?:TestDetails,after?:SourceObservation):Promise<void>{
  if(!this.id||id!==this.id)throw new MemoryError('scope_mismatch','Only this collector execution can be finished.');
  const input=executionFinishSchema.parse(structuredClone({execution_id:id,idempotency_key:this.key,result,
   ...(details?{details}:{}),...(after?{source_after:after}:{})}));
  if(this.pending&&canonical(this.pending)!==canonical(input))throw new MemoryError('idempotency_conflict','Retry only the original finish observation.');
  this.pending??=input;await this.retryFinish();
 }
 /** Retains one bounded DTO in this process only; no durable/offline queue and no command replay. */
 async retryFinish():Promise<void>{
  const input=this.pending;if(!input)throw new MemoryError('not_found','No retained finish observation.');
  await this.access('write',async(db,auth)=>{
   const key=await cloudWriteKey(auth.principal,this.scope,'execution-finish',this.key);
   checkScope(await new D1Executions(db,this.scope).finish({...input,idempotency_key:key}),this.scope);
  });
 }
 async receipt(operation:CloudExecutionOperation){
  return this.access('read',(db,auth)=>cloudExecutionReceipt(db,this.scope,auth.principal,operation,this.key));
 }
}
