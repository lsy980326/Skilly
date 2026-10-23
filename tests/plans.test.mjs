import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fixture,project,run,checkpoint} from './helpers.mjs';
import {SqlitePlans,validatePlanData} from '../dist/adapters/storage/sqlite/plans.js';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
import {initialize,validateDatabase} from '../dist/adapters/storage/transfer/database.js';
import {backupDatabase,restoreDatabase} from '../dist/adapters/storage/transfer/snapshot.js';
import {exportProject,importProject} from '../dist/adapters/storage/transfer/project.js';
import {startViewer} from '../dist/transport/viewer/server.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const source='# 알림 계획\n- [x] 알림 설정 저장\n- [ ] 알림 화면\n```md\n- [x] 실행하지 않는 예시\n```\n';
async function setup(t){const f=fixture(t),pid=await project(f.call),rid=await run(f.call,pid);return {...f,pid,rid};}
const save=(f,extra={})=>f.call('memory_save_plan',{project_id:f.pid,run_id:f.rid,plan_key:'notifications',title:'알림 계획',source_kind:'markdown',source_ref:'docs/selected.md',source_body:source,idempotency_key:'plan-save',...extra});
const query=(f,extra={})=>f.call('memory_query_plans',{project_id:f.pid,plan_key:'notifications',...extra});
async function report(f,key='report',extra={}){return f.call('memory_checkpoint',checkpoint(f.pid,f.rid,{idempotency_key:key,report_origin:'contemporaneous',...extra}));}
const update=(f,record,extra={})=>f.call('memory_update_plan_item',{project_id:f.pid,run_id:f.rid,plan_key:'notifications',version:1,item_key:'item-1',record_id:record.record_id,state:'completed',note:'알림 설정 저장을 구현했습니다.',criteria_results:[{key:'acceptance',met:true,detail:'저장 처리와 검사 결과를 보고합니다.'}],idempotency_key:'plan-update',...extra});

test('selected Markdown source stays unchanged; checkmarks do not complete a plan and fenced examples are ignored',async t=>{
 const f=await setup(t),path=join(f.directory,'selected.md');writeFileSync(path,source);const original=readFileSync(path);
 const receipt=await save(f);assert.equal(receipt.version,1);assert.equal(receipt.claims_verified,false);assert.equal(receipt.recovery_queued,false);
 const data=await query(f);assert.equal(data.plan.source_body,source);assert.equal(data.items.length,2);assert.equal(data.items[0].source_checked,true);
 assert.equal(data.items[0].state,'pending');assert.equal(data.progress.completed_reported,0);assert.equal(data.progress.remaining,2);
 assert.deepEqual(readFileSync(path),original);assert.equal(data.source_path_verified,false);
 assert.deepEqual(await save(f),receipt);
 await assert.rejects(save(f,{title:'別の入力'}),{code:'idempotency_conflict'});
});
test('completion conditions, version CAS and update CAS preserve history and retries after closing a task',async t=>{
 const f=await setup(t);await save(f);const r=await report(f);
 await assert.rejects(update(f,r,{criteria_results:[]}),{code:'completion_conditions_missing'});
 const u=await update(f,r);let data=await query(f);assert.equal(data.progress.percent,50);assert.equal(data.items[0].update_id,u.update_id);
 const remaining=await query(f,{remaining_only:true});assert.equal(remaining.items.length,1);assert.equal(remaining.progress.required,2);
 await assert.rejects(update(f,r,{state:'blocked',idempotency_key:'stale-update'}),{code:'plan_conflict'});
 await update(f,r,{state:'blocked',expected_update_id:u.update_id,idempotency_key:'blocked'});
 assert.equal((await query(f)).progress.percent,0);
 await assert.rejects(save(f,{idempotency_key:'stale-version'}),{code:'plan_conflict'});
 await save(f,{expected_version:1,idempotency_key:'version2',source_body:source+'\n변경한 완료 조건\n'});
 data=await query(f);assert.equal(data.plan.version,2);assert.ok(data.items.every(x=>x.state==='pending'));
 assert.equal((await query(f,{version:1})).items[0].state,'blocked');
 await assert.rejects(update(f,r,{idempotency_key:'old-version',expected_update_id:null}),{code:'plan_conflict'});
 await f.call('memory_finish_task',{project_id:f.pid,run_id:f.rid,summary:'독립 작업 종료',outcome:'completed',idempotency_key:'finish'});
 assert.deepEqual(await update(f,r),u);
});
test('cross-project/task/repository evidence and reconstructed completion reports are rejected atomically',async t=>{
 const f=await setup(t);await save(f);const r=await report(f),rid2=await run(f.call,f.pid,{idempotency_key:'second'});
 const foreign=await f.call('memory_checkpoint',checkpoint(f.pid,rid2,{idempotency_key:'second-report',report_origin:'contemporaneous'}));
 await assert.rejects(update(f,foreign),{code:'scope_mismatch'});
 const old=await report(f,'retro',{report_origin:'retrospective'});await assert.rejects(update(f,old),{code:'invalid_evidence'});
 const eid=f.app.executions.start({project_id:f.pid,run_id:rid2,executable:'node',command_hash:'a'.repeat(64)});
 await assert.rejects(update(f,r,{execution_ids:[eid]}),{code:'scope_mismatch'});
 await assert.rejects(update(f,r,{repository:'other'}),{code:'scope_mismatch'});
 assert.equal((await query(f)).items[0].update_id,null);
});
test('conversation items link known components/features and no-required plans never imply 100 percent',async t=>{
 const f=await setup(t);const rid=await run(f.call,f.pid,{idempotency_key:'web',components:[{key:'web',name:'Web'}],features:[{key:'alerts',name:'알림'}]});
 const item={key:'settings',title:'설정',required:false,component_key:'web',feature_key:'alerts',criteria:[{key:'saved',text:'설정이 저장된다'}]};
 await save(f,{run_id:rid,source_kind:'conversation',items:[item]});const record=await f.call('memory_checkpoint',checkpoint(f.pid,f.rid,{idempotency_key:'wrong',report_origin:'contemporaneous'}));
 await assert.rejects(update(f,record,{item_key:'settings',criteria_results:[{key:'saved',met:true,detail:'보고'}]}),{code:'scope_mismatch'});
 const data=await query(f);assert.equal(data.progress.required,0);assert.equal(data.progress.percent,0);assert.equal(data.progress.status,'not_started');
});
test('direct test details are separate from reported completion; shared source reads are bounded and corrections reopen review',async t=>{
 const f=await setup(t);await save(f);const r=await report(f);
 const before={version:1,root_hash:'a'.repeat(64),project_key:'example',repository:'default',environment:'development',observed_at:'2026-10-23T00:00:00Z',status:'clean',commit:'b'.repeat(40),reason:null};
 const eid=f.app.executions.start({project_id:f.pid,run_id:f.rid,executable:'node',command_hash:'c'.repeat(64),source_observation:before});
 f.app.executions.finish(eid,{outcome:'exited',exit_code:0,signal:null,error_code:null,duration_ms:1,stdout_bytes:0,stderr_bytes:0,stdout_hash:null,stderr_hash:null,stdout_hashed_bytes:0,stderr_hashed_bytes:0,output_complete:1},
  {status:'collected',framework:'node_test',counts:{tests:2,passed:2,failed:0,cancelled:0,skipped:0,todo:0,suites:0},suite_success:true,failures:[],failures_truncated:false},before);
 await update(f,r,{execution_ids:[eid]});await update(f,r,{item_key:'item-2',idempotency_key:'item2',execution_ids:[eid]});
 const raw=new DatabaseSync(f.path,{readOnly:true});t.after(()=>raw.close());let reads=0;const reader=new SqlitePlans(raw,()=>{reads++;return before;});
 let data=reader.query({project_id:f.pid,repository:'default',environment:'development'},{plan_key:'notifications'});
 assert.equal(reads,1);assert.equal(data.progress.percent,100);assert.equal(data.progress.status,'completed_reported');assert.equal(data.claims_verified,false);
 assert.equal(data.items[0].evidence.status,'current');assert.equal(data.items[0].evidence.observations[0].counts.passed,2);
 const corrected=await report(f,'correction',{supersedes:r.record_id});assert.ok(corrected.record_id);
 data=await query(f);assert.equal(data.items[0].state,'needs_review');assert.equal(data.progress.completed_reported,0);
});
test('v10 read-only is supported without migration; v11 writer preserves original rows and backup/project exchange keep plans',async t=>{
 const f=await setup(t);await save(f);const r=await report(f);await update(f,r);
 const base=realpathSync(f.directory),dbPath=realpathSync(f.path),bundle=join(base,'project-bundle');exportProject(dbPath,f.pid,bundle);const imported=await importProject(bundle,join(base,'imported'));
 const backup=join(base,'backup');await backupDatabase(dbPath,backup);const restored=await restoreDatabase(backup,join(base,'restored'));
 for(const path of [imported.db,restored.db]){const reader=new SqliteViewer(path);try{const d=reader.plans(f.pid,{plan_key:'notifications',repository:'default',environment:'development'});assert.equal(d.plan.source_body,source);assert.equal(d.progress.percent,50);}finally{reader.close();}}
 const legacy=join(f.directory,'legacy.sqlite'),db=new DatabaseSync(legacy);initialize(db,false,10);db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run('00000000-0000-4000-8000-000000000001','legacy','legacy',0,'2026-10-23T00:00:00Z');db.close();
 const snapshot=readFileSync(legacy),reader=new SqliteViewer(legacy);assert.equal(reader.plans('00000000-0000-4000-8000-000000000001').schema_supported,false);reader.close();assert.deepEqual(readFileSync(legacy),snapshot);
 const app=(await import('../dist/runtime/local/app.js')).openLocal(legacy);await app.close();const check=new DatabaseSync(legacy,{readOnly:true});assert.equal(check.prepare('PRAGMA user_version').get().user_version,11);assert.equal(check.prepare('SELECT name FROM projects').get().name,'legacy');validateDatabase(check);check.close();
});
test('backup/import validation enforces the same origin, classification and size limits as writes',async t=>{
 const f=await setup(t);await save(f);const r=await report(f);await update(f,r);const db=new DatabaseSync(f.path);t.after(()=>db.close());
 db.prepare("UPDATE records SET report_origin='retrospective' WHERE id=?").run(r.record_id);assert.throws(()=>validatePlanData(db),{code:'invalid_evidence'});
 db.prepare("UPDATE records SET report_origin='contemporaneous' WHERE id=?").run(r.record_id);
 const old=db.prepare('SELECT items_json FROM plan_versions').get().items_json,items=JSON.parse(old);items[0].component_key='mobile';db.prepare('UPDATE plan_versions SET items_json=?').run(JSON.stringify(items));assert.throws(()=>validatePlanData(db),{code:'scope_mismatch'});db.prepare('UPDATE plan_versions SET items_json=?').run(old);
 db.prepare('UPDATE plan_item_updates SET note=?').run('x'.repeat(801));assert.throws(()=>validatePlanData(db));
});
test('fresh MCP and authenticated HTTP return identical plan progress and original text without writing on reads',async t=>{
 const f=await setup(t);await save(f);const r=await report(f);await update(f,r);
 const client=new Client({name:'plan-check',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['dist/runtime/local/main.js','serve','--db',realpathSync(f.path)],stderr:'pipe'});transport.stderr.on('data',()=>{});await client.connect(transport);t.after(()=>client.close());
 const result=JSON.parse((await client.callTool({name:'memory_query_plans',arguments:{project_id:f.pid,plan_key:'notifications'}})).content[0].text);
 const viewer=await startViewer({db:f.path});t.after(()=>viewer.close());const token=new URLSearchParams(new URL(viewer.url).hash.slice(1)).get('token');
 const url=viewer.origin+'/api/plans?project='+f.pid+'&plan=notifications&repository=default&environment=development';
 assert.equal((await fetch(url)).status,401);const http=await fetch(url,{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());
 assert.deepEqual(http.progress,result.progress);assert.deepEqual(http.items,result.items);assert.equal(http.plan.source_body,source);
 assert.equal((await fetch(viewer.origin+'/plans.js')).status,200);
 assert.equal((await fetch(url.replace('notifications','../private'),{headers:{Authorization:'Bearer '+token}})).status,400);
});


test('escaped condition reports cannot create live rows that backup/import would reject',async t=>{
 const f=await setup(t),criteria=['a','b','c','d'].map(key=>({key,text:'완료 조건 '+key}));
 await save(f,{source_kind:'conversation',items:[{key:'item-1',title:'저장 한도',criteria}]});const r=await report(f);
 await assert.rejects(update(f,r,{criteria_results:criteria.map(c=>({key:c.key,met:true,detail:'\u0000'.repeat(300)}))}),{code:'invalid_input'});
 assert.equal((await query(f)).progress.completed_reported,0);
 const db=new DatabaseSync(f.path,{readOnly:true});try{validatePlanData(db);}finally{db.close();}
});

test('linked tasks retain earlier contributors with names and saved states, without mixing scopes or versions',async t=>{
 const f=await setup(t);await save(f);assert.equal((await query(f)).linked_tasks.total,0);
 const first=await report(f),u=await update(f,first);
 await f.call('memory_finish_task',{project_id:f.pid,run_id:f.rid,summary:'첫 작업 종료',outcome:'completed',idempotency_key:'first-finish'});
 const next=await run(f.call,f.pid,{idempotency_key:'next-task',title:'후속 알림 작업 <script>',actor:'Codex'}),second={...f,rid:next};
 const secondReport=await report(second,'second-report');await update(second,secondReport,{expected_update_id:u.update_id,idempotency_key:'second-update'});
 const other=await run(f.call,f.pid,{repository:'other',idempotency_key:'other-task'}),otherTask={...f,rid:other};
 await save(otherTask,{repository:'other',idempotency_key:'other-plan'});
 await update(otherTask,await report(otherTask,'other-report'),{repository:'other',idempotency_key:'other-update'});
 const data=await query(f);assert.equal(data.linked_tasks.total,2);assert.equal(data.linked_tasks.truncated,false);
 assert.deepEqual(data.linked_tasks.items.map(t=>t.id),[next,f.rid]);
 assert.equal(data.linked_tasks.items[0].title,'후속 알림 작업 <script>');assert.equal(data.linked_tasks.items[0].actor,'Codex');assert.equal(data.linked_tasks.items[0].state,'active');
 assert.deepEqual(data.linked_tasks.items[0].item_keys,['item-1']);assert.equal(data.linked_tasks.items[0].report_count,1);
 assert.equal(data.linked_tasks.items[1].state,'completed');assert.equal(data.items[0].task.id,next);assert.equal(data.items[0].task.title,'후속 알림 작업 <script>');
 assert.equal((await query(f,{remaining_only:true})).linked_tasks.total,2);
 await save(second,{expected_version:1,idempotency_key:'new-version'});
 assert.equal((await query(f)).linked_tasks.total,0);assert.equal((await query(f,{version:1})).linked_tasks.total,2);
});

test('linked task output is bounded and discloses the complete count and omitted history',async t=>{
 const f=await setup(t);await save(f);let prior=null,last;
 for(let i=0;i<22;i++){
  const rid=await run(f.call,f.pid,{idempotency_key:'bounded-task-'+i}),task={...f,rid};last=rid;
  const r=await report(task,'bounded-report-'+i),u=await update(task,r,{expected_update_id:prior,idempotency_key:'bounded-update-'+i});prior=u.update_id;
 }
 const data=await query(f);assert.equal(data.linked_tasks.total,22);assert.equal(data.linked_tasks.items.length,20);assert.equal(data.linked_tasks.truncated,true);assert.equal(data.linked_tasks.items[0].id,last);
});
