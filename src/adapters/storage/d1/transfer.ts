import { z } from 'zod';
import { MemoryError } from '../../../core/memory/model.js';
import { rows,json } from './query.js';
import { d1WriteAuthority } from './authority.js';
import { storeIdentity,transferBatch,assertSql,transferFail,exportD1Project,importD1Project,openImported,transferView } from './transfer-store.js';
import type { D1Binding } from './binding.js';
const operationSchema=z.strictObject({id:z.uuid(),project_id:z.uuid(),project_key:z.string(),source_store_id:z.string(),target_store_id:z.string(),return_store_id:z.string().nullable(),
 generation:z.int().positive(),phase:z.enum(['preparing','prepared','activating','active','aborting','aborted','recovering','returned']),activation_intent:z.union([z.literal(0),z.literal(1)]),created_at:z.string()});
type Operation=z.infer<typeof operationSchema>;

/** Trusted host coordinator for explicitly supplied local bindings. No network or configuration access. */
export class D1ProjectTransfer {
 constructor(private readonly source:D1Binding,private readonly target:D1Binding,private readonly projectId:string){z.uuid().parse(projectId);}
 private async operation(id:string) {
  z.uuid().parse(id);const [row]=await rows(this.source,'SELECT * FROM d1_transfer_operations WHERE id=? AND project_id=?',[id,this.projectId],1);
  if(!row)throw new MemoryError('not_found','Transfer operation absent.');const op=operationSchema.parse(row);
  if(op.source_store_id!==await storeIdentity(this.source)||op.target_store_id!==await storeIdentity(this.target))transferFail('Transfer store identities changed. Nothing opened.');return op;
 }
 private async phase(op:Operation,phase:Operation['phase'],intent=op.activation_intent) {
  await transferBatch(this.source,sql=>{
   sql('UPDATE d1_transfer_operations SET phase=?,activation_intent=? WHERE id=? AND phase=? AND activation_intent=?',phase,intent,op.id,op.phase,op.activation_intent);
   assertSql(sql,'changes()=1');
  });return this.operation(op.id);
 }
 async status(id:string,returned?:D1Binding) {
  const op=await this.operation(id);
  if(returned&&await storeIdentity(returned)!==op.return_store_id)transferFail('Return store differs from the saved selection.');
  return transferView(json({...op,copies:{source:await d1WriteAuthority(this.source,this.projectId),target:await d1WriteAuthority(this.target,this.projectId),
   returned:returned?await d1WriteAuthority(returned,this.projectId):null},state_is_not_a_work_receipt:true}));
 }
 async prepare(id:string,expectedGeneration:number) {
  z.uuid().parse(id);if(!Number.isSafeInteger(expectedGeneration)||expectedGeneration<0)throw new MemoryError('invalid_input','Explicit source generation required.');
  const sourceId=await storeIdentity(this.source),targetId=await storeIdentity(this.target);if(sourceId===targetId)transferFail('Source and target must differ.');
  const [prior]=await rows(this.source,'SELECT * FROM d1_transfer_operations WHERE project_id=?',[this.projectId],1);
  let op:Operation;
  if(prior){op=await this.operation(id);if(op.generation!==expectedGeneration+1)transferFail('Preserve the original prepare generation.');}
  else {
   const [p]=await rows(this.source,'SELECT project_key FROM projects WHERE id=?',[this.projectId],1);if(!p)throw new MemoryError('not_found','Source project absent.');
   const [target]=await rows(this.target,'SELECT id FROM projects LIMIT 1',[],1);if(target)transferFail('Import requires an empty business DB. Existing data retained.');
   await transferBatch(this.source,sql=>{
    assertSql(sql,`NOT EXISTS(SELECT 1 FROM d1_transfer_operations WHERE project_id=?) AND
     coalesce((SELECT state='writable' AND generation=? FROM d1_project_authority WHERE project_id=?),?=0)
     AND NOT EXISTS(SELECT 1 FROM executions WHERE project_id=? AND ended_at IS NULL)`,this.projectId,expectedGeneration,this.projectId,expectedGeneration,this.projectId);
    sql(`INSERT INTO d1_transfer_operations VALUES(?,?,?,?,?,NULL,?,'preparing',0,?)`,id,this.projectId,String(p['project_key']),sourceId,targetId,expectedGeneration+1,new Date().toISOString());
    sql(`INSERT INTO d1_project_authority VALUES(?,?,?,?,'source','blocked',0,NULL,?) ON CONFLICT(project_id) DO UPDATE SET
     transfer_id=excluded.transfer_id,generation=excluded.generation,role='source',state='blocked',ever_opened=0,bundle_hash=NULL,updated_at=excluded.updated_at`,
     this.projectId,String(p['project_key']),id,expectedGeneration+1,new Date().toISOString());
   });op=await this.operation(id);
  }
  if(op.phase==='preparing') {
   const bundle=await exportD1Project(this.source,this.projectId);
   await importD1Project(this.target,bundle,{transfer_id:id,generation:op.generation,role:'target'});
   await this.phase(op,'prepared');
  }else if(op.phase!=='prepared')transferFail('This operation cannot be prepared again. Read status.');
  return this.status(id);
 }
 async activate(id:string) {
  let op=await this.operation(id);
  if(op.phase==='prepared')op=await this.phase(op,'activating',1); // Durable before any target open.
  if(op.phase!=='activating'&&op.phase!=='active')transferFail('Activation was superseded; recover or inspect the same operation.');
  const a=await d1WriteAuthority(this.source,this.projectId);
  if(a['write_allowed']!==false||a['transfer_id']!==id||a['generation']!==op.generation)transferFail('Original source fence changed.');
  await openImported(this.target,this.projectId,id,op.generation,'target');
  if(op.phase==='activating')await this.phase(op,'active');return this.status(id);
 }
 async recover(id:string,returned?:D1Binding) {
  let op=await this.operation(id);
  if(['preparing','prepared'].includes(op.phase))op=await this.phase(op,'aborting');
  else if(['activating','active'].includes(op.phase))op=await this.phase(op,'recovering',1);
  if(op.phase==='aborted')return this.status(id);
  if(op.phase==='returned'){
   if(!returned)transferFail('Supply the saved return binding.');
   await this.checkReturn(op,returned);return this.status(id,returned);
  }
  if(op.phase!=='aborting'&&op.phase!=='recovering')transferFail('No recovery transition is allowed.');
  // Increment target fencing epoch BEFORE export/opening any return. A delayed
  // activate holding the old epoch can never reopen this target afterwards.
  await transferBatch(this.target,sql=>{
   assertSql(sql,`NOT EXISTS(SELECT 1 FROM executions WHERE project_id=? AND ended_at IS NULL) AND
    (NOT EXISTS(SELECT 1 FROM projects WHERE id=?) OR EXISTS(SELECT 1 FROM d1_project_authority WHERE project_id=? AND transfer_id=? AND role='target' AND generation IN (?,?)))`,
    this.projectId,this.projectId,this.projectId,id,op.generation,op.generation+1);
   sql("UPDATE d1_project_authority SET state='blocked',generation=?,updated_at=? WHERE project_id=? AND transfer_id=? AND role='target'",op.generation+1,new Date().toISOString(),this.projectId,id);
  });
  if(op.phase==='aborting') {
   await transferBatch(this.source,sql=>{
    assertSql(sql,"EXISTS(SELECT 1 FROM d1_transfer_operations WHERE id=? AND phase='aborting' AND activation_intent=0)",id);
    sql("UPDATE d1_project_authority SET state='writable',generation=?,ever_opened=1,updated_at=? WHERE project_id=? AND transfer_id=? AND role='source' AND generation IN (?,?)",op.generation+1,new Date().toISOString(),this.projectId,id,op.generation,op.generation+1);assertSql(sql,'changes()=1');
    sql("UPDATE d1_transfer_operations SET phase='aborted' WHERE id=?",id);
   });return this.status(id);
  }
  if(!returned)transferFail('Recovery after activation requires an explicit fresh return binding. Both old stores remain fenced.');
  const returnId=await storeIdentity(returned);if([op.source_store_id,op.target_store_id].includes(returnId))transferFail('Return must be a third distinct store.');
  await transferBatch(this.source,sql=>{
   sql("UPDATE d1_transfer_operations SET return_store_id=? WHERE id=? AND phase='recovering' AND (return_store_id IS NULL OR return_store_id=?)",returnId,id,returnId);assertSql(sql,'changes()=1');
  });op=await this.operation(id);
  const bundle=await exportD1Project(this.target,this.projectId);
  await importD1Project(returned,bundle,{transfer_id:id,generation:op.generation+1,role:'return'});
  await this.checkReturn(op,returned,false);
  await openImported(returned,this.projectId,id,op.generation+1,'return');
  await this.phase(op,'returned');return this.status(id,returned);
 }
 private async checkReturn(op:Operation,returned:D1Binding,opened=true) {
  if(await storeIdentity(returned)!==op.return_store_id)transferFail('Return selection is immutable.');
  for(const db of [this.source,this.target]){const a=await d1WriteAuthority(db,this.projectId);if(a['write_allowed']!==false||a['transfer_id']!==op.id)transferFail('An old store is not fenced.');}
  const a=await d1WriteAuthority(returned,this.projectId);if(a['transfer_id']!==op.id||a['generation']!==op.generation+1||a['role']!=='return'||(opened&&a['write_allowed']!==true))transferFail('Return authority differs.');
 }
}
