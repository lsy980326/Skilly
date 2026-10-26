import { MemoryError } from '../../../core/memory/model.js';
import type { D1Binding, D1Session, D1Statement } from './binding.js';
import { canonical, rows } from './query.js';
import { completionSchema, usagePolicySchema, UsageLimit, type UsagePolicy, type UsageCompletion } from './usage-model.js';

export function assertOperation(session: D1Session, statements: D1Statement[]) {
 statements.push(session.prepare('INSERT INTO cloud_usage_operation_guard VALUES(1,CASE WHEN changes()=1 THEN 1 ELSE 0 END)'));
 statements.push(session.prepare('DELETE FROM cloud_usage_operation_guard WHERE id=1'));
}
export function policyGuard(session: D1Session, statements: D1Statement[], version: number) {
 statements.push(session.prepare('UPDATE cloud_usage_control SET revision=revision+1 WHERE id=1 AND policy_version=?').bind(version));
 assertOperation(session, statements);
}
export function contextGuard(session: D1Session, statements: D1Statement[], id: string) {
 statements.push(session.prepare(`UPDATE cloud_usage_context SET revision=revision+1 WHERE reservation_id=? AND stopped=0 AND resolution_json IS NULL
  AND EXISTS(SELECT 1 FROM cloud_usage_reservations WHERE id=? AND state='held')`).bind(id,id));
 assertOperation(session, statements);
}
export async function ledgerCommit(session: D1Session, statements: D1Statement[]) {
 try {
  const result=await session.batch(statements);
  if(result.length!==statements.length||result.some(r=>!r.success))throw new Error('Incomplete usage accounting response');
 } catch(e) {
  if(e instanceof Error&&e.message.includes('skilly_usage_operation_allowed'))throw new UsageLimit(1,'usage_state_changed');
  throw new UsageLimit(60,'usage_unavailable');
 }
}
/** Capability absence is explicit compatibility, not a fallback after a storage failure. */
export async function policyState(db:D1Binding):Promise<{policy:UsagePolicy;version:number;operations:boolean}> {
 const found=await rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('cloud_usage_control','cloud_usage_context','cloud_usage_policy_versions','cloud_usage_operations','cloud_usage_admission')",[],5);
 if(found.length===0){
  const [r]=await rows(db,'SELECT body FROM cloud_usage_policy WHERE id=1',[],1);
  return {policy:usagePolicySchema.parse(JSON.parse(String(r?.['body']))),version:0,operations:false};
 }
 if(found.length!==5)throw new UsageLimit(60,'usage_unavailable');
 const [r]=await rows(db,`SELECT v.version,v.body FROM cloud_usage_control c JOIN cloud_usage_policy_versions v ON v.version=c.policy_version WHERE c.id=1`,[],1);
 if(!r||!Number.isSafeInteger(r['version'])||Number(r['version'])<1)throw new UsageLimit(60,'usage_unavailable');
 return {policy:usagePolicySchema.parse(JSON.parse(String(r['body']))),version:Number(r['version']),operations:true};
}
/** One execution lease covers the request's calls; only quiescent finish releases it. */
export async function nativeBoundary(db:D1Binding,id:string,start:boolean) {
 const s=db.withSession('first-primary'),list:D1Statement[]=[];
 list.push(s.prepare(start?`UPDATE cloud_usage_context SET pending=pending+1,revision=revision+1 WHERE reservation_id=? AND pending=0 AND stopped=0 AND resolution_json IS NULL
  AND EXISTS(SELECT 1 FROM cloud_usage_reservations WHERE id=? AND state='held')`:
  'UPDATE cloud_usage_context SET pending=pending-1,revision=revision+1 WHERE reservation_id=? AND pending=1').bind(...(start?[id,id]:[id])));
 assertOperation(s,list);list.push(s.prepare('UPDATE cloud_usage_control SET revision=revision+1 WHERE id=1'));
 await ledgerCommit(s,list);
}
export async function freezeCompletion(db:D1Binding,id:string,completion:UsageCompletion) {
 const text=canonical(completionSchema.parse(completion)),s=db.withSession('first-primary'),list:D1Statement[]=[];
 list.push(s.prepare(`UPDATE cloud_usage_context SET stopped=1,completion_json=?,revision=revision+1
  WHERE reservation_id=? AND pending=0 AND stopped=0 AND completion_json IS NULL AND resolution_json IS NULL
  AND EXISTS(SELECT 1 FROM cloud_usage_reservations WHERE id=? AND state='held')`).bind(text,id,id));
 assertOperation(s,list);list.push(s.prepare('UPDATE cloud_usage_control SET revision=revision+1 WHERE id=1'));
 await ledgerCommit(s,list);
}
export type SavedUsage = {id:string;day:number;user_bucket:string|null;state:string;policy_json:string;pending:number;stopped:number;completion_json:string|null;resolution_json:string|null;revision:number};
export async function savedUsage(db:D1Binding,id:string):Promise<SavedUsage|null> {
 const [r]=await rows(db,`SELECT r.id,r.day,r.user_bucket,r.state,c.policy_json,c.pending,c.stopped,c.completion_json,c.resolution_json,c.revision
  FROM cloud_usage_reservations r JOIN cloud_usage_context c ON c.reservation_id=r.id WHERE r.id=?`,[id],1);
 if(!r)return null;
 return {id:String(r['id']),day:Number(r['day']),user_bucket:r['user_bucket']===null?null:String(r['user_bucket']),state:String(r['state']),policy_json:String(r['policy_json']),
  pending:Number(r['pending']),stopped:Number(r['stopped']),completion_json:r['completion_json']===null?null:String(r['completion_json']),
  resolution_json:r['resolution_json']===null?null:String(r['resolution_json']),revision:Number(r['revision'])};
}
export function savedCompletion(row:SavedUsage) {
 if(!row.completion_json||row.pending!==0||row.stopped!==1)throw new MemoryError('recovery_blocked','Native completion is not durably confirmed.');
 const policy=usagePolicySchema.parse(JSON.parse(row.policy_json)),completion=completionSchema.parse(JSON.parse(row.completion_json));
 if(completion.measurement==='observed'&&(['batches','rows_read','rows_written'] as const).some(k=>completion[k]>policy.request[k]))
  throw new MemoryError('recovery_blocked','Saved accounting evidence exceeds its reservation.');
 return {policy,completion};
}
/** Shared by normal finalization and host recovery; callers never supply observed totals. */
export function appendCompletion(s:D1Session,list:D1Statement[],row:SavedUsage) {
 const {policy,completion}=savedCompletion(row),unknown=completion.measurement==='unknown';
 list.push(s.prepare("UPDATE cloud_usage_reservations SET state=?,observed_json=? WHERE id=? AND state='held'")
  .bind(unknown?'uncertain':'settled',canonical(completion),row.id));assertOperation(s,list);
 for(const bucket of ['account',...(row.user_bucket?[row.user_bucket]:[])]){
  if(unknown)list.push(s.prepare('UPDATE cloud_usage_counters SET blocked=1,rows_read=rows_read+?,rows_written=rows_written+? WHERE bucket=? AND day=?')
   .bind(Math.max(0,completion.rows_read-policy.request.rows_read),Math.max(0,completion.rows_written-policy.request.rows_written),bucket,row.day));
  else list.push(s.prepare('UPDATE cloud_usage_counters SET batches=batches-?,rows_read=rows_read-?,rows_written=rows_written-? WHERE bucket=? AND day=?')
   .bind(policy.request.batches-completion.batches,policy.request.rows_read-completion.rows_read,policy.request.rows_written-completion.rows_written,bucket,row.day));
  assertOperation(s,list);
 }
}
export async function finalizeSavedUsage(db:D1Binding,id:string) {
 const row=await savedUsage(db,id);if(!row)throw new MemoryError('recovery_blocked','Reservation has no versioned accounting context.');
 if(row.state!=='held')return;
 const s=db.withSession('first-primary'),list:D1Statement[]=[];
 list.push(s.prepare('UPDATE cloud_usage_context SET revision=revision+1 WHERE reservation_id=? AND revision=? AND pending=0 AND stopped=1 AND resolution_json IS NULL').bind(id,row.revision));
 assertOperation(s,list);appendCompletion(s,list,row);list.push(s.prepare('UPDATE cloud_usage_control SET revision=revision+1 WHERE id=1'));
 await ledgerCommit(s,list);
}
