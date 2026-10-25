import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {Miniflare} from 'miniflare';
import {D1AtomicCommitStore} from '../dist/adapters/storage/d1/atomic-store.js';
import {D1ProjectTransfer} from '../dist/adapters/storage/d1/transfer.js';
import {exportD1Project,importD1Project,storeIdentity,openImported} from '../dist/adapters/storage/d1/transfer-store.js';
import {validateBundle,transferTables} from '../dist/adapters/storage/d1/transfer-format.js';
import {withD1Generation,d1WriteAuthority} from '../dist/adapters/storage/d1/authority.js';
import {D1TaskEvents} from '../dist/adapters/storage/d1/task-events.js';
import {D1Skills} from '../dist/adapters/storage/d1/skills.js';
import {D1Plans} from '../dist/adapters/storage/d1/plans.js';
import {D1Executions} from '../dist/adapters/storage/d1/executions.js';
import {D1CurrentKnowledge} from '../dist/adapters/storage/d1/current-knowledge.js';
import {D1TaskReader} from '../dist/adapters/storage/d1/task-reader.js';
import {canonical} from '../dist/adapters/storage/d1/query.js';
import {d1WorkerModules} from './support/d1-modules.mjs';
const at='2026-10-25T03:30:00.000Z',hash=x=>createHash('sha256').update(x).digest('hex');
function wrap(db,c){return {writeGeneration:db.writeGeneration,withSession(constraint){const s=db.withSession(constraint),queries=[];return {
 prepare(sql){queries.push(sql);return s.prepare(sql);},async batch(statements){
 if(c.before&&c.matches(queries)){const before=c.before;c.before=null;await before();}
 const submitted=c.failBefore===undefined?statements:[...statements.slice(0,c.failBefore),s.prepare('INSERT INTO no_such_transfer_fault VALUES(0)'),...statements.slice(c.failBefore)];c.count=statements.length;
 const result=await s.batch(submitted);if(c.lose&&c.matches(queries)){c.lose=false;throw Error('injected response loss after actual D1 commit');}return result;
 }};}};}

test('actual local D1 independent project transfer and monotonic writer fencing',{timeout:180000},async t=>{
 const root=mkdtempSync(join(tmpdir(),'skilly-d1-transfer-')),names=['DB',...Array.from({length:20},(_,i)=>'COPY'+i)],ids=Object.fromEntries(names.map(n=>[n,randomUUID()]));
 const options={...d1WorkerModules(fileURLToPath(new URL('./support/d1-transfer-worker.mjs',import.meta.url))),compatibilityDate:'2026-07-30',d1Databases:ids,d1Persist:join(root,'d1'),host:'127.0.0.1',port:0,outboundService:()=>new Response('outbound disabled',{status:403})};
 let mf=new Miniflare(options),source=await mf.getD1Database('DB');t.after(()=>mf.dispose());
 const files=['001-atomic-memory.sql','002-work.sql','003-decisions-plans.sql','004-execution-evidence.sql','005-task-events.sql','006-skills.sql','007-feature-discovery.sql','008-project-transfer.sql'];
 const apply=async db=>{for(const name of files){const sql=readFileSync(new URL('../migrations/d1/'+name,import.meta.url),'utf8').replace(/^--[^\n]*$/gm,'').trim().split(/;\s*(?=CREATE\s|INSERT\s+INTO\s+d1_store_identity|$)/i).filter(Boolean);await db.batch(sql.map(s=>db.prepare(s)));}};
 const all=async(db,sql,...v)=>(await db.prepare(sql).bind(...v).all()).results;
 await apply(source);let index=0;const fresh=async()=>{const name='COPY'+index++;const db=await mf.getD1Database(name);await apply(db);return {db,name};};
 const receipt=(p,result={status:'persisted'})=>{const key=randomUUID();return {scope:p.id,key,hash:hash(key),result};};
 const mutate=async(db,f,extra={})=>{const rev=(await all(db,'SELECT revision FROM projects WHERE id=?',f.p.id))[0].revision;return {project:{...f.p,revision:rev+1},expected_revision:rev,receipt:receipt(f.p),...extra};};
 const seed=async()=>{const p={id:randomUUID(),key:'transfer-'+randomUUID(),name:'D1 이전 테스트',revision:0,created_at:at},store=new D1AtomicCommitStore(source,p.id),f={p,store};
 await store.commit({project:p,expected_revision:null,receipt:receipt(p)});f.run={id:randomUUID(),project_id:p.id,goal:'테스트용 독립 이전',mode:'change',environment:'test',repository:'api',state:'active',created_at:at,updated_at:at,actor:'Codex'};await store.commit(await mutate(source,f,{run:f.run,receipt:receipt(p,{run:f.run})}));return f;};
 const scope=f=>({project_id:f.p.id,repository:'api',environment:'test',root_hash:hash('synthetic transfer root'),session_hash:hash('synthetic transfer session')});
 const note=async(db,f,store=f.store,extra={})=>{const r={id:randomUUID(),project_id:f.p.id,run_id:f.run.id,topic:'transfer-test',kind:'change',body:'테스트용 원문',environment:'test',repository:'api',source_fingerprint:null,observed_at:at,recorded_at:at,supersedes:null,superseded_by:null,report_origin:'contemporaneous',...extra};await store.commit(await mutate(db,f,{record:r,receipt:receipt(f.p,{record_id:r.id})}));return r;};
 const workScope=f=>({project_id:f.p.id,repository:'api',environment:'test'}),skillScope=f=>({...workScope(f),root_hash:scope(f).root_hash});
 const receive=(events,event='PostToolUse',observation_id=randomUUID())=>events.receive({idempotency_key:randomUUID(),observation_id,event,observed_at:at});
 const snapshot=async(db)=>JSON.stringify(await Promise.all(transferTables.map(table=>all(db,`SELECT * FROM ${table} ORDER BY 1,2`))));
 let rich,baseline,targetInfo,returnInfo,transferId,savedPoint;
 await t.test('complete catalog has 26 business tables; actual D1 supports deferred correction references and rollback',async()=>{
 assert.equal(transferTables.length,26);const actual=await all(source,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'record_search%' AND name NOT LIKE 'd1_%' AND name<>'_cf_METADATA' AND name<>'skilly_write_assertions'");assert.deepEqual(actual.map(r=>r.name).sort(),[...transferTables].sort());
 const c=await fresh(),bad=await c.db.prepare('PRAGMA foreign_keys').all();assert.equal(bad.results[0].foreign_keys,1);
 await assert.rejects(c.db.batch([c.db.prepare('PRAGMA defer_foreign_keys=ON'),c.db.prepare("INSERT INTO runs VALUES(?,?,?,'change','test','api','active',?,?)").bind(randomUUID(),randomUUID(),'foreign',at,at)]));
 assert.equal((await all(c.db,'SELECT count(*) n FROM runs'))[0].n,0);assert.equal((await c.db.prepare('PRAGMA defer_foreign_keys').all()).results[0].defer_foreign_keys,0);
 });
 await t.test('source contains rich work, original correction gaps, decisions, plans, synthetic evidence, skills and interruption snapshots',async()=>{
 const f=await seed();rich=f;const feature={key:'review',name:'리뷰',aliases:['검토'],code_paths:['src/review']};await f.store.commit(await mutate(source,f,{record:{...await note(source,f),id:randomUUID()},work:{run_id:f.run.id,title:'이전 작업',features:[feature],components:[{key:'api',name:'API'}]}}));
 const a=await note(source,f);const other=await seed();await note(source,other);await note(source,f,f.store,{supersedes:a.id,body:'정정 원문'});
 const d=(action,choice,targets=[])=>({subject:'test-policy',title:'테스트 결정',action,...(choice?{choice_key:choice}:{}),targets,expected_current_ids:targets,component_key:'api',feature_key:'review',source:{kind:'user_statement',quote:'테스트 선택',reference:'synthetic fixture'}});
 const decide=async decision=>{const r={id:randomUUID(),project_id:f.p.id,run_id:f.run.id,topic:'policy',kind:'decision',body:'테스트 선택',environment:'test',repository:'api',source_fingerprint:null,observed_at:at,recorded_at:at,supersedes:null,superseded_by:null,report_origin:'contemporaneous'};await f.store.commit(await mutate(source,f,{record:r,decision}));return r;};const first=await decide(d('decide','a'));await decide(d('replace','b',[first.id]));
 const ex=new D1Executions(source,workScope(f)),started=await ex.start({run_id:f.run.id,executable:'node',command_hash:hash('synthetic test command'),idempotency_key:randomUUID()});await ex.finish({execution_id:started.execution_id,idempotency_key:randomUUID(),result:{outcome:'exited',exit_code:0,signal:null,error_code:null,duration_ms:1,stdout_bytes:0,stderr_bytes:0,stdout_hash:hash(''),stderr_hash:hash(''),stdout_hashed_bytes:0,stderr_hashed_bytes:0,output_complete:1},details:{status:'collected',framework:'node_test',counts:{tests:1,passed:1,failed:0,cancelled:0,skipped:0,todo:0,suites:0},suite_success:true,failures:[],failures_truncated:false}});
 const plans=new D1Plans(source,workScope(f)),plan={run_id:f.run.id,idempotency_key:randomUUID(),plan_key:'release',expected_version:0,title:'이전 계획',source_kind:'conversation',source_ref:'test request',source_body:'테스트 계획',items:[{key:'one',title:'첫 항목',required:true,component_key:'api',feature_key:'review',criteria:[{key:'ok',text:'확인'}]},{key:'two',title:'다음 항목',required:true,criteria:[{key:'ok',text:'추후 확인'}]}]};await plans.save(plan);await plans.save({...plan,expected_version:1,idempotency_key:randomUUID()});const report=await note(source,f);await plans.update({run_id:f.run.id,idempotency_key:randomUUID(),plan_key:'release',version:2,item_key:'one',expected_update_id:null,record_id:report.id,state:'completed',note:'AI 조건 충족 보고',criteria_results:[{key:'ok',met:true,detail:'테스트 보고'}],execution_ids:[started.execution_id]});
 const observer={root_hash:scope(f).root_hash,async observe(i,v){return [{path:'SKILL.md',hash:hash(v.body),bytes:Buffer.byteLength(v.body),state:'matches'}];}},skills=new D1Skills(source,skillScope(f),observer);
 await skills.register({project_id:f.p.id,skill_key:'test-guide',version:'1',source:'local:test',name:'테스트 안내',description:'전문 보존',body:'# 테스트 스킬',files:[],install_instructions:'테스트 설치 방법',idempotency_key:randomUUID()});const assigned=await skills.assign({skill_key:'test-guide',version:'1',tool:'codex',folder:'test-guide',expected_assignment_id:null,idempotency_key:randomUUID()});const observed=await skills.inspect({installation_id:assigned.installation_id,idempotency_key:randomUUID()});await skills.checkpoint({run_id:f.run.id,topic:'skill',kind:'change',body:'스킬 사용 보고',report:{title:'스킬 사용',summary:'테스트 자료입니다.'},skill_usage:[{skill_key:'test-guide',version:'1',purpose:'테스트 보고',observation_id:observed.observation_id}],idempotency_key:randomUUID()});
 const events=new D1TaskEvents(source,scope(f)),anchor=await receive(events,'PostToolUse',hash('64 character anchor'));await events.link({idempotency_key:randomUUID(),run_id:f.run.id,observation_id:anchor.observation_id});savedPoint=await note(source,f);await receive(events,'Interrupt',hash('64 character interrupt'));
 const before=await events.status(f.run.id);assert.equal(before.interruption.saved_during_event.record_id,savedPoint.id);baseline=await snapshot(source);
 });
 await t.test('prepare exports one project, validates every table and fences existing raw/API writers without touching other projects',async()=>{
 targetInfo=await fresh();returnInfo=await fresh();transferId=randomUUID();const c=new D1ProjectTransfer(source,targetInfo.db,rich.p.id),oldStatement=source.prepare('UPDATE runs SET updated_at=? WHERE id=?').bind(at,rich.run.id);
 const result=await c.prepare(transferId,0);assert.equal(result.phase,'prepared');assert.equal(result.copies.source.write_allowed,false);assert.equal(result.copies.target.write_allowed,false);
 await assert.rejects(oldStatement.all(),/project_write_blocked/);await assert.rejects(note(source,rich),{code:'project_write_blocked'});
 const bundle=await exportD1Project(source,rich.p.id);assert.ok(transferTables.every(table=>bundle.tables[table].length>0),JSON.stringify(Object.fromEntries(transferTables.map(k=>[k,bundle.tables[k].length]))));assert.equal(bundle.tables.projects.length,1);
 const imported=await importD1Project(targetInfo.db,bundle,{transfer_id:transferId,generation:1,role:'target'});assert.equal(imported.status,'already_imported');
 for(const table of transferTables)assert.deepEqual((await all(targetInfo.db,`SELECT * FROM ${table} ORDER BY 1,2`)),bundle.tables[table].slice().sort((a,b)=>0).length?await all(source,`SELECT * FROM ${table} WHERE ${table==='projects'?'id=?':table==='receipts'?'scope=?':table==='run_actors'?'run_id IN (SELECT id FROM runs WHERE project_id=?)':'project_id=?'} ORDER BY 1,2`,rich.p.id):[]);
 const foreign=(await all(source,'SELECT id FROM projects WHERE id<>?',rich.p.id))[0].id;const revision=(await all(source,'SELECT revision FROM projects WHERE id=?',foreign))[0].revision;await source.prepare('UPDATE projects SET revision=revision+1 WHERE id=?').bind(foreign).run();assert.equal((await all(source,'SELECT revision FROM projects WHERE id=?',foreign))[0].revision,revision+1);
 assert.ok(baseline.length>0);
 });
 await t.test('tampered hash, scope, graph and packages reject before import, and each import SQL failure rolls back the fresh target',async()=>{
 const bundle=await exportD1Project(source,rich.p.id),copy=await fresh();const reseal=b=>({...b,sha256:hash(canonical(Object.fromEntries(Object.entries(b).filter(([k])=>k!=='sha256'))))});
 for(const alter of [b=>{b.tables.records[0].body+='changed';return b;},b=>{b.tables.runs[0].project_id=randomUUID();return reseal(b);},b=>{b.tables.records.find(r=>r.supersedes).supersedes=randomUUID();return reseal(b);},b=>{b.tables.skill_versions[0].body+='changed';return reseal(b);},b=>{b.tables.event_task_snapshots[0].saved_json=JSON.stringify({record_id:randomUUID()});return reseal(b);},
 b=>{const saved=JSON.parse(b.tables.event_task_snapshots[0].saved_json);b.tables.event_task_snapshots[0].saved_json=JSON.stringify({...saved,record_id:null,record_visible:true});return reseal(b);},
 b=>{const saved=JSON.parse(b.tables.event_task_snapshots[0].saved_json),r=b.tables.records.find(r=>r.id===saved.record_id);b.tables.receipts=b.tables.receipts.filter(q=>{const v=JSON.parse(q.result_json);return v.record_id!==r.id&&!v.record_ids?.includes(r.id);});return reseal(b);},
 b=>{b.tables.event_task_snapshots=[];return reseal(b);},
 b=>{const row=b.tables.decision_events[0],d=JSON.parse(row.metadata_json);row.component_key='other';row.metadata_json=JSON.stringify({...d,component_key:'other'});return reseal(b);}])await assert.rejects(importD1Project(copy.db,alter(structuredClone(bundle)),{transfer_id:transferId,generation:1,role:'target'}));
 const ctl={failBefore:0};for(let pos=0;pos<38;pos++){ctl.failBefore=pos;try{await importD1Project(wrap(copy.db,ctl),bundle,{transfer_id:transferId,generation:1,role:'target'});break;}catch{assert.equal((await all(copy.db,'SELECT count(*) n FROM projects'))[0].n,0);}if(pos===ctl.count)break;}
 assert.equal((await all(copy.db,'SELECT count(*) n FROM projects'))[0].n,0);
 });
 await t.test('activation requires the host generation; imported events never become the new session binding',async()=>{
 const c=new D1ProjectTransfer(source,targetInfo.db,rich.p.id);const result=await c.activate(transferId);assert.equal(result.copies.target.write_allowed,true);
 await assert.rejects(note(targetInfo.db,rich,new D1AtomicCommitStore(targetInfo.db,rich.p.id)),{code:'project_write_blocked'});
 const connected=withD1Generation(targetInfo.db,1),events=new D1TaskEvents(connected,scope(rich));let status=await events.status(rich.run.id);assert.equal(status.linkage,'imported_history');assert.equal(status.current_session_binding,false);assert.equal(status.interruption.saved_during_event.record_id,savedPoint.id);assert.equal(status.interruption.imported_history,true);
 const n=await receive(events);assert.equal((await events.status(rich.run.id)).events.length,status.events.length);await assert.rejects(events.link({idempotency_key:randomUUID(),run_id:rich.run.id,observation_id:status.interruption.observation_id}),{code:'scope_mismatch'});
 await events.link({idempotency_key:randomUUID(),run_id:rich.run.id,observation_id:n.observation_id});await note(targetInfo.db,rich,new D1AtomicCommitStore(connected,rich.p.id),{body:'활성화 후 새 원문'});await receive(events,'Interrupt');status=await events.status(rich.run.id);assert.equal(status.current_session_binding,true);assert.equal(status.interruption.imported_history,false);
 const k=await new D1CurrentKnowledge(connected,workScope(rich)).query();assert.equal(k.plans.items[0].progress.remaining,1);assert.equal(k.checks.items[0].current_knowledge.status,'unknown');assert.equal(k.decisions.items[0].status,'current');
 });
 await t.test('lost recovery response resumes the same selected return, keeps new writes and fences both old generations',async()=>{
 const fault={lose:true,matches:q=>q.some(s=>s.includes('INSERT INTO projects'))},coordinator=new D1ProjectTransfer(source,targetInfo.db,rich.p.id);
 await assert.rejects(coordinator.recover(transferId,wrap(returnInfo.db,fault)),{code:'persistence_unknown'});let s=await coordinator.status(transferId,returnInfo.db);assert.equal(s.phase,'recovering');assert.equal(s.copies.target.write_allowed,false);assert.equal(s.copies.returned.write_allowed,false);
 s=await coordinator.recover(transferId,returnInfo.db);assert.equal(s.phase,'returned');assert.equal(s.copies.returned.write_allowed,true);assert.equal(s.copies.returned.generation,2);
 await assert.rejects(note(targetInfo.db,rich,new D1AtomicCommitStore(withD1Generation(targetInfo.db,1),rich.p.id)),{code:'project_write_blocked'});
 const content=await new D1TaskReader(returnInfo.db,{project_id:rich.p.id,repository:'api',environment:'test'}).listTasks();assert.equal(content.items[0].id,rich.run.id);const records=await all(returnInfo.db,"SELECT body FROM records WHERE body='활성화 후 새 원문'");assert.equal(records.length,1);
 const r=await note(returnInfo.db,rich,new D1AtomicCommitStore(withD1Generation(returnInfo.db,2),rich.p.id),{body:'복귀 후 새 원문'});assert.ok(r.id);assert.equal((await coordinator.recover(transferId,returnInfo.db)).phase,'returned');await assert.rejects(coordinator.activate(transferId),{code:'authority_conflict'});
 });
 await t.test('prepare response loss and pre-activation abort resume without opening a target or losing original data',async()=>{
 const f=await seed(),target=await fresh(),ctl={lose:true,matches:q=>q.some(s=>s.includes('INSERT INTO d1_transfer_operations'))},id=randomUUID();
 await assert.rejects(new D1ProjectTransfer(wrap(source,ctl),target.db,f.p.id).prepare(id,0),{code:'persistence_unknown'});const c=new D1ProjectTransfer(source,target.db,f.p.id);assert.equal((await c.status(id)).phase,'preparing');const s=await c.recover(id);assert.equal(s.phase,'aborted');assert.equal(s.copies.source.write_allowed,true);assert.equal(s.copies.source.generation,2);assert.equal((await all(target.db,'SELECT count(*) n FROM projects'))[0].n,0);
 await assert.rejects(note(source,f),{code:'project_write_blocked'});await note(source,f,new D1AtomicCommitStore(withD1Generation(source,2),f.p.id));await assert.rejects(c.activate(id),{code:'authority_conflict'});
 });
 await t.test('delayed activation cannot reopen the target after recovery increased its fence epoch',async()=>{
 const f=await seed(),target=await fresh(),returned=await fresh(),id=randomUUID();const c=new D1ProjectTransfer(source,target.db,f.p.id);await c.prepare(id,0);
 let release,entered;const gate=new Promise(r=>release=r),waiting=new Promise(r=>entered=r),ctl={matches:q=>q.some(s=>s.includes("SET state='writable'")),before:async()=>{entered();await gate;}};
 const activate=new D1ProjectTransfer(source,wrap(target.db,ctl),f.p.id).activate(id);await waiting;try{await c.recover(id,returned.db);}finally{release();}await assert.rejects(activate,{code:'authority_conflict'});
 assert.equal((await d1WriteAuthority(target.db,f.p.id)).write_allowed,false);assert.equal((await d1WriteAuthority(returned.db,f.p.id)).write_allowed,true);
 });
 await t.test('competing recovery destinations cannot both become writers',async()=>{
 const f=await seed(),target=await fresh(),a=await fresh(),b=await fresh(),id=randomUUID(),c=new D1ProjectTransfer(source,target.db,f.p.id);await c.prepare(id,0);await c.activate(id);
 const results=await Promise.allSettled([c.recover(id,a.db),c.recover(id,b.db)]);assert.ok(results.some(r=>r.status==='fulfilled'));
 const writable=await Promise.all([source,target.db,a.db,b.db].map(async db=>{const rows=await all(db,'SELECT id FROM projects WHERE id=?',f.p.id);return rows.length&&(await d1WriteAuthority(db,f.p.id)).write_allowed;}));assert.equal(writable.filter(Boolean).length,1);
 });
 await t.test('prepared abort fences an imported target and a prechecked stale writer cannot race the source fence',async()=>{
 const f=await seed(),target=await fresh(),id=randomUUID(),c=new D1ProjectTransfer(source,target.db,f.p.id),ctl={matches:()=>true,before:()=>c.prepare(id,0)};
 const writer=new D1AtomicCommitStore(wrap(source,ctl),f.p.id);await assert.rejects(note(source,f,writer),{code:'project_write_blocked'});
 assert.equal((await c.status(id)).phase,'prepared');const s=await c.recover(id);assert.equal(s.phase,'aborted');assert.equal(s.copies.source.write_allowed,true);assert.equal(s.copies.target.write_allowed,false);
 await assert.rejects(openImported(target.db,f.p.id,id,1,'target'),{code:'authority_conflict'});
 });
 await t.test('interruption after return opens but before coordinator completion preserves later writes on resume',async()=>{
 const f=await seed(),target=await fresh(),returned=await fresh(),id=randomUUID(),c=new D1ProjectTransfer(source,target.db,f.p.id);await c.prepare(id,0);await c.activate(id);
 let phases=0;const fault={matches:q=>q.some(s=>s.startsWith('UPDATE d1_transfer_operations SET phase='))&&++phases===2,before:async()=>{throw Error('injected interruption before returned phase');}};
 await assert.rejects(new D1ProjectTransfer(wrap(source,fault),target.db,f.p.id).recover(id,returned.db),{code:'persistence_unknown'});
 const partial=await c.status(id,returned.db);assert.equal(partial.phase,'recovering');assert.equal(partial.copies.source.write_allowed,false);assert.equal(partial.copies.target.write_allowed,false);assert.equal(partial.copies.returned.write_allowed,true);
 const newer=await note(returned.db,f,new D1AtomicCommitStore(withD1Generation(returned.db,2),f.p.id),{body:'복귀 완료 저장 전 추가 원문'});
 assert.equal((await c.recover(id,returned.db)).phase,'returned');assert.equal((await all(returned.db,'SELECT id FROM records WHERE id=?',newer.id)).length,1);
 });
 await t.test('fresh workerd/bindings preserve receipts, interruption checkpoints, plan/skill state and returned writes',async()=>{
 const before=await new D1TaskEvents(returnInfo.db,scope(rich)).status(rich.run.id);await mf.dispose();mf=new Miniflare(options);source=await mf.getD1Database('DB');targetInfo.db=await mf.getD1Database(targetInfo.name);returnInfo.db=await mf.getD1Database(returnInfo.name);
 const c=new D1ProjectTransfer(source,targetInfo.db,rich.p.id),s=await c.status(transferId,returnInfo.db);assert.equal(s.phase,'returned');assert.equal(s.copies.returned.write_allowed,true);
 const after=await new D1TaskEvents(returnInfo.db,scope(rich)).status(rich.run.id);assert.deepEqual(after.interruption,before.interruption);assert.equal(after.current_session_binding,false);assert.equal(after.interruption.saved_during_event.record_id,before.interruption.saved_during_event.record_id);
 const res=await mf.dispatchFetch('http://local-transfer.invalid/',{method:'POST',body:JSON.stringify({binding:returnInfo.name,scope:scope(rich),run_id:rich.run.id})});const data=await res.json();assert.equal(res.status,200,JSON.stringify(data));assert.equal(data.authority.write_allowed,true);assert.equal(data.events.interruption.saved_during_event.record_id,after.interruption.saved_during_event.record_id);assert.equal(data.knowledge.plans.items[0].progress.remaining,1);assert.equal(data.skills.items[0].provenance,'agent_report');assert.equal(data.knowledge.claims_verified,false);
 });
});
