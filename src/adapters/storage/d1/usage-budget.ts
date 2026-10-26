import { z } from 'zod';
import type { Principal } from '../../../core/access/model.js';
import { MemoryError } from '../../../core/memory/model.js';
import type { D1Binding, D1Result, D1Statement } from './binding.js';
import { canonical, hashText, rows } from './query.js';

const count = z.int().min(1).max(1_000_000_000);
const resources = z.strictObject({ requests: count, batches: count, rows_read: count, rows_written: count });
export const usagePolicySchema = z.strictObject({
 daily: resources, user_daily: resources,
 request: resources.omit({ requests: true }).extend({ statements: z.int().min(1).max(256) }),
 accepted_write_bytes: count,
}).refine(p => (['batches', 'rows_read', 'rows_written'] as const).every(k => p.request[k] <= p.daily[k] && p.request[k] <= p.user_daily[k]),
 'A request reservation must fit both daily budgets.');
export type UsagePolicy = z.infer<typeof usagePolicySchema>;
type Usage = z.infer<typeof resources>;
const keys = ['requests', 'batches', 'rows_read', 'rows_written'] as const;
const zero = (): Usage => ({ requests: 0, batches: 0, rows_read: 0, rows_written: 0 });
const dayAt = (now: number) => Math.floor(now / 86_400_000);
export class UsageLimit extends MemoryError {
 constructor(readonly retryAfterSeconds: number, code = 'usage_limit') { super(code, 'Usage budget unavailable; keep the original request.'); }
}

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
   const [row] = await rows(this.db, 'SELECT body FROM cloud_usage_policy WHERE id=1', [], 1);
   return usagePolicySchema.parse(JSON.parse(String(row?.['body'])));
  } catch { throw new UsageLimit(60, 'usage_unavailable'); }
 }
 async reserve(): Promise<UsageReservation> {
  const policy = await this.policy(), day = dayAt(this.now()), id = crypto.randomUUID();
  const session = this.db.withSession('first-primary'), statements: D1Statement[] = [];
  this.appendReserve(session, statements, 'account', day, policy.daily, policy);
  statements.push(session.prepare("INSERT INTO cloud_usage_reservations(id,day,state,created_at) VALUES(?,?,'held',?)").bind(id, day, new Date(this.now()).toISOString()));
  await this.commit(session, statements, day);
  return new UsageReservation(this, policy, id, day);
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
 get failure() { return this.failureValue; }
 constructor(private readonly budget: D1UsageBudget, private readonly policy: UsagePolicy, readonly id: string, private readonly day: number) {}
 async attach(principal: Principal) {
  if (this.user) throw new MemoryError('invalid_input', 'Principal already bound.');
  const bucket = 'user:' + await hashText(canonical(principal)), session = this.budget.db.withSession('first-primary'), statements: D1Statement[] = [];
  this.budget.appendReserve(session, statements, bucket, this.day, this.policy.user_daily, this.policy);
  statements.push(session.prepare("UPDATE cloud_usage_reservations SET user_bucket=? WHERE id=? AND state='held' AND user_bucket IS NULL").bind(bucket, this.id));
  this.budget.assertChange(session, statements);
  await this.budget.commit(session, statements, this.day); this.user = bucket;
 }
 async acceptWrite(bytes: number) {
  if (!this.user || this.writeBytes || !Number.isSafeInteger(bytes) || bytes < 1 || bytes > 65536) throw new MemoryError('invalid_input', 'Invalid write budget.');
  const session = this.budget.db.withSession('first-primary'), statements: D1Statement[] = [
   session.prepare('UPDATE cloud_usage_storage SET accepted_write_bytes=accepted_write_bytes+? WHERE id=1 AND accepted_write_bytes+?<=?').bind(bytes, bytes, this.policy.accepted_write_bytes),
  ];
  this.budget.assertChange(session, statements);
  statements.push(session.prepare("UPDATE cloud_usage_reservations SET write_bytes=? WHERE id=? AND state='held' AND write_bytes=0").bind(bytes, this.id));
  this.budget.assertChange(session, statements);
  await this.budget.commit(session, statements, this.day); this.writeBytes = bytes;
 }
 bind(raw: D1Binding): D1Binding {
  const execute = async <T>(call: () => Promise<D1Result<T>[]>, batches: number, statements: number): Promise<D1Result<T>[]> => {
   if (this.finishing || dayAt(this.budget.now()) !== this.day || this.uncertain || this.observed.batches + batches > this.policy.request.batches
    || this.statements + statements > this.policy.request.statements
    || this.observed.rows_read >= this.policy.request.rows_read || this.observed.rows_written >= this.policy.request.rows_written) {
    this.failureValue = new UsageLimit(this.budget.retryAfter(this.day)); throw this.failureValue;
   }
   this.statements += statements; this.observed.batches += batches; this.pending++;
   try {
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
   } catch (e) { this.uncertain = true; throw e; }
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
