import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { D1UsageBudget } from '../dist/adapters/storage/d1/usage-budget.js';
import { D1UsageOperations } from '../dist/adapters/storage/d1/usage-operations.js';

const policy=()=>({daily:{requests:100,batches:100,rows_read:100000,rows_written:10000},
 user_daily:{requests:50,batches:100,rows_read:100000,rows_written:10000},request:{batches:4,statements:100,rows_read:1000,rows_written:100},accepted_write_bytes:100000});
const person=subject=>({issuer:'https://local.invalid',subject});
const all=async(db,q,...v)=>(await db.withSession('first-primary').prepare(q).bind(...v).all()).results;
async function migrate(db,name){
 const sql=readFileSync(new URL('../migrations/d1/'+name,import.meta.url),'utf8').replace(/^--[^\n]*$/gm,'').trim().split(/;\s*(?=CREATE\s|INSERT\s|$)/i).filter(Boolean);
 const s=db.withSession('first-primary');await s.batch(sql.map(q=>s.prepare(q)));
}
async function fixture(t,upgrade=true){
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("local test only")}}',compatibilityDate:'2026-07-30',
  d1Databases:{DB:randomUUID()},d1Persist:join(realpathSync(mkdtempSync(join(tmpdir(),'skilly-budget-ops-'))),'d1'),host:'127.0.0.1',port:0,
  outboundService:()=>new Response('outbound disabled',{status:403})});
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');await migrate(db,'012-usage-budget.sql');
 if(upgrade)await migrate(db,'013-usage-operations.sql');
 await db.prepare('CREATE TABLE usage_items(id TEXT PRIMARY KEY,body TEXT NOT NULL)').all();
 const budget=new D1UsageBudget(db),ops=new D1UsageOperations(db);await budget.install(policy());
 return {db,budget,ops};
}
function wrapped(db,{beforeBatch,afterBatch,afterRead}={}){return {withSession(c){const s=db.withSession(c),native=new WeakMap(),sql=new WeakMap();
 const wrap=(st,q)=>{const w={bind:(...v)=>wrap(st.bind(...v),q),async all(){const result=await st.all();return afterRead?afterRead(q,result):result;}};native.set(w,st);sql.set(w,q);return w;};
 return {prepare:q=>wrap(s.prepare(q),q),async batch(list){const queries=list.map(x=>sql.get(x));if(beforeBatch)await beforeBatch(queries);
  const result=await s.batch(list.map(x=>native.get(x)));if(afterBatch)await afterBatch(queries);return result;}};
}};}
const account=state=>state.counters.find(x=>x.bucket==='account');
const lostFinalization=db=>wrapped(db,{beforeBatch:queries=>{if(queries.some(q=>q.startsWith('UPDATE cloud_usage_reservations SET state=')))throw Error('finalization unavailable');}});

test('explicit upgrade preserves legacy rows and blocks invented refunds',async t=>{
 const {db,budget}=await fixture(t,false),old=await budget.reserve();
 const base=(await all(db,'SELECT body FROM cloud_usage_policy'))[0].body;
 await migrate(db,'013-usage-operations.sql');const ops=new D1UsageOperations(db);
 assert.equal((await all(db,'SELECT body FROM cloud_usage_policy'))[0].body,base);
 assert.equal((await ops.listReservations()).items[0].reservation_id,old.id);
 assert.equal((await ops.previewRecovery(old.id)).reason,'legacy_context_missing');
 assert.equal((await ops.previewPolicy(policy(),'same limits')).status,'blocked');
 assert.equal((await budget.snapshot()).reservations[0].state,'held');
 await assert.rejects(db.prepare("INSERT INTO cloud_usage_reservations(id,day,state,created_at) VALUES(?,1,'held',?)").bind(randomUUID(),new Date().toISOString()).all(),/skilly_usage_admission_required/);
});

test('policy preview writes nothing; concurrent applies, stale hashes and repeated keys preserve one version',async t=>{
 const {db,budget,ops}=await fixture(t),changed=policy();changed.daily.requests=150;
 const initial=await all(db,'SELECT * FROM cloud_usage_control'),preview=await ops.previewPolicy(changed,'more requests');
 assert.deepEqual(await all(db,'SELECT * FROM cloud_usage_control'),initial);assert.equal(preview.changes[0].field,'daily.requests');
 const options={reason:'more requests',expected_hash:preview.expected_hash,idempotency_key:'policy-a'};
 const result=await Promise.allSettled([ops.applyPolicy(changed,options),new D1UsageOperations(db).applyPolicy(changed,{...options,idempotency_key:'policy-b'})]);
 assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.filter(r=>r.status==='rejected').length,1);
 assert.equal((await all(db,'SELECT count(*) n FROM cloud_usage_policy_versions'))[0].n,2);
 const winner=result[0].status==='fulfilled'?'policy-a':'policy-b',repeat={...options,idempotency_key:winner};
 assert.equal((await new D1UsageOperations(db).applyPolicy(changed,repeat)).version,2);
 await assert.rejects(ops.applyPolicy({...changed,accepted_write_bytes:1},repeat),{code:'idempotency_conflict'});
 await assert.rejects(ops.applyPolicy(changed,{...options,idempotency_key:'stale'}),{code:'preview_changed'});
 assert.equal((await budget.policy()).daily.requests,150);
});

test('usage drift invalidates previews; lowering limits preserves old reservation prices',async t=>{
 const {db,budget,ops}=await fixture(t),lower=policy();lower.request.rows_read=100;lower.request.rows_written=10;
 const before=await ops.previewPolicy(lower,'smaller next requests'),r=await budget.reserve();await r.attach(person('alice'));
 await assert.rejects(ops.applyPolicy(lower,{reason:'smaller next requests',expected_hash:before.expected_hash,idempotency_key:'stale-usage'}),{code:'preview_changed'});
 const preview=await ops.previewPolicy(lower,'smaller next requests');await ops.applyPolicy(lower,{reason:'smaller next requests',expected_hash:preview.expected_hash,idempotency_key:'lower'});
 const s=r.bind(db).withSession('first-primary');await s.batch([s.prepare("INSERT INTO usage_items VALUES('old','preserved')")]);await r.finish();
 let state=await budget.snapshot(),completion=JSON.parse(state.reservations.find(x=>x.id===r.id).observed_json);
 assert.equal(account(state).rows_read,completion.rows_read);assert.equal(account(state).rows_written,completion.rows_written);
 const next=await budget.reserve();assert.equal((await all(db,'SELECT policy_version FROM cloud_usage_context WHERE reservation_id=?',next.id))[0].policy_version,2);
 await next.finish();state=await budget.snapshot();assert.ok(account(state).rows_read>=0);
});

test('policy read before a concurrent change cannot admit a stale reservation',async t=>{
 const {db,ops}=await fixture(t);let release,reach;
 const gate=new Promise(r=>release=r),reached=new Promise(r=>reach=r);t.after(()=>release());
 const delayed=wrapped(db,{beforeBatch:async queries=>{if(queries.some(q=>q.startsWith('UPDATE cloud_usage_control SET revision=revision+1 WHERE id=1 AND policy_version='))){reach();await gate;}}});
 const pending=new D1UsageBudget(delayed).reserve();void pending.catch(()=>{});await reached;
 const changed=policy();changed.daily.requests=200;const preview=await ops.previewPolicy(changed,'concurrent policy');
 await ops.applyPolicy(changed,{reason:'concurrent policy',expected_hash:preview.expected_hash,idempotency_key:'concurrent'});release();
 await assert.rejects(pending,{code:'usage_state_changed'});assert.equal((await all(db,'SELECT count(*) n FROM cloud_usage_reservations'))[0].n,0);
});

test('saved native completion resumes on a new connection and refunds at most once after lost recovery response',async t=>{
 const {db,ops}=await fixture(t),r=await new D1UsageBudget(lostFinalization(db)).reserve();await r.attach(person('alice'));await r.acceptWrite(8);
 const s=r.bind(db).withSession('first-primary');await s.batch([s.prepare("INSERT INTO usage_items VALUES('original','saved once')")]);
 await assert.rejects(r.finish(),{code:'usage_unavailable'});
 const list=await ops.listReservations();assert.equal(list.items[0].completion_saved,true);assert.equal(list.items[0].state,'held');
 const preview=await ops.previewRecovery(r.id);assert.equal(preview.action,'apply_observed_completion');
 const lost=wrapped(db,{afterBatch:()=>{throw Error('response lost after operation commit');}}),options={expected_hash:preview.expected_hash,idempotency_key:'recover-observed'};
 await assert.rejects(new D1UsageOperations(lost).recover(r.id,options),{code:'persistence_unknown'});
 const first=(await new D1UsageBudget(db).snapshot()),observed=JSON.parse(first.reservations[0].observed_json);
 const result=await new D1UsageOperations(db).recover(r.id,options);assert.equal(result.charges_returned,true);
 assert.equal((await ops.getOperation('recover-observed')).found,true);
 assert.deepEqual(await new D1UsageBudget(db).snapshot(),first);assert.equal(account(first).rows_read,observed.rows_read);
 assert.equal(first.storage[0].accepted_write_bytes,8);assert.equal((await all(db,'SELECT count(*) n FROM usage_items'))[0].n,1);
 await assert.rejects(s.prepare("INSERT INTO usage_items VALUES('late','must not run')").all());
});

test('policy response loss is recovered by the original key without appending twice',async t=>{
 const {db,ops}=await fixture(t),changed=policy();changed.accepted_write_bytes=200000;
 const preview=await ops.previewPolicy(changed,'raise logical write budget'),options={reason:'raise logical write budget',expected_hash:preview.expected_hash,idempotency_key:'lost-policy'};
 const lost=wrapped(db,{afterBatch:()=>{throw Error('lost acknowledgement');}});
 await assert.rejects(new D1UsageOperations(lost).applyPolicy(changed,options),{code:'persistence_unknown'});
 assert.equal((await new D1UsageOperations(db).applyPolicy(changed,options)).version,2);
 assert.equal((await all(db,'SELECT count(*) n FROM cloud_usage_policy_versions'))[0].n,2);
});

test('unknown completions retain full charges; another unresolved reservation prevents clearing its block',async t=>{
 const {db,budget,ops}=await fixture(t),a=await budget.reserve(),b=await budget.reserve();await a.attach(person('alice'));await b.attach(person('bob'));
 const unknown=wrapped(db,{afterRead:(_q,result)=>({...result,meta:{changes:result.meta.changes}})});
 for(const r of [a,b]){await assert.rejects(r.bind(unknown).withSession('first-primary').prepare('SELECT * FROM usage_items').all(),{code:'usage_measurement_unknown'});await r.finish();}
 const before=await budget.snapshot(),pa=await ops.previewRecovery(a.id);assert.equal(pa.refundable,false);
 await ops.recover(a.id,{expected_hash:pa.expected_hash,idempotency_key:'retain-a'});
 let state=await budget.snapshot();assert.equal(account(state).blocked,1);assert.equal(account(state).rows_read,account(before).rows_read);
 await assert.rejects(budget.reserve(),{code:'usage_limit'});
 const pb=await ops.previewRecovery(b.id);await ops.recover(b.id,{expected_hash:pb.expected_hash,idempotency_key:'retain-b'});
 state=await budget.snapshot();assert.equal(account(state).blocked,0);assert.equal(account(state).rows_read,account(before).rows_read);
 assert.equal((await ops.listReservations()).items.length,0);assert.equal(state.reservations.filter(x=>x.state==='uncertain').length,2);
 const next=await budget.reserve();await next.finish();assert.equal(state.storage[0].accepted_write_bytes,0);
});

test('quiescent held recovery fences the old owner without refund; active or unconfirmed native calls remain blocked',async t=>{
 const {db,budget,ops}=await fixture(t),quiet=await budget.reserve();await quiet.attach(person('alice'));
 const before=account(await budget.snapshot()),preview=await ops.previewRecovery(quiet.id);assert.equal(preview.action,'retain_unconfirmed_charge');
 const result=await ops.recover(quiet.id,{expected_hash:preview.expected_hash,idempotency_key:'close-quiet'});assert.equal(result.charges_returned,false);
 await assert.rejects(quiet.bind(db).withSession('first-primary').prepare("INSERT INTO usage_items VALUES('forbidden','late')").all());
 await assert.rejects(quiet.finish());assert.equal((await all(db,'SELECT count(*) n FROM usage_items'))[0].n,0);
 assert.equal(account(await budget.snapshot()).rows_read,before.rows_read);
 let release,reach;const gate=new Promise(r=>release=r),reached=new Promise(r=>reach=r);t.after(()=>release());
 const late=await budget.reserve(),delayed=wrapped(db,{afterBatch:async()=>{reach();await gate;}}),s=late.bind(delayed).withSession('first-primary');
 const pending=s.batch([s.prepare("INSERT INTO usage_items VALUES('native','preserved')")]);await reached;
 const blocked=await ops.previewRecovery(late.id);assert.equal(blocked.status,'blocked');assert.equal(blocked.reason,'native_inflight_or_unconfirmed');
 await assert.rejects(ops.recover(late.id,{expected_hash:blocked.expected_hash,idempotency_key:'cannot-close-live'}),{code:'recovery_blocked'});
 release();await pending;await late.finish();assert.equal((await all(db,'SELECT count(*) n FROM usage_items'))[0].n,1);
});

test('lost native end bookkeeping is not proof of zero inflight work',async t=>{
 const {db,ops}=await fixture(t),lost=wrapped(db,{beforeBatch:queries=>{if(queries.some(q=>q.includes('SET pending=pending-1')))throw Error('native completion not recorded');}});
 const r=await new D1UsageBudget(lost).reserve();await r.bind(db).withSession('first-primary').prepare('SELECT * FROM usage_items').all();await assert.rejects(r.finish());
 const preview=await ops.previewRecovery(r.id);assert.equal(preview.status,'blocked');assert.equal((await ops.listReservations()).items[0].execution_lease_pending,1);
});

test('late dispatch bookkeeping cannot start business SQL after request termination',async t=>{
 const {db}=await fixture(t);let release,reach;
 const gate=new Promise(r=>release=r),reached=new Promise(r=>reach=r);t.after(()=>release());
 const delayed=wrapped(db,{afterBatch:async queries=>{if(queries.some(q=>q.includes('SET pending=pending+1'))){reach();await gate;}}});
 const r=await new D1UsageBudget(delayed).reserve();let aborted=false,dispatched=false;
 const s=r.bind(db,{check:()=>{if(aborted)throw Error('request ended');},write:()=>{dispatched=true;}}).withSession('first-primary');
 const pending=s.batch([s.prepare("INSERT INTO usage_items VALUES('after-stop','must not run')")]);void pending.catch(()=>{});
 await reached;aborted=true;await r.finish();release();await assert.rejects(pending);await r.finish();
 assert.equal(dispatched,false);assert.equal((await all(db,'SELECT count(*) n FROM usage_items'))[0].n,0);
 assert.equal((await all(db,'SELECT pending FROM cloud_usage_context WHERE reservation_id=?',r.id))[0].pending,0);
});

test('unresolved pagination finds old rows beyond the latest100 without classifying them as crashes',async t=>{
 const {db,ops}=await fixture(t,false),items=Array.from({length:230},(_,i)=>({id:randomUUID(),state:i<130?'uncertain':'settled',created_at:new Date(Date.UTC(2026,0,1)+i*1000).toISOString()}));
 await db.prepare(`INSERT INTO cloud_usage_reservations(id,day,state,created_at) SELECT json_extract(value,'$.id'),1,json_extract(value,'$.state'),json_extract(value,'$.created_at') FROM json_each(?)`).bind(JSON.stringify(items)).all();
 await migrate(db,'013-usage-operations.sql');
 let cursor,found=[];do{const page=await ops.listReservations({limit:40,...(cursor?{after:cursor}:{})});found.push(...page.items);cursor=page.next_cursor;assert.equal(page.native_liveness,'unknown');}while(cursor);
 assert.equal(found.length,130);assert.equal(new Set(found.map(x=>x.reservation_id)).size,130);assert.equal(found.every(x=>x.legacy_context_missing&&x.work_persistence==='unknown'),true);
});
