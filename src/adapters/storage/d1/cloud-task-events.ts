import { z } from 'zod';
import type { AccessScope,Authentication,Principal } from '../../../core/access/model.js';
import { MemoryError,type JsonObject } from '../../../core/memory/model.js';
import type { D1Binding } from './binding.js';
import { D1TaskEvents } from './task-events.js';
import { D1AtomicCommitStore } from './atomic-store.js';
import { D1ProjectAccess } from './project-access.js';
import { d1EventScopeSchema,receiveEventSchema,linkEventSchema,type D1EventScope } from './event-model.js';
import { canonical } from './query.js';
import { cloudWriteKey } from './cloud-work.js';

export type CloudEventOperation='event-receive'|'event-link';
const keySchema=z.string().trim().min(1).max(200);
function checkScope(result:JsonObject,scope:D1EventScope){
 if(canonical(result['scope'])!==canonical(scope))throw new MemoryError('scope_mismatch','Event receipt scope differs.');
 return result;
}
/** The caller supplies an authorized binding and host-selected root/session; no receive tool exists. */
export class D1CloudTaskEvents {
 private readonly scope:D1EventScope;
 constructor(private readonly db:D1Binding,scope:D1EventScope,private readonly principal:Principal){this.scope=d1EventScopeSchema.parse(structuredClone(scope));}
 private key(operation:CloudEventOperation,key:string){return cloudWriteKey(this.principal,this.scope,operation,keySchema.parse(key));}
 async receive(input:z.input<typeof receiveEventSchema>){
  const i=receiveEventSchema.parse(input),key=await this.key('event-receive',i.idempotency_key);
  return checkScope(await new D1TaskEvents(this.db,this.scope).receive({...i,idempotency_key:key}),this.scope);
 }
 async link(input:z.input<typeof linkEventSchema>,currentAnchor:string|null){
  const i=linkEventSchema.parse(input),key=await this.key('event-link',i.idempotency_key);
  return checkScope(await new D1TaskEvents(this.db,this.scope).link({...i,idempotency_key:key},currentAnchor),this.scope);
 }
 async receipt(operation:CloudEventOperation,key:string){
  const saved=await new D1AtomicCommitStore(this.db,this.scope.project_id).getReceipt(this.scope.project_id,await this.key(operation,key));
  return {found:!!saved,result:saved?checkScope(saved.result,this.scope):null,claims_verified:false};
 }
}

/** A host-selected event channel. Re-authenticate per delivery; this does not install or trust hooks. */
export class CloudEventReceiver {
 private readonly scope:D1EventScope;
 private principal:Principal|undefined;
 constructor(private readonly db:D1Binding,scope:D1EventScope,private readonly authenticate:()=>Promise<Authentication>){
  this.scope=d1EventScopeSchema.parse(structuredClone(scope));
 }
 private async access<T>(action:'read'|'write',operation:(events:D1CloudTaskEvents)=>Promise<T>){
  const auth=await this.authenticate();await auth.assertFresh();const identity=structuredClone(auth.principal);
  if(this.principal&&canonical(this.principal)!==canonical(identity))throw new MemoryError('scope_mismatch','Event receiver principal changed.');
  this.principal??=identity;
  const scope:AccessScope={project_id:this.scope.project_id,repository:this.scope.repository,environment:this.scope.environment};
  const permit=await new D1ProjectAccess(this.db).bind(identity,scope,action,()=>auth.assertFresh(),auth.credential);
  const result=await operation(new D1CloudTaskEvents(permit.binding,this.scope,identity));
  await permit.check();await auth.assertFresh();return result;
 }
 async receive(input:z.input<typeof receiveEventSchema>){
  const i=receiveEventSchema.parse(structuredClone(input));return this.access('write',events=>events.receive(i));
 }
 async receipt(key:string){return this.access('read',events=>events.receipt('event-receive',key));}
}
