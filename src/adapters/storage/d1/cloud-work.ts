import { z } from 'zod';
import type { Principal,AccessScope } from '../../../core/access/model.js';
import { cloudWriteSchema,type CloudWrite } from '../../../core/access/commands.js';
import { commitWithReceipt,type AtomicCommitStore,type PreparedChange } from '../../../core/memory/atomic-commit.js';
import { MemoryError,type JsonObject,type Run } from '../../../core/memory/model.js';
import { D1AtomicCommitStore } from './atomic-store.js';
import type { D1Binding } from './binding.js';
import { canonical,hashText,json,rows } from './query.js';

const projectSchema=z.object({id:z.uuid(),project_key:z.string(),name:z.string(),revision:z.int().nonnegative(),created_at:z.iso.datetime()});
const runSchema=z.object({id:z.uuid(),project_id:z.uuid(),goal:z.string(),mode:z.enum(['answer','diagnose','review','change']),environment:z.string(),repository:z.string(),
 state:z.enum(['active','completed','interrupted']),created_at:z.iso.datetime(),updated_at:z.iso.datetime(),actor:z.string().nullable()});
/** Bounded ordinary reports only. Observations, provisioning and transfer remain host-only. */
export class D1CloudWork {
 private readonly store:AtomicCommitStore;
 constructor(private readonly db:D1Binding,private readonly scope:AccessScope,private readonly principal:Principal){
  const raw=new D1AtomicCommitStore(db,scope.project_id);
  this.store={commit:m=>raw.commit(m),getReceipt:async(s,k)=>{const r=await raw.getReceipt(s,k);if(r&&canonical(r.result['scope'])!==canonical(scope))throw new MemoryError('scope_mismatch','Receipt scope differs.');return r;}};
 }
 private async key(operation:string,key:string){return 'cloud:'+await hashText(canonical({principal:this.principal,scope:this.scope,operation,key}));}
 async receipt(operation:CloudWrite['operation'],key:string){const r=await this.store.getReceipt(this.scope.project_id,await this.key(operation,key));return {found:!!r,result:r?.result??null,claims_verified:false};}
 async write(command:CloudWrite):Promise<JsonObject>{
  const c=cloudWriteSchema.parse(command),key=await this.key(c.operation,c.input.idempotency_key),hash=await hashText(canonical({scope:this.scope,principal:this.principal,command:c}));
  return commitWithReceipt(this.store,this.scope.project_id,key,hash,async():Promise<PreparedChange>=>{
   const [row]=await rows(this.db,'SELECT * FROM projects WHERE id=?',[this.scope.project_id],1);if(!row)throw new MemoryError('not_found','Project is unavailable.');
   const p=projectSchema.parse(row),at=new Date().toISOString();
   const base={project:{id:p.id,key:p.project_key,name:p.name,revision:p.revision+1,created_at:p.created_at},expected_revision:p.revision};
   if(c.operation==='begin'){
    const id=crypto.randomUUID(),i=c.input,run:Run={id,project_id:p.id,goal:i.goal,mode:i.mode,repository:this.scope.repository,environment:this.scope.environment,state:'active',created_at:at,updated_at:at,...(i.actor?{actor:i.actor}:{})};
    return {...base,run,work:{run_id:id,...(i.title?{title:i.title}:{}),...(i.branch?{branch:i.branch}:{}),...(i.components?{components:i.components}:{}),...(i.features?{features:i.features}:{})},
     result:{status:'persisted',run:json(run),scope:json(this.scope),claims_verified:false,provenance:'agent_report'}};
   }
   const i=c.input,[rowRun]=await rows(this.db,`SELECT r.*,a.actor FROM runs r LEFT JOIN run_actors a ON a.run_id=r.id
    WHERE r.project_id=? AND r.id=? AND r.repository=? AND r.environment=?`,[p.id,i.run_id,this.scope.repository,this.scope.environment],1);
   if(!rowRun)throw new MemoryError('not_found','Task is unavailable.');const parsed=runSchema.parse(rowRun);
   if(parsed.state!=='active')throw new MemoryError('task_finished','Task is no longer active.');
   const {actor,...r}=parsed,run:Run={...r,updated_at:at,state:c.operation==='finish'?c.input.outcome:'active',...(actor?{actor}:{})},id=crypto.randomUUID();
   const record={id,project_id:p.id,run_id:r.id,topic:c.operation==='finish'?'task-summary':c.input.topic,kind:c.operation==='finish'?'summary' as const:c.input.kind,
    body:c.operation==='finish'?c.input.summary:c.input.body,repository:this.scope.repository,environment:this.scope.environment,source_fingerprint:null,
    observed_at:at,recorded_at:at,supersedes:null,superseded_by:null,report_origin:c.operation==='checkpoint'?c.input.report_origin??'contemporaneous':'contemporaneous' as const};
   return {...base,run,record,...(i.report?{work:{run_id:r.id,record_id:id,report:i.report}}:{}),
    result:{status:'persisted',record_id:id,run_id:r.id,scope:json(this.scope),claims_verified:false,provenance:'agent_report'}};
  });
 }
}
