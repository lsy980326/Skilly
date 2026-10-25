import { cloudPlanWriteSchema,type CloudWrite } from '../../../core/access/commands.js';
import type { Principal,AccessScope } from '../../../core/access/model.js';
import { MemoryError } from '../../../core/memory/model.js';
import type { D1Binding } from './binding.js';
import { D1Plans } from './plans.js';
import { D1AtomicCommitStore } from './atomic-store.js';
import { cloudWriteKey } from './cloud-work.js';
import { canonical } from './query.js';

/** Keep the host's plan API unchanged; only remote receipts use principal/scope/operation keys. */
export class D1CloudPlans {
 constructor(private readonly db:D1Binding,private readonly scope:AccessScope,private readonly principal:Principal){}
 async write(command:Extract<CloudWrite,{operation:'save-plan'|'update-plan'}>){
  const c=cloudPlanWriteSchema.parse(command),key=await cloudWriteKey(this.principal,this.scope,c.operation,c.input.idempotency_key);
  const plans=new D1Plans(this.db,this.scope);
  const result=await (c.operation==='save-plan'?plans.save({...c.input,idempotency_key:key}):plans.update({...c.input,idempotency_key:key}));
  if(canonical(result['scope'])!==canonical(this.scope))throw new MemoryError('scope_mismatch','Receipt scope differs.');
  return result;
 }
 async receipt(operation:'save-plan'|'update-plan',key:string){
  const receipt=await new D1AtomicCommitStore(this.db,this.scope.project_id).getReceipt(this.scope.project_id,await cloudWriteKey(this.principal,this.scope,operation,key));
  if(receipt&&canonical(receipt.result['scope'])!==canonical(this.scope))throw new MemoryError('scope_mismatch','Receipt scope differs.');
  return {found:!!receipt,result:receipt?.result??null,claims_verified:false};
 }
}
