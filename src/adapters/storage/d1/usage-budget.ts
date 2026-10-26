import type { Principal } from '../../../core/access/model.js';
import { MemoryError } from '../../../core/memory/model.js';
import type { D1Binding, D1Result, D1Statement } from './binding.js';
import { canonical, hashText, rows } from './query.js';
import { usagePolicySchema, usageKeys as keys, zeroUsage as zero, usageDay as dayAt, UsageLimit, type UsagePolicy, type Usage } from './usage-model.js';
import { policyState, policyGuard, contextGuard, nativeBoundary, freezeCompletion, finalizeSavedUsage } from './usage-ledger.js';
export { usagePolicySchema, UsageLimit, type UsagePolicy } from './usage-model.js';

/** One database-wide host policy. Never selected or provisioned from an HTTP request. */
export class D1UsageBudget {
 constructor(readonly db: D1Binding, readonly now: () => number = Date.now) {}
 async install(input: UsagePolicy) {
  const body = canonical(usagePolicySchema.parse(input));
  await this.db.withSession('first-primary').prepare('INSERT INTO cloud_usage_policy VALUES(1,?) ON CONFLICT(id) DO NOTHING').bind(body).all();
  if (canonical(await this.policy()) !== body) throw new MemoryError('conflict', 'A different usage policy is already installed.');
 }
 async policy(): Promise<UsagePolicy> {
  try {
   return (await policyState(this.db)).policy;
  } catch { throw new UsageLimit(60, 'usage_unavailable'); }
 }
 async reserve(): Promise<UsageReservation> {
  let entry:Awaited<ReturnType<typeof policyState>>;
  try{entry=await policyState(this.db);}catch{throw new UsageLimit(60,'usage_unavailable');}
  const {policy,version,operations}=entry, day = dayAt(this.now()), id = crypto.randomUUID();
  const session = this.db.withSession('first-primary'), statements: D1Statement[] = [];
  if(operations)policyGuard(session,statements,version);
  this.appendReserve(session, statements, 'account', day, policy.daily, policy);
  if(operations)statements.push(session.prepare('INSERT INTO cloud_usage_admission VALUES(1,?,?)').bind(id,version));
  statements.push(session.prepare("INSERT INTO cloud_usage_reservations(id,day,state,created_at) VALUES(?,?,'held',?)").bind(id, day, new Date(this.now()).toISOString()));
  if(operations){
   statements.push(session.prepare('INSERT INTO cloud_usage_context(reservation_id,policy_version,policy_json) VALUES(?,?,?)').bind(id,version,canonical(policy)));
   statements.push(session.prepare('DELETE FROM cloud_usage_admission WHERE id=1'));
  }
  await this.commit(session, statements, day);
  return new UsageReservation(this, policy, id, day, operations?version:undefined);
 }
 appendReserve(session: ReturnType<D1Binding['withSession']>, statements: D1Statement[], bucket: string, day: number, limits: Usage, policy: UsagePolicy) {
  const reservation = { requests: 1, ...policy.request };
  statements.push(session.prepare(`INSERT INTO cloud_usage_counters(bucket,day,requests,batches,rows_read,rows_written)
   VALUES(?,?,?,?,?,?) ON CONFLICT(bucket,day) DO UPDATE SET
   requests=requests+excluded.requests,batches=batches+excluded.batches,
   rows_read=rows_read+excluded.rows_read,rows_written=rows_written+excluded.rows_written
   WHERE blocked=0 AND requests+excluded.requests<=? AND batches+excluded.batches<=?
    AND rows_read+excluded.rows_read<=? AND rows_written+excluded.rows_written<=?`)
   .bind(bucket, day, ...keys.map(k => reservation[k]), ...keys.map(k => limits[k])));
  this.assertChange(session, statements);
 }
 assertChange(session: ReturnType<D1Binding['withSession']>, statements: D1Statement[]) {
  statements.push(session.prepare('INSERT INTO cloud_usage_guard VALUES(1,CASE WHEN changes()=1 THEN 1 ELSE 0 END)'));
  // The row is transient transactional synchronization, never project data.
  statements.push(session.prepare('DELETE FROM cloud_usage_guard WHERE id=1'));
 }
 async commit(session: ReturnType<D1Binding['withSession']>, statements: D1Statement[], day: number) {
  try {
   const result = await session.batch(statements);
   if (result.length !== statements.length || result.some(r => !r.success)) throw new Error('Invalid quota result');
  } catch (e) {
   if (e instanceof Error && e.message.includes('skilly_usage_allowed')) throw new UsageLimit(this.retryAfter(day));
   if (e instanceof Error && (e.message.includes('skilly_usage_operation_allowed')||e.message.includes('skilly_usage_admission_required'))) throw new UsageLimit(1,'usage_state_changed');
   throw new UsageLimit(60, 'usage_unavailable');
  }
 }
 retryAfter(day: number) { return Math.max(1, Math.min(86400, Math.ceil(((day + 1) * 86_400_000 - this.now()) / 1000))); }
 /** Trusted host diagnostic only; not an account/project discovery endpoint. */
 async snapshot() {
  return { counters: await rows(this.db, 'SELECT * FROM cloud_usage_counters ORDER BY day DESC,bucket LIMIT 100', [], 100),
   reservations: await rows(this.db, 'SELECT * FROM cloud_usage_reservations ORDER BY created_at DESC,id LIMIT 100', [], 100),
   storage: await rows(this.db, 'SELECT accepted_write_bytes FROM cloud_usage_storage WHERE id=1', [], 1),
   coverage: 'configured_mcp_binding_only', claims_verified: false };
 }
}

/** Held reservations survive process loss. No expiry refunds or speculative replay. */
export class UsageReservation {
 private user: string | undefined;
 private readonly observed = zero();
 private pending = 0;
 private statements = 0;
 private uncertain = false;
 private finishing = false;
 private settlement: Promise<void> | undefined;
 private writeBytes = 0;
 private failureValue: UsageLimit | undefined;
 private executionRegistration:Promise<void>|undefined;
 private executionRegistered=false;
 get failure() { return this.failureValue; }
 constructor(private readonly budget: D1UsageBudget, private readonly policy: UsagePolicy, readonly id: string, private readonly day: number,private readonly policyVersion?:number) {}
 async attach(principal: Principal) {
  if (this.user) throw new MemoryError('invalid_input', 'Principal already bound.');
  const bucket = 'user:' + await hashText(canonical(principal)), session = this.budget.db.withSession('first-primary'), statements: D1Statement[] = [];
  if(this.policyVersion!==undefined){policyGuard(session,statements,this.policyVersion);contextGuard(session,statements,this.id);}
  this.budget.appendReserve(session, statements, bucket, this.day, this.policy.user_daily, this.policy);
  statements.push(session.prepare("UPDATE cloud_usage_reservations SET user_bucket=? WHERE id=? AND state='held' AND user_bucket IS NULL").bind(bucket, this.id));
  this.budget.assertChange(session, statements);
  await this.budget.commit(session, statements, this.day); this.user = bucket;
 }
 async acceptWrite(bytes: number) {
  if (!this.user || this.writeBytes || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 65536) throw new MemoryError('invalid_input', 'Invalid write budget.');
  const session = this.budget.db.withSession('first-primary'), statements: D1Statement[] = [
  ];
  let ceiling=this.policy.accepted_write_bytes;
  if(this.policyVersion!==undefined){const current=await policyState(this.budget.db);policyGuard(session,statements,current.version);contextGuard(session,statements,this.id);ceiling=current.policy.accepted_write_bytes;}
  statements.push(session.prepare('UPDATE cloud_usage_storage SET accepted_write_bytes=accepted_write_bytes+? WHERE id=1 AND accepted_write_bytes+?<=?').bind(bytes,bytes,ceiling));
  this.budget.assertChange(session, statements);
  statements.push(session.prepare("UPDATE cloud_usage_reservations SET write_bytes=? WHERE id=? AND state='held' AND write_bytes=0").bind(bytes, this.id));
  this.budget.assertChange(session, statements);
  await this.budget.commit(session, statements, this.day); this.writeBytes = bytes;
 }
 bind(raw: D1Binding,dispatch?:{check:()=>void;write:()=>void}): D1Binding {
  const execute = async <T>(call: () => Promise<D1Result<T>[]>, batches: number, statements: number): Promise<D1Result<T>[]> => {
   if (this.finishing || dayAt(this.budget.now()) !== this.day || this.uncertain || this.observed.batches + batches > this.policy.request.batches
    || this.statements + statements > this.policy.request.statements
    || this.observed.rows_read >= this.policy.request.rows_read || this.observed.rows_written >= this.policy.request.rows_written) {
    this.failureValue = new UsageLimit(this.budget.retryAfter(this.day)); throw this.failureValue;
   }
   this.statements += statements; this.observed.batches += batches; this.pending++;
   try {
    if(this.policyVersion!==undefined){
     this.executionRegistration??=nativeBoundary(this.budget.db,this.id,true).then(()=>{this.executionRegistered=true;});
     await this.executionRegistration;
    }
    // A bookkeeping response can arrive after HTTP termination or an owner fence.
    if(this.finishing||dayAt(this.budget.now())!==this.day||this.uncertain)throw new UsageLimit(1,'usage_state_changed');
    dispatch?.check();if(batches>0)dispatch?.write();
    const result = await call();
    if (result.length !== statements) this.uncertain = true;
    for (const entry of result) {
     const { rows_read: read, rows_written: written } = entry.meta;
     if (!Number.isSafeInteger(read) || !Number.isSafeInteger(written) || read! < 0 || written! < 0) this.uncertain = true;
     else { this.observed.rows_read += read!; this.observed.rows_written += written!; }
    }
    if (this.uncertain || this.observed.rows_read > this.policy.request.rows_read || this.observed.rows_written > this.policy.request.rows_written) {
     this.uncertain = true; this.failureValue = new UsageLimit(this.budget.retryAfter(this.day), 'usage_measurement_unknown'); throw this.failureValue;
    }
    return result;
   } catch (e) { this.uncertain = true; if(e instanceof UsageLimit)this.failureValue=e; throw e; }
   finally {
    this.pending--;
    if (this.finishing && this.pending === 0) void this.settle().catch(() => {});
   }
  };
  return { ...(raw.writeGeneration === undefined ? {} : { writeGeneration: raw.writeGeneration }), withSession: constraint => {
   const session = raw.withSession(constraint), native = new WeakMap<D1Statement, D1Statement>();
   const wrap = (statement: D1Statement): D1Statement => {
    const result: D1Statement = { bind: (...v) => wrap(statement.bind(...v)), all: async <T>() => (await execute<T>(() => statement.all<T>().then(r => [r]), 0, 1))[0]! };
    native.set(result, statement); return result;
   };
   return { prepare: sql => wrap(session.prepare(sql)), batch: statements => {
    const originals = statements.map(s => { const original = native.get(s); if (!original) throw new Error('Foreign statement'); return original; });
    return execute(() => session.batch(originals), 1, statements.length);
   } };
  } };
 }
 async finish() {
  this.finishing = true;
  // A timed-out native operation retains its entire reservation until actually settled.
  if (this.pending === 0) await this.settle();
 }
 private settle() { return this.settlement ??= this.settleOnce(); }
 private async settleOnce() {
  if(this.policyVersion!==undefined){
   if(this.executionRegistered){await nativeBoundary(this.budget.db,this.id,false);this.executionRegistered=false;}
   await freezeCompletion(this.budget.db,this.id,{...this.observed,requests:1,measurement:this.uncertain?'unknown':'observed'});
   await finalizeSavedUsage(this.budget.db,this.id);return;
  }
  const session = this.budget.db.withSession('first-primary'), statements: D1Statement[] = [];
  const state = this.uncertain ? 'uncertain' : 'settled';
  statements.push(session.prepare("UPDATE cloud_usage_reservations SET state=?,observed_json=? WHERE id=? AND state='held'")
   .bind(state, canonical({ ...this.observed, requests: 1, measurement: this.uncertain ? 'unknown' : 'observed' }), this.id));
  this.budget.assertChange(session, statements);
  for (const bucket of ['account', ...(this.user ? [this.user] : [])]) {
   if (this.uncertain) statements.push(session.prepare('UPDATE cloud_usage_counters SET blocked=1,rows_read=rows_read+?,rows_written=rows_written+? WHERE bucket=? AND day=?')
    .bind(Math.max(0,this.observed.rows_read-this.policy.request.rows_read),Math.max(0,this.observed.rows_written-this.policy.request.rows_written),bucket,this.day));
   else statements.push(session.prepare('UPDATE cloud_usage_counters SET batches=batches-?,rows_read=rows_read-?,rows_written=rows_written-? WHERE bucket=? AND day=?')
    .bind(this.policy.request.batches - this.observed.batches, this.policy.request.rows_read - this.observed.rows_read,
     this.policy.request.rows_written - this.observed.rows_written, bucket, this.day));
  }
  await this.budget.commit(session, statements, this.day);
 }
}
