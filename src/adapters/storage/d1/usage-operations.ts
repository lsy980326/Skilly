import { z } from 'zod';
import { MemoryError, type JsonObject } from '../../../core/memory/model.js';
import type { D1Binding, D1Statement } from './binding.js';
import { canonical, hashText, rows, bounded } from './query.js';
import { usagePolicySchema, usageDay, usageKeys } from './usage-model.js';
import { assertOperation, appendCompletion, savedCompletion, type SavedUsage } from './usage-ledger.js';

const keySchema=z.string().min(1).max(120).regex(/^[a-zA-Z0-9._:-]+$/);
const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
const reasonSchema=z.string().trim().min(1).max(500);
const policyOptions=z.strictObject({reason:reasonSchema,expected_hash:hashSchema,idempotency_key:keySchema});
const recoveryOptions=z.strictObject({expected_hash:hashSchema,idempotency_key:keySchema});
const counterSchema=z.object({bucket:z.string(),day:z.int(),requests:z.int().nonnegative(),batches:z.int().nonnegative(),
 rows_read:z.int().nonnegative(),rows_written:z.int().nonnegative(),blocked:z.union([z.literal(0),z.literal(1)])});
const targetSchema=z.object({id:z.uuid(),day:z.int(),user_bucket:z.string().nullable(),state:z.enum(['held','uncertain','settled']),
 write_bytes:z.int().nonnegative(),observed_json:z.string().nullable(),policy_json:z.string().nullable(),revision:z.int().nullable(),
 pending:z.int().nullable(),stopped:z.int().nullable(),completion_json:z.string().nullable(),resolution_json:z.string().nullable()});
const captureSchema=z.object({database_id:z.string().regex(/^[a-f0-9]{32}$/),revision:z.int().nonnegative(),policy_version:z.int().positive(),
 body:z.string(),storage:z.int().nonnegative(),counters_json:z.string(),target_json:z.string().nullable(),legacy_held:z.int().nonnegative()});
const listRowSchema=z.object({id:z.uuid(),day:z.int(),state:z.enum(['held','uncertain']),created_at:z.iso.datetime(),
 pending:z.int().nullable(),completion_json:z.string().nullable(),policy_version:z.int().nullable()});

/** Privileged host API only. No HTTP/MCP provisioning, caller usage totals, or business replay. */
export class D1UsageOperations {
 constructor(private readonly db:D1Binding,private readonly now:()=>number=Date.now) {}
 async capture(id:string|null=null) {
  const day=usageDay(this.now());
  let raw;
  try{[raw]=await rows(this.db,`SELECT c.database_id,c.revision,c.policy_version,v.body,
   (SELECT accepted_write_bytes FROM cloud_usage_storage WHERE id=1) AS storage,
   (SELECT json_group_array(json_object('bucket',q.bucket,'day',q.day,'requests',q.requests,'batches',q.batches,
    'rows_read',q.rows_read,'rows_written',q.rows_written,'blocked',q.blocked)) FROM
    (SELECT * FROM cloud_usage_counters WHERE day=? ORDER BY bucket LIMIT 101) q) AS counters_json,
   (SELECT json_object('id',r.id,'day',r.day,'user_bucket',r.user_bucket,'state',r.state,'write_bytes',r.write_bytes,'observed_json',r.observed_json,
    'policy_json',x.policy_json,'revision',x.revision,'pending',x.pending,'stopped',x.stopped,'completion_json',x.completion_json,'resolution_json',x.resolution_json)
    FROM cloud_usage_reservations r LEFT JOIN cloud_usage_context x ON x.reservation_id=r.id WHERE r.id=?) AS target_json,
   (SELECT count(*) FROM cloud_usage_reservations r WHERE r.state IN ('held','uncertain') AND NOT EXISTS
    (SELECT 1 FROM cloud_usage_context x WHERE x.reservation_id=r.id)) AS legacy_held
   FROM cloud_usage_control c JOIN cloud_usage_policy_versions v ON v.version=c.policy_version WHERE c.id=1`,[day,id],1);
  }catch{throw new MemoryError('unsupported_capability','Usage operations require the explicit 013 schema.');}
  const row=captureSchema.parse(raw),policy=usagePolicySchema.parse(JSON.parse(row.body));
  return {database_id:row.database_id,revision:row.revision,policy_version:row.policy_version,day,policy,storage:row.storage,
   counters:z.array(counterSchema).max(101).parse(JSON.parse(row.counters_json)),
   target:row.target_json===null?null:targetSchema.parse(JSON.parse(row.target_json)),legacy_held:row.legacy_held};
 }
 async previewPolicy(input:unknown,reason:string) {
  const policy=usagePolicySchema.parse(input),why=reasonSchema.parse(reason),state=await this.capture();
  const blocked=state.counters.filter(r=>r.blocked===1||usageKeys.some(k=>r[k]+(k==='requests'?1:policy.request[k])>policy[r.bucket==='account'?'daily':'user_daily'][k]));
  const reasons=[...(state.counters.length>100?['counter_scan_incomplete']:[]),...(state.legacy_held?['legacy_reservations_unfenced']:[])];
  const approval={kind:'policy',state,policy,reason:why};
  return bounded({status:reasons.length?'blocked':'preview',expected_hash:await hashText(canonical(approval)),database_id:state.database_id,
   expected_version:state.policy_version,revision:state.revision,next_version:state.policy_version+1,policy,
   changes:this.changes(state.policy,policy),new_admission_blocked:blocked.map(r=>r.bucket),
   storage_admission_blocked:state.storage>=policy.accepted_write_bytes,reasons,
   existing_charges_preserved:true,reservations_repriced:false,files_changed:false,claims_verified:false});
 }
 private changes(before:unknown,after:unknown,prefix=''):JsonObject[] {
  const a=z.record(z.string(),z.unknown()).parse(before),b=z.record(z.string(),z.unknown()).parse(after),out:JsonObject[]=[];
  for(const k of Object.keys(b)){
   const path=prefix?`${prefix}.${k}`:k;
   if(typeof b[k]==='object')out.push(...this.changes(a[k],b[k],path));
   else if(a[k]!==b[k])out.push({field:path,before:Number(a[k]),after:Number(b[k])});
  }
  return out;
 }
 async applyPolicy(input:unknown,options:{reason:string;expected_hash:string;idempotency_key:string}) {
  options=policyOptions.parse(options);
  const policy=usagePolicySchema.parse(input),reason=reasonSchema.parse(options.reason),expected=hashSchema.parse(options.expected_hash),key=keySchema.parse(options.idempotency_key);
  const hash=await hashText(canonical({operation:'policy',policy,reason,expected_hash:expected})),saved=await this.receipt(key,hash);if(saved)return saved;
  const preview=await this.previewPolicy(policy,reason);if(preview['status']!=='preview'||preview['expected_hash']!==expected)throw new MemoryError('preview_changed','Usage or policy changed; review a new preview.');
  const state=await this.capture();
  if(await hashText(canonical({kind:'policy',state,policy,reason}))!==expected)throw new MemoryError('preview_changed','Usage changed after preview.');
  const s=this.db.withSession('first-primary'),list:D1Statement[]=[];
  list.push(s.prepare('UPDATE cloud_usage_control SET policy_version=policy_version+1,revision=revision+1 WHERE id=1 AND database_id=? AND revision=? AND policy_version=?')
   .bind(state.database_id,state.revision,state.policy_version));assertOperation(s,list);
  list.push(s.prepare('INSERT INTO cloud_usage_policy_versions VALUES(?,?,?,?)').bind(state.policy_version+1,canonical(policy),reason,new Date(this.now()).toISOString()));
  const result={status:'persisted',operation:'policy',version:state.policy_version+1,policy,charges_reset:false,claims_verified:false};
  this.appendReceipt(s,list,key,hash,result);await this.commit(s,list);return result;
 }
 async listReservations(input:{limit?:number;after?:{created_at:string;id:string}}={}) {
  const limit=z.int().min(1).max(40).parse(input.limit??20);
  const after=input.after?z.object({created_at:z.iso.datetime(),id:z.uuid()}).parse(input.after):null;
  await this.capture();
  const list=(await rows(this.db,`SELECT r.id,r.day,r.state,r.created_at,x.pending,x.completion_json,x.policy_version FROM cloud_usage_reservations r
   LEFT JOIN cloud_usage_context x ON x.reservation_id=r.id WHERE r.state IN ('held','uncertain') AND x.resolution_json IS NULL
   AND (? IS NULL OR r.created_at>? OR (r.created_at=? AND r.id>?)) ORDER BY r.created_at,r.id LIMIT ?`,
   [after?.created_at??null,after?.created_at??null,after?.created_at??null,after?.id??null,limit+1],limit+1)).map(r=>listRowSchema.parse(r));
  const page=list.slice(0,limit),last=page.at(-1);
  return bounded({items:page.map(r=>({reservation_id:r['id'],state:r['state'],created_at:r['created_at'],day:r['day'],policy_version:r['policy_version'],
   execution_lease_pending:r['pending'],completion_saved:r['completion_json']!==null,legacy_context_missing:r['pending']===null,
   work_persistence:'unknown',claims_verified:false})),next_cursor:list.length>limit&&last?{created_at:last['created_at'],id:last['id']}:null,
   pagination:'live_keyset',native_liveness:'unknown',missing_request_count:null,claims_verified:false});
 }
 async previewRecovery(id:string) {
  z.uuid().parse(id);const state=await this.capture(id),row=state.target;
  if(!row)throw new MemoryError('not_found','Reservation was not found.');
  let action='retain_unconfirmed_charge',reason='no_refundable_completion';
  if(row.state==='settled'){action='already_settled';reason='no_change';}
  else if(row.resolution_json!==null){action='already_resolved';reason='no_change';}
  else if(row.policy_json===null){action='blocked';reason='legacy_context_missing';}
  else if(row.pending!==0){action='blocked';reason='native_inflight_or_unconfirmed';}
  else if(row.completion_json){
   const complete=savedCompletion(row as SavedUsage);
   if(row.state==='held'&&complete.completion.measurement==='observed'){action='apply_observed_completion';reason='saved_native_completion';}
  }
  return {status:action==='blocked'?'blocked':'preview',reservation_id:id,action,reason,
   expected_hash:await hashText(canonical({kind:'recovery',state})),revision:state.revision,
   refundable:action==='apply_observed_completion',work_persistence:'unknown',claims_verified:false};
 }
 async recover(id:string,options:{expected_hash:string;idempotency_key:string}) {
  options=recoveryOptions.parse(options);
  z.uuid().parse(id);const expected=hashSchema.parse(options.expected_hash),key=keySchema.parse(options.idempotency_key),
   hash=await hashText(canonical({operation:'recovery',reservation_id:id,expected_hash:expected})),saved=await this.receipt(key,hash);if(saved)return saved;
  const preview=await this.previewRecovery(id);if(preview.status!=='preview'||preview.expected_hash!==expected)throw new MemoryError('recovery_blocked','Reservation is not safe to recover from this preview.');
  const state=await this.capture(id),row=state.target!;
  if(await hashText(canonical({kind:'recovery',state}))!==expected)throw new MemoryError('preview_changed','Reservation or usage changed.');
  const s=this.db.withSession('first-primary'),list:D1Statement[]=[];
  list.push(s.prepare('UPDATE cloud_usage_control SET revision=revision+1 WHERE id=1 AND database_id=? AND revision=? AND policy_version=?')
   .bind(state.database_id,state.revision,state.policy_version));assertOperation(s,list);
  const changing=!['already_settled','already_resolved'].includes(preview.action);
  const result={status:'persisted',operation:'recovery',reservation_id:id,action:preview.action,charges_returned:preview.refundable,
   work_persistence:'unknown',claims_verified:false};
  if(changing){
   list.push(s.prepare(`UPDATE cloud_usage_context SET stopped=1,revision=revision+1,resolution_json=? WHERE reservation_id=? AND revision=? AND pending=0 AND resolution_json IS NULL`)
    .bind(canonical(result),id,row.revision));assertOperation(s,list);
   if(preview.action==='apply_observed_completion')appendCompletion(s,list,row as SavedUsage);
   else if(row.state==='held'){
    list.push(s.prepare("UPDATE cloud_usage_reservations SET state='uncertain' WHERE id=? AND state='held'").bind(id));assertOperation(s,list);
    // If normal finalization lost its response, preserve the same overage without a refund.
    if(row.completion_json){const {policy,completion}=savedCompletion(row as SavedUsage);
     for(const bucket of ['account',...(row.user_bucket?[row.user_bucket]:[])])list.push(s.prepare('UPDATE cloud_usage_counters SET rows_read=rows_read+?,rows_written=rows_written+? WHERE bucket=? AND day=?')
      .bind(Math.max(0,completion.rows_read-policy.request.rows_read),Math.max(0,completion.rows_written-policy.request.rows_written),bucket,row.day));}
   }
   for(const bucket of ['account',...(row.user_bucket?[row.user_bucket]:[])]){
    list.push(s.prepare(`UPDATE cloud_usage_counters SET blocked=0 WHERE bucket=? AND day=? AND NOT EXISTS
     (SELECT 1 FROM cloud_usage_reservations r LEFT JOIN cloud_usage_context x ON x.reservation_id=r.id
      WHERE r.day=? AND r.state='uncertain' AND x.resolution_json IS NULL AND (?='account' OR r.user_bucket=?))`)
     .bind(bucket,row.day,row.day,bucket,bucket));
   }
  }
  this.appendReceipt(s,list,key,hash,result);await this.commit(s,list);return result;
 }
 private async receipt(key:string,hash:string):Promise<JsonObject|null> {
  const [row]=await rows(this.db,'SELECT input_hash,result_json FROM cloud_usage_operations WHERE request_key=?',[key],1);
  if(!row)return null;if(row['input_hash']!==hash)throw new MemoryError('idempotency_conflict','Operation key belongs to different input.');
  return z.record(z.string(),z.json()).parse(JSON.parse(String(row['result_json']))) as JsonObject;
 }
 async getOperation(key:string) {
  keySchema.parse(key);const [r]=await rows(this.db,'SELECT result_json FROM cloud_usage_operations WHERE request_key=?',[key],1);
  return {found:Boolean(r),result:r?JSON.parse(String(r['result_json'])) as JsonObject:null,claims_verified:false};
 }
 private appendReceipt(s:ReturnType<D1Binding['withSession']>,list:D1Statement[],key:string,hash:string,result:unknown) {
  list.push(s.prepare('INSERT INTO cloud_usage_operations VALUES(?,?,?,?)').bind(key,hash,canonical(result),new Date(this.now()).toISOString()));
 }
 private async commit(s:ReturnType<D1Binding['withSession']>,list:D1Statement[]) {
  try{const result=await s.batch(list);if(result.length!==list.length||result.some(r=>!r.success))throw new Error('Incomplete operation response');}
  catch(e){if(e instanceof Error&&e.message.includes('skilly_usage_operation_allowed'))throw new MemoryError('preview_changed','Concurrent usage or policy operation changed the preview.');
   throw new MemoryError('persistence_unknown','Operation response was lost; check its original key before an identical retry.');}
 }
}
