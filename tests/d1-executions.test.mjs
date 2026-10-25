import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { D1AtomicCommitStore } from '../dist/adapters/storage/d1/atomic-store.js';
import { D1Executions } from '../dist/adapters/storage/d1/executions.js';
import { D1Plans } from '../dist/adapters/storage/d1/plans.js';
import { observeCommand } from '../dist/runtime/local/process-observer.js';
import { observeSource } from '../dist/adapters/project/source-version.js';
import {sourceRepository} from './support/source-repository.mjs';
import { d1WorkerModules } from './support/d1-modules.mjs';

const at='2026-10-24T00:00:00.000Z',hash=x=>createHash('sha256').update(x).digest('hex');
// Synthetic observation fixtures exercise boundaries. Actual child-process collection is tested separately.
const result={outcome:'exited',exit_code:0,signal:null,error_code:null,duration_ms:1,stdout_bytes:0,stderr_bytes:0,
  stdout_hash:hash(''),stderr_hash:hash(''),stdout_hashed_bytes:0,stderr_hashed_bytes:0,output_complete:1};
const details={status:'collected',framework:'node_test',counts:{tests:1,passed:1,failed:0,cancelled:0,skipped:0,todo:0,suites:0},
  suite_success:true,failures:[],failures_truncated:false};
function fault(db,c) {
  return {withSession(constraint){const s=db.withSession(constraint);return {
    prepare(sql){if(c.blockReceipt&&c.committed&&sql.startsWith('SELECT payload_hash'))return {bind(){return this;},async all(){throw Error('injected receipt unavailable');}};return s.prepare(sql);},
    async batch(statements){c.count=statements.length;const submitted=[...statements];
      if(c.failBefore!==undefined)submitted.splice(c.failBefore,0,s.prepare('INSERT INTO evidence_fault VALUES(0)'));
      if(c.beforeBatch){const hook=c.beforeBatch;c.beforeBatch=null;await hook();}
      const res=await s.batch(submitted);c.committed=true;
      if(c.loseResponse){c.loseResponse=false;throw Error('injected response loss after actual local D1 commit');}return res;
    }};}};
}

test('actual local D1 runner evidence and plan links',{timeout:120000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'skilly-d1-evidence-')),repo=sourceRepository(root);
  const options={...d1WorkerModules(fileURLToPath(new URL('./support/d1-runtime-worker.mjs',import.meta.url))),
    compatibilityDate:'2026-07-30',d1Databases:{DB:randomUUID()},d1Persist:join(root,'d1'),host:'127.0.0.1',port:0,
    outboundService:()=>new Response('outbound disabled',{status:403})};
  let mf=new Miniflare(options);t.after(()=>mf.dispose());let db=await mf.getD1Database('DB');
  const all=async(sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
  const apply=async names=>{for(const name of names){const sql=readFileSync(new URL('../migrations/d1/'+name,import.meta.url),'utf8')
    .replace(/^--[^\n]*$/gm,'').trim().split(/;\s*(?=CREATE\s|$)/i).filter(Boolean);await db.batch(sql.map(s=>db.prepare(s)));}};
  await apply(['001-atomic-memory.sql','002-work.sql','003-decisions-plans.sql']);
  const scope=f=>({project_id:f.p.id,repository:'api',environment:'test'});
  const receipt=p=>{const key=randomUUID();return {scope:p.id,key,hash:hash(key),result:{status:'persisted'}};};
  const mutation=async(f,extra={})=>{const revision=(await all('SELECT revision FROM projects WHERE id=?',f.p.id))[0].revision;
    return {project:{...f.p,revision:revision+1},expected_revision:revision,receipt:receipt(f.p),...extra};};
  const seed=async()=>{
    const p={id:randomUUID(),key:'test-'+randomUUID(),name:'D1 검사 전용',revision:0,created_at:at};
    const f={p,store:new D1AtomicCommitStore(db,p.id)};
    await f.store.commit({project:p,expected_revision:null,receipt:receipt(p)});
    f.run={id:randomUUID(),project_id:p.id,goal:'합성 테스트용 업무',mode:'change',repository:'api',environment:'test',state:'active',created_at:at,updated_at:at};
    await f.store.commit(await mutation(f,{run:f.run}));
    f.executions=new D1Executions(db,scope(f));f.plans=new D1Plans(db,scope(f));return f;
  };
  const note=async(f,extra={})=>{
    const r={id:randomUUID(),project_id:f.p.id,run_id:f.run.id,topic:'evidence-test',kind:'change',body:'AI 검사 통과 보고입니다. 직접 관측이 아닙니다.',
      repository:'api',environment:'test',source_fingerprint:null,observed_at:at,recorded_at:at,supersedes:null,superseded_by:null,report_origin:'contemporaneous',...extra};
    await f.store.commit(await mutation(f,{record:r}));return r;
  };
  const save=f=>({run_id:f.run.id,idempotency_key:randomUUID(),plan_key:'checks',title:'검사 계획',source_kind:'markdown',source_ref:'selected.md',source_body:'- [ ] 직접 검사 확인\n- [ ] 후속 작업\n'});
  const update=(f,r,ids=[],extra={})=>({run_id:f.run.id,idempotency_key:randomUUID(),plan_key:'checks',version:1,item_key:'item-1',record_id:r.id,
    state:'completed',note:'조건 충족 보고',criteria_results:[{key:'acceptance',met:true,detail:'테스트용 보고, 실제 관측과 별도'}],execution_ids:ids,...extra});
  const source=f=>({version:1,root_hash:hash('synthetic-root'),project_key:f.p.key,repository:'api',environment:'test',observed_at:at,status:'clean',commit:'a'.repeat(40),reason:null});
  const start=(f,extra={})=>({run_id:f.run.id,idempotency_key:randomUUID(),executable:'node',command_hash:hash('synthetic-command'),source_observation:source(f),...extra});
  const finish=(id,extra={})=>({execution_id:id,idempotency_key:randomUUID(),result,details,...extra});
  const worker=async(input,status=200)=>{const res=await mf.dispatchFetch('http://local-evidence.invalid/',{method:'POST',body:JSON.stringify({...input,project_id:input.scope.project_id})});
    const data=await res.json();assert.equal(res.status,status,JSON.stringify(data));return data;};
  const snapshot=async()=>JSON.stringify(await Promise.all(['projects','runs','records','receipts','executions','plan_versions','plan_item_updates','plan_update_executions','skilly_write_assertions']
    .map(table=>all(`SELECT * FROM ${table} ORDER BY 1,2`))));

  await t.test('003 remains readable, and unsupported execution storage never reports an empty success',async()=>{
    const f=await seed();await f.plans.save(save(f));
    assert.equal((await f.plans.query({plan_key:'checks'})).items[0].evidence.status,'unsupported');
    assert.equal((await f.executions.list(f.run.id)).schema_supported,false);
    await assert.rejects(f.executions.start(start(f)),{code:'unsupported_capability'});
  });
  await apply(['004-execution-evidence.sql']);await db.prepare('CREATE TABLE evidence_fault(ok INTEGER NOT NULL CHECK(ok=1)) STRICT').run();

  await t.test('actual Worker persists start and finish; fresh binding recalls details and before/after without asserting current code',async()=>{
    const f=await seed(),input=start(f),saved=await worker({operation:'execution-start',scope:scope(f),input});
    const before=await f.executions.list(f.run.id);assert.equal(before.items[0].outcome,'unconfirmed');assert.equal(before.items[0].test_details.reason,'unfinished');
    await worker({operation:'execution-finish',scope:scope(f),input:finish(saved.execution_id,{source_after:source(f)})});
    const next=await new D1Executions(db,scope(f)).list(f.run.id),item=next.items[0];
    assert.equal(item.exit_code,0);assert.deepEqual(item.test_details,details);assert.equal(item.code_version.comparison.status,'unknown');
    assert.equal(item.code_version.comparison.reason,'comparison_root_not_configured');assert.equal(item.claims_verified,false);
    assert.equal(item.content_stored,false);assert.equal(item.code_version.before.commit,source(f).commit);
    assert.deepEqual(await f.executions.start(input),saved);
    await assert.rejects(db.prepare('UPDATE executions SET exit_code=1 WHERE id=?').bind(saved.execution_id).run());
  });
  await t.test('AI-only reported completion has no direct evidence; exact linked executions remain independently failed/current/stale/conflicting',async()=>{
    const f=await seed(),r=await note(f);await f.plans.save(save(f));const u=await f.plans.update(update(f,r));
    let read=await f.plans.query({plan_key:'checks'});assert.equal(read.progress.percent,50);assert.equal(read.items[0].evidence.linked,0);
    assert.equal(read.items[0].evidence.status,'unknown');
    const a=await f.executions.start(start(f));await f.executions.finish(finish(a.execution_id,{source_after:source(f)}));
    const b=await f.executions.start(start(f));const bad={...details,counts:{...details.counts,passed:0,failed:1},suite_success:false,failures:['intentional synthetic failure']};
    await f.executions.finish(finish(b.execution_id,{result:{...result,exit_code:1},details:bad,source_after:source(f)}));
    await f.plans.update(update(f,r,[a.execution_id,b.execution_id],{expected_update_id:u.update_id}));
    const fresh=new D1Plans(db,scope(f),()=>source(f));read=await fresh.query({plan_key:'checks'});
    assert.equal(read.items[0].evidence.status,'conflict');assert.equal(read.execution_details.items.find(x=>x.id===b.execution_id).test_details.failures[0],bad.failures[0]);
    assert.equal(read.progress.percent,50);assert.equal(read.claims_verified,false);
    const stale=await new D1Plans(db,scope(f),()=>({...source(f),commit:'b'.repeat(40)})).query({plan_key:'checks'});
    assert.equal(stale.items[0].evidence.status,'stale');
    const unknown=await new D1Plans(db,scope(f),()=>({...source(f),status:'dirty',reason:'working_tree_changed',worktree:{policy:'public_source_v1',status:'unavailable',reason:'excluded_changes'}})).query({plan_key:'checks'});
    assert.equal(unknown.items[0].evidence.status,'unknown');
  });
  await t.test('source fingerprints distinguish dirty equality/change; no provider and foreign roots stay unknown',async()=>{
    const f=await seed(),s={...source(f),status:'dirty',reason:'working_tree_changed',worktree:{policy:'public_source_v1',status:'collected',sha256:hash('same'),files:1,bytes:10,excluded:0}};
    const a=await f.executions.start(start(f,{source_observation:s}));await f.executions.finish(finish(a.execution_id,{source_after:s}));
    assert.equal((await new D1Executions(db,scope(f),()=>s).list(f.run.id)).items[0].code_version.comparison.status,'same_version');
    assert.equal((await new D1Executions(db,scope(f),()=>({...s,worktree:{...s.worktree,sha256:hash('change')}})).list(f.run.id)).items[0].code_version.comparison.status,'changed');
    assert.equal((await new D1Executions(db,scope(f),()=>({...s,root_hash:hash('other')})).list(f.run.id)).items[0].code_version.comparison.status,'unknown');
  });
  await t.test('scope, source and malformed summary failures leave no partial records; unrelated executions cannot be linked',async()=>{
    const f=await seed(),other=await seed(),r=await note(f);await f.plans.save(save(f));const a=await f.executions.start(start(f));
    for(const input of [start(f,{run_id:other.run.id}),start(f,{record_id:r.id,run_id:other.run.id}),start(f,{source_observation:{...source(f),repository:'web'}}),start(f,{project_id:other.p.id})]) {
      const before=await snapshot();await assert.rejects(f.executions.start(input));assert.equal(await snapshot(),before);
    }
    for(const input of [finish(a.execution_id,{source_after:{...source(f),root_hash:hash('other')}}),
      finish(a.execution_id,{details:{...details,counts:{...details.counts,tests:100}}}),
      finish(a.execution_id,{result:{...result,stdout_hashed_bytes:1}}),
      finish(a.execution_id,{result:{...result,outcome:'timed_out'}})]) {
      const before=await snapshot();await assert.rejects(f.executions.finish(input));assert.equal(await snapshot(),before);
    }
    const foreign=await other.executions.start(start(other));
    await assert.rejects(f.plans.update(update(f,r,[foreign.execution_id])),{code:'scope_mismatch'});
    await assert.rejects(f.executions.finish(finish(foreign.execution_id)),{code:'scope_mismatch'});
    for(const s of [{...scope(f),repository:'web'},{...scope(f),environment:'production'},scope(other)])assert.deepEqual((await new D1Executions(db,s).list(f.run.id)).items,[]);
  });
  await t.test('finish is once-only and replay-safe, including after the owning task has ended',async()=>{
    const f=await seed(),input=start(f),saved=await f.executions.start(input);
    await assert.rejects(f.executions.start({...input,executable:'different'}),{code:'idempotency_conflict'});
    await f.store.commit(await mutation(f,{run:{...f.run,state:'completed'}}));
    const final=finish(saved.execution_id,{source_after:source(f)}),receipt=await f.executions.finish(final);
    assert.deepEqual(await new D1Executions(db,scope(f)).finish(final),receipt);
    await assert.rejects(f.executions.finish({...final,idempotency_key:randomUUID()}),{code:'conflict'});
    await assert.rejects(f.executions.finish({...final,result:{...result,exit_code:1}}),{code:'idempotency_conflict'});
    await assert.rejects(f.executions.start(start(f)),{code:'scope_mismatch'});
  });
  await t.test('unconfirmed, launch failure, timeout and interruption stay unknown, and failed tests never become a passed verdict',async()=>{
    const f=await seed(),r=await note(f);await f.plans.save(save(f));
    const pending=await f.executions.start(start(f));let expected=null;
    for(const outcome of ['launch_failed','timed_out','interrupted']) {
      const a=await f.executions.start(start(f,{source_observation:undefined}));
      await assert.rejects(f.executions.finish(finish(a.execution_id,{source_after:source(f)})),{code:'scope_mismatch'});
      await f.executions.finish(finish(a.execution_id,{result:{...result,outcome,exit_code:null},details:{status:'not_collected',reason:'interrupted'}}));
      const u=await f.plans.update(update(f,r,[a.execution_id],{expected_update_id:expected}));expected=u.update_id;
      const item=(await new D1Plans(db,scope(f),()=>source(f)).query({plan_key:'checks'})).items[0];
      assert.equal(item.evidence.status,'unknown');assert.equal(item.evidence.observations[0].outcome,outcome);
    }
    const u=await f.plans.update(update(f,r,[pending.execution_id],{expected_update_id:expected}));
    let item=(await f.plans.query({plan_key:'checks'})).items[0];assert.equal(item.evidence.observations[0].outcome,'unconfirmed');
    const a=await f.executions.start(start(f));
    await f.executions.finish(finish(a.execution_id,{result:{...result,exit_code:1},details:{...details,counts:{...details.counts,passed:0,failed:1},suite_success:false,failures:['synthetic failing check']},source_after:source(f)}));
    const v=await f.plans.update(update(f,r,[a.execution_id],{expected_update_id:u.update_id}));
    item=(await new D1Plans(db,scope(f),()=>source(f)).query({plan_key:'checks'})).items[0];
    assert.equal(item.evidence.status,'current');assert.equal(item.evidence.counts.failed,1);assert.equal(item.evidence.observations[0].result,'failed');
    await note(f,{supersedes:r.id});
    const review=await f.plans.query({plan_key:'checks'});assert.equal(review.items[0].state,'needs_review');assert.equal(review.progress.percent,0);
    assert.equal(review.items[0].update_id,v.update_id);assert.equal(review.items[0].evidence.linked,1);
  });
  await t.test('bounded pages advance, input/detail limits reject atomically, and process start fails before executing on a lost start receipt',async()=>{
    const f=await seed();
    for(let i=0;i<12;i++)await f.executions.start(start(f));
    const first=await f.executions.list(f.run.id);assert.equal(first.items.length,10);assert.equal(first.next_offset,10);
    const second=await f.executions.list(f.run.id,first.next_offset);assert.equal(second.items.length,2);assert.equal(second.next_offset,null);
    assert.equal(new Set([...first.items,...second.items].map(x=>x.id)).size,12);
    const id=first.items[0].id,before=await snapshot();
    await assert.rejects(f.executions.finish(finish(id,{details:{...details,failures:Array(21).fill('failure')}})),{code:'invalid_input'});
    await assert.rejects(f.executions.start(start(f,{executable:'x'.repeat(81)})),{code:'invalid_input'});assert.equal(await snapshot(),before);
    await assert.rejects(f.executions.list(f.run.id,100001),{code:'invalid_input'});
    const marker=join(root,'must-not-run.txt'),file=join(root,'before-start.mjs');
    writeFileSync(file,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'x');`);
    const c={loseResponse:true,blockReceipt:true},input=start(f),sink={start:async()=>{
      const a=await new D1Executions(fault(db,c),scope(f)).start(input);return a.execution_id;},finish:async()=>{throw Error('must not finish');}};
    await assert.rejects(observeCommand({command:process.execPath,args:[file],root:repo,timeout:10000,testFormat:'auto',start:{project_id:f.p.id,run_id:f.run.id},sink,source:()=>source(f)}),{code:'persistence_unknown'});
    assert.equal(existsSync(marker),false);await f.executions.start(input);assert.equal(existsSync(marker),false);
  });
  await t.test('all start/finish/link batch SQL boundaries roll back; CAS races and receipt collisions commit no partial evidence',async()=>{
    const f=await seed(),input=start(f),control={failBefore:0},ex=new D1Executions(fault(db,control),scope(f));
    let before=await snapshot();await assert.rejects(ex.start(input),{code:'persistence_unknown'});let n=control.count;
    for(let i=1;i<=n;i++){control.failBefore=i;await assert.rejects(ex.start(input),{code:'persistence_unknown'});assert.equal(await snapshot(),before);}
    const a=await f.executions.start(input),final=finish(a.execution_id,{source_after:source(f)});control.failBefore=0;before=await snapshot();
    await assert.rejects(ex.finish(final),{code:'persistence_unknown'});n=control.count;
    for(let i=1;i<=n;i++){control.failBefore=i;await assert.rejects(ex.finish(final),{code:'persistence_unknown'});assert.equal(await snapshot(),before);}
    await f.executions.finish(final);const r=await note(f);await f.plans.save(save(f));
    const u=update(f,r,[a.execution_id]),pc={failBefore:0},plans=new D1Plans(fault(db,pc),scope(f));before=await snapshot();
    await assert.rejects(plans.update(u),{code:'persistence_unknown'});n=pc.count;
    for(let i=1;i<=n;i++){pc.failBefore=i;await assert.rejects(plans.update(u),{code:'persistence_unknown'});assert.equal(await snapshot(),before);}
    const stale=await mutation(f);stale.execution={operation:'start',input:{...start(f),...scope(f),idempotency_key:stale.receipt.key},id:randomUUID(),at:new Date().toISOString()};
    const race={beforeBatch:async()=>{await f.store.commit(await mutation(f));}};
    assert.equal(await new D1AtomicCommitStore(fault(db,race),f.p.id).commit(stale),'conflict');
    const replay=await mutation(f);replay.receipt=await f.store.getReceipt(f.p.id,input.idempotency_key);
    replay.execution={operation:'start',input:{...start(f),...scope(f),idempotency_key:input.idempotency_key},id:randomUUID(),at:new Date().toISOString()};
    before=await snapshot();assert.equal(await f.store.commit(replay),'conflict');assert.equal(await snapshot(),before);
  });
  await t.test('20 items sharing four large observations stay readable; oversized distinct details are explicitly omitted without losing progress',async()=>{
    const f=await seed(),r=await note(f),items=Array.from({length:20},(_,i)=>({key:'item-'+(i+1),title:'항목 '+i,
      required:true,source_checked:false,criteria:[{key:'acceptance',text:'동작 확인'}]}));
    await f.plans.save({...save(f),source_kind:'conversation',source_body:'대형 근거 반복 테스트 계획',items});
    const ids=[],large={...details,counts:{...details.counts,tests:20,passed:0,failed:20},suite_success:false,
      failures:Array.from({length:20},(_,i)=>String(i).padStart(3,'0')+'x'.repeat(197))};
    for(let i=0;i<12;i++){const a=await f.executions.start(start(f));ids.push(a.execution_id);await f.executions.finish(finish(a.execution_id,{result:{...result,exit_code:1},details:large,source_after:source(f)}));}
    for(let i=0;i<20;i++)await f.plans.update(update(f,r,ids.slice(0,4),{item_key:'item-'+(i+1)}));
    let plan=await new D1Plans(db,scope(f),()=>source(f)).query({plan_key:'checks'});
    assert.equal(plan.progress.percent,100);assert.equal(plan.items.length,20);assert.equal(plan.execution_details.items.length,4);
    assert.equal(new Set(plan.execution_details.items.map(x=>x.id)).size,4);assert.equal(plan.execution_details.truncated,true);
    assert.ok(Buffer.byteLength(JSON.stringify(plan))<128*1024);
    for(let i=0;i<3;i++)await f.plans.update(update(f,r,ids.slice(4*i,4*i+4),{item_key:'item-'+(i+1),expected_update_id:plan.items[i].update_id}));
    plan=await new D1Plans(db,scope(f),()=>source(f)).query({plan_key:'checks'});
    assert.equal(plan.progress.percent,100);assert.equal(plan.execution_details.truncated,true);assert.ok(plan.execution_details.omitted_execution_ids.length>0);
    assert.equal(plan.items[0].evidence.linked,4);assert.equal(plan.items[0].evidence.truncated,false);
    const omitted=plan.execution_details.omitted_execution_ids[0],full=[];let offset=0;
    do{const page=await f.executions.list(f.run.id,offset);full.push(...page.items);offset=page.next_offset;}while(offset!==null);
    assert.equal(full.find(x=>x.id===omitted).test_details.failures.length,20);
    assert.ok(Buffer.byteLength(JSON.stringify(plan))<128*1024);
    // Storage accepts bounded untrusted strings. Escaping expands these valid names sixfold inside SQL JSON.
    const escaped=[];
    for(let i=0;i<4;i++){const a=await f.executions.start(start(f));escaped.push(a.execution_id);
      await f.executions.finish(finish(a.execution_id,{result:{...result,exit_code:1},details:{...large,failures:Array(20).fill('\u0001'.repeat(200))},source_after:source(f)}));}
    for(let i=0;i<20;i++)await f.plans.update(update(f,r,escaped,{item_key:'item-'+(i+1),expected_update_id:plan.items[i].update_id}));
    plan=await new D1Plans(db,scope(f),()=>source(f)).query({plan_key:'checks'});
    assert.equal(plan.progress.percent,100);assert.equal(plan.items.length,20);assert.equal(plan.execution_details.truncated,true);
    assert.ok(Buffer.byteLength(JSON.stringify(plan))<128*1024);
  });
  await t.test('lost start/finish responses replay the original stored receipt without replaying a process',async()=>{
    const f=await seed(),input=start(f),c={loseResponse:true,blockReceipt:true};
    await assert.rejects(new D1Executions(fault(db,c),scope(f)).start(input),{code:'persistence_unknown'});
    const saved=await new D1Executions(db,scope(f)).start(input);assert.equal((await f.executions.list(f.run.id)).items.length,1);
    const final=finish(saved.execution_id,{source_after:source(f)}),c2={loseResponse:true,blockReceipt:true};
    await assert.rejects(new D1Executions(fault(db,c2),scope(f)).finish(final),{code:'persistence_unknown'});
    assert.equal((await new D1Executions(db,scope(f)).finish(final)).outcome,'exited');
    assert.equal((await f.executions.list(f.run.id)).items[0].test_details.counts.passed,1);
  });

  let actual;
  await t.test('real local child-process collector stores pass/fail counts and failure names directly in D1, not from AI reports',async()=>{
    const f=await seed(),r=await note(f);await f.plans.save(save(f));
    const binding={version:1,key:f.p.key,name:f.p.name,repository:'api',environment:'test'};
    const sourceProvider=()=>observeSource(repo,binding),ex=new D1Executions(db,scope(f),sourceProvider),retained=[];
    // This host bridge submits only collector-produced results. No external service or agent-write tool exists.
    const sink={start:async({project_id,...input})=>{assert.equal(project_id,f.p.id);return (await ex.start({...input,idempotency_key:randomUUID()})).execution_id;},
      finish:async(id,result,details,source_after)=>{const input={execution_id:id,idempotency_key:randomUUID(),result,details,source_after};retained.push(input);await ex.finish(input);}};
    const pass=join(root,'pass.test.mjs'),fail=join(root,'fail.test.mjs');
    writeFileSync(pass,"import test from 'node:test';import assert from 'node:assert/strict';test('actual passing case',()=>assert.equal(2+2,4));\n");
    writeFileSync(fail,"import test from 'node:test';test('intentional actual failing case',()=>{throw Error('expected fixture failure');});\n");
    const run=async path=>observeCommand({command:process.execPath,args:['--test',path],root:repo,timeout:10000,testFormat:'auto',start:{project_id:f.p.id,run_id:f.run.id,record_id:r.id},sink,source:sourceProvider});
    // This fixture runs the host collector inside node:test, unlike the real CLI process.
    // Do not make its child inherit Node's private test-worker mode.
    const context=process.env.NODE_TEST_CONTEXT;let good,bad;
    try{delete process.env.NODE_TEST_CONTEXT;good=await run(pass);bad=await run(fail);}
    finally{if(context!==undefined)process.env.NODE_TEST_CONTEXT=context;}
    assert.equal(good.code,0);assert.equal(bad.code,1);
    const read=await new D1Executions(db,scope(f),sourceProvider).list(f.run.id),a=read.items.find(x=>x.id===good.execution_id),b=read.items.find(x=>x.id===bad.execution_id);
    assert.equal(a.test_details.counts.passed,1);assert.equal(b.test_details.counts.failed,1);assert.deepEqual(b.test_details.failures,['intentional actual failing case']);
    assert.equal(a.code_version.comparison.status,'same_version');assert.equal(a.provenance,'local_runner');assert.equal(a.claims_verified,false);
    const u=await f.plans.update(update(f,r,[good.execution_id]));
    const plan=await new D1Plans(db,scope(f),sourceProvider).query({plan_key:'checks'});
    assert.equal(plan.items[0].evidence.status,'current');assert.equal(plan.execution_details.items[0].test_details.counts.passed,1);
    assert.equal(plan.progress.remaining,1);assert.equal(plan.claims_verified,false);
    // Source file and output contents are not persisted. Retained retry DTO is test memory, not a command replay queue.
    assert.equal(existsSync(pass),true);actual={f,good,bad,u,retained};
  });
  await t.test('storage failure after a real process never reruns it, and the original finish DTO can recover',async()=>{
    const f=await seed(),marker=join(root,'only-once.txt'),inputFile=join(root,'once.mjs');
    writeFileSync(inputFile,`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(marker)},'x');`);
    let retained;const c={loseResponse:true,blockReceipt:true};
    const sink={start:async({project_id,...input})=>{assert.equal(project_id,f.p.id);return (await f.executions.start({...input,idempotency_key:randomUUID()})).execution_id;},
      finish:async(id,result,details,source_after)=>{retained={execution_id:id,idempotency_key:randomUUID(),result,details,source_after};await new D1Executions(fault(db,c),scope(f)).finish(retained);}};
    const binding={version:1,key:f.p.key,name:f.p.name,repository:'api',environment:'test'};
    await assert.rejects(observeCommand({command:process.execPath,args:[inputFile],root:repo,timeout:10000,testFormat:'auto',start:{project_id:f.p.id,run_id:f.run.id},sink,source:()=>observeSource(repo,binding)}),{code:'execution_save_failed'});
    assert.equal(readFileSync(marker,'utf8'),'x');await f.executions.finish(retained);assert.equal(readFileSync(marker,'utf8'),'x');
  });
  await t.test('workerd restart preserves actual observations, plan links, reported progress and remaining items',async()=>{
    const {f,good,bad}=actual;
    const before=await f.plans.query({plan_key:'checks'}),observed=await f.executions.list(f.run.id);
    await mf.dispose();mf=new Miniflare(options);db=await mf.getD1Database('DB');
    const after=await worker({operation:'plans',scope:scope(f),query:{plan_key:'checks'}});
    const next=await worker({operation:'executions',scope:scope(f),run_id:f.run.id});
    assert.deepEqual(after,before);assert.deepEqual(next,observed);
    assert.equal(after.items[0].evidence.observations[0].execution_id,good.execution_id);assert.equal(after.items[0].evidence.status,'unknown');
    assert.equal(next.items.find(x=>x.id===bad.execution_id).test_details.counts.failed,1);
  });
});
