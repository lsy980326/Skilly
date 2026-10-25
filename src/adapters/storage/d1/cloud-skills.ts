import { z } from 'zod';
import type { AccessScope,Authentication,Principal } from '../../../core/access/model.js';
import { cloudSkillWriteSchema,type CloudWrite } from '../../../core/access/commands.js';
import { inspectSkillSchema } from '../../../core/skills/operations.js';
import { MemoryError,type JsonObject } from '../../../core/memory/model.js';
import { skillScopeSchema,type D1SkillObserver,type D1SkillScope } from './skill-model.js';
import { D1Skills } from './skills.js';
import { D1AtomicCommitStore } from './atomic-store.js';
import { D1ProjectAccess } from './project-access.js';
import { cloudWriteKey } from './cloud-work.js';
import { canonical } from './query.js';
import type { D1Binding } from './binding.js';

/** Host-owned mapping, independent of lifecycle hooks. Never populated from MCP arguments. */
export type CloudSkillContextProvider=(scope:Readonly<AccessScope>,principal:Readonly<Principal>)=>{root_hash:string}|undefined;
export function resolveCloudSkillScope(provider:CloudSkillContextProvider|undefined,scope:AccessScope,principal:Principal):D1SkillScope {
 const context=provider?.(Object.freeze({...scope}),Object.freeze({...principal}));
 if(!context)throw new MemoryError('unsupported_capability','This host has no skill root binding; the connection may still be healthy.');
 return skillScopeSchema.parse({...scope,root_hash:context.root_hash});
}
export type CloudSkillOperation='skill-register'|'skill-assign'|'skill-checkpoint'|'skill-inspect';
function check(result:JsonObject,scope:D1SkillScope){
 if(canonical(result['scope'])!==canonical(scope))throw new MemoryError('scope_mismatch','Receipt scope differs.');
 return result;
}
/** Remote keys cannot alias host keys or another principal/root/operation. */
export class D1CloudSkills {
 constructor(private readonly db:D1Binding,private readonly scope:D1SkillScope,private readonly principal:Principal){}
 async write(command:Extract<CloudWrite,{operation:'skill-register'|'skill-assign'|'skill-checkpoint'}>){
  const c=cloudSkillWriteSchema.parse(command),idempotency_key=await cloudWriteKey(this.principal,this.scope,c.operation,c.input.idempotency_key);
  const skills=new D1Skills(this.db,this.scope);
  const result=c.operation==='skill-register'?await skills.register({...c.input,idempotency_key})
   :c.operation==='skill-assign'?await skills.assign({...c.input,idempotency_key}):await skills.checkpoint({...c.input,idempotency_key});
  return check(result,this.scope);
 }
 /** Host-only observation boundary; never registered as an MCP tool. */
 async inspect(raw:z.input<typeof inspectSkillSchema>,observer:D1SkillObserver){
  const input=inspectSkillSchema.parse(raw),idempotency_key=await cloudWriteKey(this.principal,this.scope,'skill-inspect',input.idempotency_key);
  return check(await new D1Skills(this.db,this.scope,observer).inspect({...input,idempotency_key}),this.scope);
 }
 async receipt(operation:CloudSkillOperation,key:string){
  const receipt=await new D1AtomicCommitStore(this.db,this.scope.project_id).getReceipt(this.scope.project_id,
   await cloudWriteKey(this.principal,this.scope,operation,z.string().min(1).max(128).parse(key)));
  return {found:!!receipt,result:receipt?check(receipt.result,this.scope):null,claims_verified:false};
 }
}

/** An explicit host action with fresh authentication per call. It neither installs nor executes files. */
export class CloudSkillInspector {
 private readonly scope:D1SkillScope;
 private principal:Principal|undefined;
 constructor(private readonly db:D1Binding,scope:D1SkillScope,private readonly authenticate:()=>Promise<Authentication>,private readonly observer:D1SkillObserver){
  this.scope=skillScopeSchema.parse(structuredClone(scope));
  if(observer.root_hash!==this.scope.root_hash)throw new MemoryError('scope_mismatch','Observer root differs.');
 }
 async inspect(input:z.input<typeof inspectSkillSchema>){
  const auth=await this.authenticate();await auth.assertFresh();const identity=structuredClone(auth.principal);
  if(this.principal&&canonical(this.principal)!==canonical(identity))throw new MemoryError('scope_mismatch','Inspector principal changed.');
  this.principal??=identity;
  const {project_id,repository,environment}=this.scope;
  const permit=await new D1ProjectAccess(this.db).bind(identity,{project_id,repository,environment},'write',()=>auth.assertFresh(),auth.credential);
  const result=await new D1CloudSkills(permit.binding,this.scope,identity).inspect(input,this.observer);
  await permit.check();await auth.assertFresh();return result;
 }
}
