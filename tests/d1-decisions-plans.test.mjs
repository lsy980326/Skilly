import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { D1AtomicCommitStore } from '../dist/adapters/storage/d1/atomic-store.js';
import { D1Decisions } from '../dist/adapters/storage/d1/decisions.js';
import { D1Plans } from '../dist/adapters/storage/d1/plans.js';
import { d1WorkerModules } from './support/d1-modules.mjs';

const now='2026-10-24T00:00:00.000Z';
const hash=value=>createHash('sha256').update(value).digest('hex');
const component={key:'api',name:'API'},feature={key:'comments',name:'댓글'};
const source='기존 계획 원문\n- [x] API 상태 저장\n- [ ] 새 연결에서 조회\n';
const condition={key:'acceptance',met:true,detail:'테스트용 완료 보고입니다. 실제 검사 근거와 구분합니다.'};
function fault(db,c) {
  return {withSession(constraint){c.sessions=(c.sessions??0)+1;const s=db.withSession(constraint);return {
    prepare(sql){if(c.blockReceipt&&c.committed&&sql.startsWith('SELECT payload_hash'))return {bind(){return this;},async all(){throw Error('receipt unavailable');}};return s.prepare(sql);},
    async batch(statements){c.count=statements.length;const submitted=[...statements];
      if(c.failBefore!==undefined)submitted.splice(c.failBefore,0,s.prepare('INSERT INTO business_fault VALUES(0)'));
      if(c.beforeBatch){const hook=c.beforeBatch;c.beforeBatch=null;await hook();}
      const result=await s.batch(submitted);c.committed=true;
      if(c.loseResponse){c.loseResponse=false;throw Error('injected loss AFTER real D1 commit');}return result;
    }};}};
}

test('actual local D1 decisions and versioned plans', {timeout:120000}, async t=>{
  const root=mkdtempSync(join(tmpdir(),'skilly-d1-decisions-plans-'));
  const options={...d1WorkerModules(fileURLToPath(new URL('./support/d1-runtime-worker.mjs',import.meta.url))),
    compatibilityDate:'2026-07-30',d1Databases:{DB:randomUUID()},d1Persist:join(root,'d1'),host:'127.0.0.1',port:0,
    outboundService:()=>new Response('outbound disabled',{status:403})};
  let mf=new Miniflare(options);t.after(()=>mf.dispose());let db=await mf.getD1Database('DB');
  const all=async(sql,...values)=>(await db.prepare(sql).bind(...values).all()).results;
  for(const name of ['001-atomic-memory.sql','002-work.sql','003-decisions-plans.sql']) {
    const sql=readFileSync(new URL('../migrations/d1/'+name,import.meta.url),'utf8').replace(/^--[^\n]*$/gm,'').trim().split(/;\s*(?=CREATE\s|$)/i).filter(Boolean);
    await db.batch(sql.map(s=>db.prepare(s)));
  }
  await db.prepare('CREATE TABLE business_fault(ok INTEGER NOT NULL CHECK(ok=1)) STRICT').run();
  const scoped=p=>({project_id:p.id,repository:'api',environment:'test'});
  const receipt=(p,key=randomUUID())=>({scope:p.id,key,hash:hash(key),result:{status:'persisted',claims_verified:false}});
  const mutation=async(f,extra={})=>{const revision=(await all('SELECT revision FROM projects WHERE id=?',f.p.id))[0].revision;
    return {project:{...f.p,revision:revision+1},expected_revision:revision,run:f.run,receipt:receipt(f.p),...extra};};
  const record=(f,extra={})=>({id:randomUUID(),project_id:f.p.id,run_id:f.run.id,topic:'business',kind:'change',body:'테스트용 작업 원문 기록',
    repository:'api',environment:'test',source_fingerprint:null,observed_at:now,recorded_at:now,supersedes:null,superseded_by:null,report_origin:'contemporaneous',...extra});
  const seed=async()=>{
    const p={id:randomUUID(),key:randomUUID(),name:'D1 업무 테스트',revision:0,created_at:now},store=new D1AtomicCommitStore(db,p.id);
    await store.commit({project:p,expected_revision:null,receipt:receipt(p)});
    const run={id:randomUUID(),project_id:p.id,goal:'테스트용 결정·계획 작업',mode:'change',repository:'api',environment:'test',state:'active',created_at:now,updated_at:now,actor:'Codex'};
    const f={p,run,store,plans:new D1Plans(db,scoped(p)),decisions:new D1Decisions(db,scoped(p))};
    await store.commit(await mutation(f,{work:{run_id:run.id,components:[component],features:[feature],title:'테스트 업무'}}));return f;
  };
  const note=async(f,extra={})=>{const r=record(f,extra);assert.equal(await f.store.commit(await mutation(f,{record:r})),'committed');return r;};
  const decision=(extra={})=>({subject:'test-policy',title:'테스트 전용 선택',action:'decide',choice_key:'a',targets:[],expected_current_ids:[],
    component_key:'api',feature_key:'comments',source:{kind:'user_statement',reference:'synthetic test fixture',quote:'테스트용 선택 A'},...extra});
  const decisionMutation=async(f,d,extra={})=>mutation(f,{record:record(f,{kind:'decision',body:d.source.quote,...extra}),decision:d});
  const query={subject:'test-policy',component_key:'api',feature_key:'comments'};
  const save=f=>({run_id:f.run.id,idempotency_key:randomUUID(),plan_key:'test-plan',expected_version:0,title:'테스트 계획',source_kind:'markdown',source_ref:'docs/selected.md',source_body:source});
  const update=(f,r,extra={})=>({run_id:f.run.id,idempotency_key:randomUUID(),plan_key:'test-plan',version:1,item_key:'item-1',expected_update_id:null,
    record_id:r.id,state:'completed',note:'조건 충족을 보고했습니다.',criteria_results:[condition],execution_ids:[],...extra});
  const worker=async input=>{const res=await mf.dispatchFetch('http://skilly-test.invalid/',{method:'POST',body:JSON.stringify(input)});const data=await res.json();assert.equal(res.status,200,JSON.stringify(data));return data;};
  const snapshot=async()=>JSON.stringify(await Promise.all([
    ...['projects','runs','records','receipts','decision_events','plan_versions','plan_item_updates'].map(table=>all(`SELECT * FROM ${table} ORDER BY 1,2`)),
    all("SELECT rowid FROM record_search WHERE record_search MATCH '기록' ORDER BY rowid"),all('SELECT * FROM skilly_write_assertions')]));

  await t.test('Worker records decide/propose/conflict/replace/withdraw without rewriting originals',async()=>{
    const f=await seed(),a=await decisionMutation(f,decision());
    assert.equal((await worker({operation:'commit',project_id:f.p.id,mutation:a})).status,'committed');
    const first=a.record.id;
    const proposal=await decisionMutation(f,decision({action:'propose',choice_key:'idea',expected_current_ids:[first],source:{kind:'agent_proposal',reference:'test fixture',quote:'AI 제안'}}));
    await f.store.commit(proposal);
    assert.deepEqual((await f.decisions.query(query)).active_record_ids,[first]);
    const b=await decisionMutation(f,decision({choice_key:'b',expected_current_ids:[first]}));await f.store.commit(b);
    const conflict=await worker({operation:'decisions',project_id:f.p.id,scope:scoped(f.p),query});assert.equal(conflict.status,'conflict');
    const replacement=await decisionMutation(f,decision({action:'replace',choice_key:'c',targets:[first,b.record.id],expected_current_ids:[first,b.record.id]}));
    await f.store.commit(replacement);
    const current=await f.decisions.query(query);assert.equal(current.status,'current');assert.deepEqual(current.active_record_ids,[replacement.record.id]);
    const withdrawn=decision({action:'withdraw',choice_key:undefined,targets:[replacement.record.id],expected_current_ids:[replacement.record.id]});
    const c=await decisionMutation(f,withdrawn);await f.store.commit(c);
    const recalled=await worker({operation:'decisions',project_id:f.p.id,scope:scoped(f.p),query});
    assert.equal(recalled.status,'withdrawn');assert.deepEqual(recalled.active_record_ids,[]);assert.equal(recalled.claims_verified,false);
    assert.equal(recalled.history.find(x=>x.record_id===first).state,'previous');assert.equal(recalled.history.find(x=>x.record_id===proposal.record.id).state,'proposal');
    assert.equal((await all('SELECT body,superseded_by FROM records WHERE id=?',first))[0].body,a.record.body);
    assert.equal((await all('SELECT superseded_by FROM records WHERE id=?',first))[0].superseded_by,null);
    await assert.rejects(db.prepare('UPDATE records SET body=? WHERE id=?').bind('overwrite',first).run());
    await assert.rejects(db.prepare('DELETE FROM decision_events WHERE record_id=?').bind(first).run());
  });
  await t.test('stale expected IDs, foreign targets and generic corrections are rejected with no partial writes',async()=>{
    const f=await seed(),a=await decisionMutation(f,decision());await f.store.commit(a);
    for(const d of [decision(),decision({subject:'other',action:'replace',targets:[a.record.id]}),decision({component_key:'web'})]) {
      const c=await decisionMutation(f,d),before=await snapshot();await assert.rejects(f.store.commit(c));assert.equal(await snapshot(),before);
    }
    const generic=await mutation(f,{record:record(f,{kind:'decision',supersedes:a.record.id})}),before=await snapshot();
    await assert.rejects(f.store.commit(generic));assert.equal(await snapshot(),before);
    const sameBatch=await decisionMutation(f,decision({subject:'same-batch'}));
    sameBatch.records=[record(f,{kind:'decision',supersedes:sameBatch.record.id})];
    await assert.rejects(f.store.commit(sameBatch),{code:'invalid_input'});assert.equal(await snapshot(),before);
    const historical=await decisionMutation(f,decision({expected_current_ids:[a.record.id],choice_key:'old'}),{report_origin:'retrospective'});
    await f.store.commit(historical);assert.deepEqual((await f.decisions.query(query)).active_record_ids,[a.record.id]);
    const bad=await decisionMutation(f,decision({action:'withdraw',choice_key:undefined,expected_current_ids:[a.record.id],targets:[a.record.id]}),{report_origin:'retrospective'});
    await assert.rejects(f.store.commit(bad),{code:'invalid_input'});
  });
  await t.test('a revision race after decision snapshot rejects the whole stale mutation',async()=>{
    const f=await seed(),c=await decisionMutation(f,decision()),control={};
    control.beforeBatch=async()=>{await f.store.commit(await mutation(f));};
    const store=new D1AtomicCommitStore(fault(db,control),f.p.id);
    assert.equal(await store.commit(c),'conflict');assert.equal((await f.decisions.query(query)).events_total,0);
  });
  await t.test('Worker saves checked Markdown as pending, reports progress, and reads remaining items on a fresh adapter',async()=>{
    const f=await seed(),input=save(f),r=await note(f);
    const start=await worker({operation:'save-plan',project_id:f.p.id,scope:scoped(f.p),input});
    assert.equal(start.progress.percent,0);assert.equal(start.source_hash,hash(source));
    const initial=await f.plans.query({plan_key:'test-plan'});assert.equal(initial.items[0].source_checked,true);assert.equal(initial.items[0].state,'pending');
    const inProgress=await worker({operation:'update-plan',project_id:f.p.id,scope:scoped(f.p),input:update(f,r,{state:'in_progress',criteria_results:[]})});
    await worker({operation:'update-plan',project_id:f.p.id,scope:scoped(f.p),input:update(f,r,{expected_update_id:inProgress.update_id})});
    const next=await new D1Plans(db,scoped(f.p)).query({plan_key:'test-plan',remaining_only:true});
    assert.equal(next.progress.percent,50);assert.equal(next.progress.required,2);assert.equal(next.items.length,1);assert.equal(next.items[0].key,'item-2');
    assert.equal(next.claims_verified,false);assert.equal(next.plan.source_body,source);
    const full=await worker({operation:'plans',project_id:f.p.id,scope:scoped(f.p),query:{plan_key:'test-plan'}});
    assert.equal(full.items[0].run_id,f.run.id);assert.equal(full.items[0].evidence.status,'unsupported');assert.equal(full.linked_tasks.items[0].run_id,f.run.id);
    const catalog=await f.plans.query();assert.equal(catalog.items[0].progress.percent,50);
  });
  await t.test('missing conditions, stale progress IDs, foreign tasks and unsupported execution links cannot complete items',async()=>{
    const f=await seed();await f.plans.save(save(f));const r=await note(f),other=await seed();
    for(const input of [update(f,r,{criteria_results:[]}),update(f,r,{criteria_results:[{...condition,key:'wrong'}]}),update(f,r,{run_id:other.run.id}),
      update(f,r,{record_id:randomUUID()}),update(f,r,{execution_ids:[randomUUID()]})]){
      const before=await snapshot();await assert.rejects(f.plans.update(input));assert.equal(await snapshot(),before);
    }
    const first=await f.plans.update(update(f,r));
    await assert.rejects(f.plans.update(update(f,r)),{code:'plan_conflict'});
    assert.equal((await f.plans.query({plan_key:'test-plan'})).items[0].update_id,first.update_id);
    const retro=await note(f,{report_origin:'retrospective'});
    await assert.rejects(f.plans.update(update(f,retro,{item_key:'item-2'})),{code:'invalid_evidence'});
  });
  await t.test('new plan versions reset progress; old versions and originals remain readable and immutable',async()=>{
    const f=await seed(),input=save(f);await f.plans.save(input);const r=await note(f);await f.plans.update(update(f,r));
    await assert.rejects(f.plans.save({...input,idempotency_key:randomUUID()}),{code:'plan_conflict'});
    const changed=source+'- [ ] 추가 요구\n';
    await f.plans.save({...input,expected_version:1,source_body:changed,idempotency_key:randomUUID()});
    const latest=await f.plans.query({plan_key:'test-plan'});assert.equal(latest.plan.version,2);assert.equal(latest.progress.percent,0);assert.equal(latest.progress.remaining,3);
    const previous=await f.plans.query({plan_key:'test-plan',version:1});assert.equal(previous.plan.source_body,source);assert.equal(previous.progress.percent,50);
    await assert.rejects(f.plans.update(update(f,r)),{code:'plan_conflict'});
    await assert.rejects(db.prepare('UPDATE plan_versions SET source_body=? WHERE project_id=?').bind('changed',f.p.id).run());
    await assert.rejects(db.prepare('DELETE FROM plan_item_updates WHERE project_id=?').bind(f.p.id).run());
  });
  await t.test('a later correction of the linked report produces needs_review and removes reported completion',async()=>{
    const f=await seed();await f.plans.save(save(f));const r=await note(f);await f.plans.update(update(f,r));
    await note(f,{supersedes:r.id,body:'후속 정정 원문 기록'});
    const read=await f.plans.query({plan_key:'test-plan',remaining_only:true});
    assert.equal(read.items[0].state,'needs_review');assert.equal(read.progress.percent,0);assert.equal(read.progress.remaining,2);
  });
  await t.test('classified plan items require matching task links, and schemas do not read source paths',async()=>{
    const f=await seed(),r=await note(f),input={...save(f),source_kind:'conversation',source_ref:'/not/opened/secret.md',source_body:'대화 계획 원문',
      items:[{key:'api',title:'API',required:true,source_checked:false,component_key:'api',feature_key:'comments',criteria:[{key:'acceptance',text:'동작 보고'}]}]};
    await f.plans.save(input);assert.equal((await f.plans.query({plan_key:'test-plan'})).plan.source_ref,input.source_ref);
    const wrong={...f,run:{...f.run,id:randomUUID()}};await f.store.commit(await mutation(wrong));const foreign=await note(wrong);
    await assert.rejects(f.plans.update(update(wrong,foreign,{item_key:'api'})));assert.equal((await f.plans.query({plan_key:'test-plan'})).progress.percent,0);
    await f.plans.update(update(f,r,{item_key:'api'}));assert.equal((await f.plans.query({plan_key:'test-plan'})).progress.percent,100);
    assert.equal((await f.plans.query({component:'api'})).items.length,1);assert.equal((await f.plans.query({component:'web'})).items.length,0);
  });
  await t.test('host scope isolates decision/plan reads and strict commands reject request-body scope overrides',async()=>{
    const f=await seed(),c=await decisionMutation(f,decision());await f.store.commit(c);await f.plans.save(save(f));
    for(const s of [{...scoped(f.p),repository:'web'},{...scoped(f.p),environment:'production'},scoped((await seed()).p)]) {
      assert.deepEqual((await new D1Decisions(db,s).query(query)).active_record_ids,[]);
      assert.equal((await new D1Plans(db,s).query()).items.length,0);
      await assert.rejects(new D1Plans(db,s).query({plan_key:'test-plan'}),{code:'not_found'});
    }
    await assert.rejects(f.plans.save({...save(f),project_id:randomUUID()}),{code:'invalid_input'});
  });
  await t.test('large untitled task goals do not multiply into an unreadable plan detail',async()=>{
    const f=await seed();f.run={...f.run,id:randomUUID(),goal:'x'.repeat(50000)};
    await f.store.commit(await mutation(f));const r=await note(f);
    await f.plans.save({...save(f),source_body:source+'- [ ] 셋째 조건\n'});
    for(const item_key of ['item-1','item-2','item-3'])await f.plans.update(update(f,r,{item_key}));
    const detail=await new D1Plans(db,scoped(f.p)).query({plan_key:'test-plan'});
    assert.equal(detail.progress.percent,100);assert.equal(detail.items.length,3);
    assert.equal(detail.items[0].task.title.length,200);assert.equal(detail.items[0].task.title_truncated,true);
    assert.ok(Buffer.byteLength(JSON.stringify(detail))<128*1024);
  });
  await t.test('idempotent plan save/update preserve original receipts, different content with same key conflicts',async()=>{
    const f=await seed(),input=save(f),first=await f.plans.save(input);
    assert.deepEqual(await f.plans.save(input),first);
    await assert.rejects(f.plans.save({...input,title:'다른 제목'}),{code:'idempotency_conflict'});
    const r=await note(f),u=update(f,r),result=await f.plans.update(u);
    assert.deepEqual(await f.plans.update(u),result);
    await assert.rejects(f.plans.update({...u,state:'blocked'}),{code:'idempotency_conflict'});
  });
  await t.test('real SQL failures at every decision and plan batch boundary roll back originals, sidecars and receipts',async()=>{
    const f=await seed(),c=await decisionMutation(f,decision()),control={failBefore:0};
    const store=new D1AtomicCommitStore(fault(db,control),f.p.id),before=await snapshot();
    await assert.rejects(store.commit(c),{code:'persistence_unknown'});const n=control.count;
    for(let i=1;i<=n;i++){control.failBefore=i;await assert.rejects(store.commit(c),{code:'persistence_unknown'});assert.equal(await snapshot(),before);}
    const pControl={failBefore:0},plans=new D1Plans(fault(db,pControl),scoped(f.p)),input=save(f);
    await assert.rejects(plans.save(input),{code:'persistence_unknown'});const count=pControl.count;
    for(let i=1;i<=count;i++){pControl.failBefore=i;await assert.rejects(plans.save(input),{code:'persistence_unknown'});assert.equal(await snapshot(),before);}
    await f.plans.save(input);const r=await note(f),u=update(f,r),uControl={failBefore:0},uPlans=new D1Plans(fault(db,uControl),scoped(f.p)),updateBefore=await snapshot();
    await assert.rejects(uPlans.update(u),{code:'persistence_unknown'});const uCount=uControl.count;
    for(let i=1;i<=uCount;i++){uControl.failBefore=i;await assert.rejects(uPlans.update(u),{code:'persistence_unknown'});assert.equal(await snapshot(),updateBefore);}
  });
  await t.test('a last-statement receipt collision rolls back new decision and plan sidecars',async()=>{
    const f=await seed(),key=(await all('SELECT idempotency_key FROM receipts WHERE scope=? LIMIT 1',f.p.id))[0].idempotency_key;
    const old=await f.store.getReceipt(f.p.id,key),d=await decisionMutation(f,decision());d.receipt=old;
    let before=await snapshot();assert.equal(await f.store.commit(d),'conflict');assert.equal(await snapshot(),before);
    const plan=await mutation(f);delete plan.run;plan.receipt=old;
    plan.plan={operation:'save',input:{...save(f),...scoped(f.p),idempotency_key:key},created_at:now};
    before=await snapshot();assert.equal(await f.store.commit(plan),'conflict');assert.equal(await snapshot(),before);
  });
  await t.test('lost response with unavailable receipt remains unknown, a fresh connection replays the exact stored plan',async()=>{
    const f=await seed(),input=save(f),control={loseResponse:true,blockReceipt:true};
    await assert.rejects(new D1Plans(fault(db,control),scoped(f.p)).save(input),{code:'persistence_unknown'});
    const recovered=await new D1Plans(db,scoped(f.p)).save(input);assert.equal(recovered.version,1);
    assert.equal((await all('SELECT count(*) AS n FROM plan_versions WHERE project_id=?',f.p.id))[0].n,1);
    const r=await note(f),u=update(f,r),again={loseResponse:true};
    const saved=await new D1Plans(fault(db,again),scoped(f.p)).update(u);
    assert.deepEqual(await f.plans.update(u),saved);assert.equal((await f.plans.query({plan_key:'test-plan'})).progress.percent,50);
  });
  await t.test('workerd restart preserves decision history, old plan source, progress and remaining items',async()=>{
    const f=await seed(),c=await decisionMutation(f,decision());await f.store.commit(c);await f.plans.save(save(f));const r=await note(f);await f.plans.update(update(f,r));
    const beforeD=await f.decisions.query(query),beforeP=await f.plans.query({plan_key:'test-plan',remaining_only:true});
    await mf.dispose();mf=new Miniflare(options);db=await mf.getD1Database('DB');
    const afterD=await worker({operation:'decisions',project_id:f.p.id,scope:scoped(f.p),query});
    const afterP=await worker({operation:'plans',project_id:f.p.id,scope:scoped(f.p),query:{plan_key:'test-plan',remaining_only:true}});
    assert.deepEqual(afterD,beforeD);assert.deepEqual(afterP,beforeP);assert.equal(afterP.claims_verified,false);
  });
  await t.test('a bounded decision history never supplies partial current IDs as a complete write base',async()=>{
    const f=await seed(),d=decision({action:'propose',choice_key:'idea',source:{kind:'agent_proposal',reference:'synthetic fixture',quote:'테스트 제안'}});
    // Synthetic boundary fixture only: not a claim about real collected user decisions.
    for(let offset=0;offset<201;offset+=20){const stmts=[];for(let i=offset;i<Math.min(offset+20,201);i++){
      const r=record(f,{id:randomUUID(),kind:'decision',body:'경계 테스트 기록'});
      stmts.push(db.prepare(`INSERT INTO records(id,project_id,run_id,topic,kind,body,repository,environment,source_fingerprint,observed_at,recorded_at,supersedes,superseded_by,report_origin)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(r.id,r.project_id,r.run_id,r.topic,r.kind,r.body,r.repository,r.environment,null,now,now,null,null,'contemporaneous'));
      stmts.push(db.prepare('INSERT INTO decision_events VALUES(?,?,?,?,?,?)').bind(f.p.id,r.id,d.subject,'api','comments',JSON.stringify(d)));
    }await db.batch(stmts);}
    const state=await f.decisions.query(query);assert.equal(state.status,'unknown');assert.equal(state.active_record_ids,null);assert.equal(state.active_ids_complete,false);
    await assert.rejects(f.store.commit(await decisionMutation(f,decision())),{code:'invalid_input'});
  });
});
