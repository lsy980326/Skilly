import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { D1UsageBudget } from '../dist/adapters/storage/d1/usage-budget.js';

const base = () => ({ daily:{requests:100,batches:100,rows_read:100000,rows_written:10000},
 user_daily:{requests:50,batches:100,rows_read:100000,rows_written:10000},
 request:{batches:4,statements:100,rows_read:1000,rows_written:100},accepted_write_bytes:100000 });
const principal = subject => ({issuer:'https://local.invalid',subject});
async function fixture(t, policy=base()) {
 const mf = new Miniflare({modules:true,script:'export default {fetch(){return new Response("local test only")}}',
  compatibilityDate:'2026-07-30',d1Databases:{DB:randomUUID()},d1Persist:join(realpathSync(mkdtempSync(join(tmpdir(),'skilly-usage-'))),'d1'),
  host:'127.0.0.1',port:0,outboundService:()=>new Response('outbound disabled',{status:403})});
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 const sql=readFileSync(new URL('../migrations/d1/012-usage-budget.sql',import.meta.url),'utf8').replace(/^--[^\n]*$/gm,'').trim().split(/;\s*(?=CREATE\s|INSERT\s|$)/i).filter(Boolean);
 await db.batch(sql.map(s=>db.prepare(s)));await db.prepare('CREATE TABLE usage_items(id TEXT PRIMARY KEY,body TEXT NOT NULL)').all();
 let clock=Date.UTC(2026,9,26,12);const budget=new D1UsageBudget(db,()=>clock);await budget.install(policy);
 return {db,budget,policy,nextDay:()=>clock+=86400000};
}
const counter = (snapshot,bucket='account') => snapshot.counters.find(r=>r.bucket===bucket);

test('actual D1 atomically reserves a shared account budget across independent instances',async t=>{
 const policy=base();policy.daily.requests=3;const {db,budget}=await fixture(t,policy);
 const results=await Promise.allSettled(Array.from({length:20},()=>new D1UsageBudget(db,budget.now).reserve()));
 const accepted=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
 assert.equal(accepted.length,3);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='usage_limit').length,17);
 let state=await budget.snapshot();assert.equal(counter(state).requests,3);assert.equal(state.reservations.length,3);
 await Promise.all(accepted.map(r=>r.finish()));state=await budget.snapshot();
 assert.equal(counter(state).requests,3);assert.equal(counter(state).rows_read,0);assert.equal(counter(state).batches,0);
 await assert.rejects(new D1UsageBudget(db,budget.now).reserve(),{code:'usage_limit'});
});

test('principal quota is stable across connection/key changes and account reservations remain charged',async t=>{
 const policy=base();policy.user_daily.requests=1;const {budget}=await fixture(t,policy);
 const a=await budget.reserve(),b=await budget.reserve();
 const results=await Promise.allSettled([a.attach(principal('alice')),b.attach(principal('alice'))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected'&&r.reason.code==='usage_limit').length,1);
 await a.finish();await b.finish();const c=await budget.reserve();await c.attach(principal('bob'));await c.finish();
 const state=await budget.snapshot();assert.equal(counter(state).requests,3);assert.equal(state.counters.filter(r=>r.bucket.startsWith('user:')).length,2);
 assert.equal(JSON.stringify(state).includes('alice'),false);
});

test('actual D1 rows are observed and unused reservations are settled exactly once',async t=>{
 const {budget,db}=await fixture(t),r=await budget.reserve();await r.attach(principal('alice'));await r.acceptWrite(25);
 const metered=r.bind(db),session=metered.withSession('first-primary');
 await session.batch([session.prepare('INSERT INTO usage_items VALUES(?,?)').bind('one','original')]);
 await session.prepare('SELECT * FROM usage_items WHERE id=?').bind('one').all();
 await Promise.all([r.finish(),r.finish()]);const state=await budget.snapshot(),saved=state.reservations[0];
 assert.equal(saved.state,'settled');const observed=JSON.parse(saved.observed_json);
 assert.equal(observed.measurement,'observed');assert.ok(observed.rows_read>=1);assert.ok(observed.rows_written>=1);
 assert.equal(counter(state).rows_read,observed.rows_read);assert.equal(counter(state).rows_written,observed.rows_written);
 assert.equal(state.storage[0].accepted_write_bytes,25);
 assert.equal((await new D1UsageBudget(db,budget.now).snapshot()).reservations[0].id,r.id);
});

test('in-flight native commits retain budget after HTTP finish and release only on observed completion',async t=>{
 const policy=base();policy.daily.rows_read=1500;policy.user_daily.rows_read=1500;
 const {db,budget}=await fixture(t,policy),r=await budget.reserve();
 let release;const gate=new Promise(resolve=>release=resolve);let committed;
 const reached=new Promise(resolve=>committed=resolve);
 const delayed={withSession(c){const s=db.withSession(c);return {prepare:q=>s.prepare(q),async batch(st){const result=await s.batch(st);committed();await gate;return result;}};}};
 const s=r.bind(delayed).withSession('first-primary'),pending=s.batch([s.prepare("INSERT INTO usage_items VALUES('late','saved')")]);
 await reached;await r.finish();assert.equal((await budget.snapshot()).reservations[0].state,'held');
 await assert.rejects(budget.reserve(),{code:'usage_limit'});release();await pending;await r.finish();
 const next=await budget.reserve();await next.finish();assert.equal((await db.prepare('SELECT count(*) n FROM usage_items').all()).results[0].n,1);
 assert.equal((await budget.snapshot()).reservations.find(x=>x.id===r.id).state,'settled');
});

test('lost native response and missing meta never become zero usage; next UTC window recovers without deleting data',async t=>{
 const {db,budget,nextDay}=await fixture(t),r=await budget.reserve();
 const lost={withSession(c){const s=db.withSession(c);return {prepare:q=>s.prepare(q),async batch(st){await s.batch(st);throw Error('response lost after commit');}};}};
 const s=r.bind(lost).withSession('first-primary');await assert.rejects(s.batch([s.prepare("INSERT INTO usage_items VALUES('lost','preserved')")]));await r.finish();
 let state=await budget.snapshot();assert.equal(state.reservations[0].state,'uncertain');assert.equal(counter(state).blocked,1);
 assert.equal(counter(state).rows_read,base().request.rows_read);await assert.rejects(budget.reserve(),{code:'usage_limit'});
 nextDay();const retry=await budget.reserve(),recovered=retry.bind(db).withSession('first-primary');
 await recovered.batch([recovered.prepare("INSERT INTO usage_items VALUES('lost','preserved') ON CONFLICT(id) DO NOTHING")]);await retry.finish();
 assert.equal((await db.prepare('SELECT count(*) n FROM usage_items').all()).results[0].n,1);
 const unknown=await budget.reserve(),noMeta={withSession(){return {prepare(){return {bind(){return this;},async all(){return {success:true,results:[],meta:{changes:0}};}};},batch:async()=>[]};}};
 await assert.rejects(unknown.bind(noMeta).withSession('first-primary').prepare('SELECT 1').all(),{code:'usage_measurement_unknown'});await unknown.finish();
 state=await budget.snapshot();assert.equal(state.reservations.find(x=>x.id===unknown.id).state,'uncertain');
});

test('actual row overrun blocks following dispatch, records overage and preserves the original table',async t=>{
 const policy=base();policy.request.rows_read=1;const {db,budget}=await fixture(t,policy);
 await db.prepare("INSERT INTO usage_items VALUES('a','a'),('b','b'),('c','c')").all();
 const r=await budget.reserve(),s=r.bind(db).withSession('first-primary');
 await assert.rejects(s.prepare('SELECT * FROM usage_items').all(),{code:'usage_measurement_unknown'});
 await assert.rejects(s.prepare("INSERT INTO usage_items VALUES('must-not-write','blocked')").all(),{code:'usage_limit'});
 await r.finish();const state=await budget.snapshot();assert.ok(counter(state).rows_read>=3);assert.equal(counter(state).blocked,1);
 assert.equal((await db.prepare('SELECT count(*) n FROM usage_items').all()).results[0].n,3);
});

test('accepted write bytes have a cumulative ceiling; reads still work and next day never refunds storage',async t=>{
 const policy=base();policy.accepted_write_bytes=10;const {budget,nextDay}=await fixture(t,policy);
 const a=await budget.reserve();await a.attach(principal('alice'));await a.acceptWrite(8);await a.finish();
 const b=await budget.reserve();await b.attach(principal('alice'));await assert.rejects(b.acceptWrite(3),{code:'usage_limit'});await b.finish();
 nextDay();const c=await budget.reserve();await c.attach(principal('alice'));await assert.rejects(c.acceptWrite(3),{code:'usage_limit'});await c.finish();
 assert.equal((await budget.snapshot()).storage[0].accepted_write_bytes,8);
});

test('policy cannot be replaced silently and a real rolled back batch stays conservatively uncertain',async t=>{
 const {budget,db}=await fixture(t);await assert.rejects(budget.install({...base(),accepted_write_bytes:1}),{code:'conflict'});
 const r=await budget.reserve(),s=r.bind(db).withSession('first-primary');
 await assert.rejects(s.batch([s.prepare("INSERT INTO usage_items VALUES('rollback','first')"),s.prepare("INSERT INTO usage_items VALUES('rollback','duplicate')")]));await r.finish();
 assert.equal((await db.prepare('SELECT count(*) n FROM usage_items').all()).results[0].n,0);
 assert.equal((await budget.snapshot()).reservations[0].state,'uncertain');
});
