import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {openLocal} from '../dist/runtime/local/app.js';
import {SqliteCurrentKnowledge} from '../dist/adapters/storage/sqlite/current-knowledge.js';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
import {startViewer} from '../dist/transport/viewer/server.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const before={version:1,root_hash:'a'.repeat(64),project_key:'example',repository:'web',environment:'test',observed_at:'2026-10-24T00:00:00Z',status:'clean',commit:'b'.repeat(40),reason:null};
async function fixture(t){
 const root=realpathSync(mkdtempSync('/private/tmp/skilly-current-knowledge-')),path=join(root,'memory.sqlite'),app=openLocal(path);
 t.after(()=>app.close());const call=(name,input)=>app.dispatcher.call(name,input);
 const pid=(await call('memory_register_project',{key:'example',name:'현재 지식 시험',idempotency_key:'project'})).project.id;
 const begin=async(key,extra={})=>(await call('memory_begin_task',{project_id:pid,goal:'통합 조회 합성 회귀 검사',title:key,mode:'diagnose',repository:'web',environment:'test',components:[{key:'web',name:'Web'}],features:[{key:'alerts',name:'알림'}],idempotency_key:key,...extra})).run.id;
 const rid=await begin('begin');
 const note=async(key,extra={})=>call('memory_checkpoint',{project_id:pid,run_id:rid,topic:'alerts',kind:'change',body:key,report_origin:'contemporaneous',idempotency_key:key,...extra});
 const decision=async(key,extra={})=>note(key,{kind:'decision',decision:{subject:key,title:key,action:'decide',choice_key:'yes',targets:[],expected_current_ids:[],component_key:'web',feature_key:'alerts',source:{kind:'user_statement',reference:'합성 회귀 검사 입력',quote:key},...extra}});
 const savePlan=async(key='alerts-plan',extra={})=>call('memory_save_plan',{project_id:pid,run_id:rid,repository:'web',environment:'test',plan_key:key,title:key,source_kind:'conversation',source_ref:'합성 회귀 검사',source_body:'알림 저장과 화면 확인',items:[{key:'save',title:'알림 저장',component_key:'web',feature_key:'alerts',criteria:[{key:'saved',text:'설정이 저장된다'}]},{key:'screen',title:'모바일 화면',component_key:'mobile',criteria:[{key:'shown',text:'알림 화면이 보인다'}]}],idempotency_key:key,...extra});
 const query=(extra={})=>call('memory_query_current_knowledge',{project_id:pid,repository:'web',environment:'test',...extra});
 // Register Mobile explicitly without attributing existing work to it.
 await begin('register-mobile',{components:[{key:'mobile',name:'Mobile'}],features:[]});
 return {root,path,app,call,pid,rid,begin,note,decision,savePlan,query};
}
function execution(f,{failed=false,source=before,command='c'}={}){
 const id=f.app.executions.start({project_id:f.pid,run_id:f.rid,executable:'synthetic',command_hash:command.repeat(64),source_observation:source});
 f.app.executions.finish(id,{outcome:'exited',exit_code:failed?1:0,signal:null,error_code:null,duration_ms:1,stdout_bytes:0,stderr_bytes:0,stdout_hash:null,stderr_hash:null,stdout_hashed_bytes:0,stderr_hashed_bytes:0,output_complete:1},
 {status:'collected',framework:'node_test',counts:{tests:2,passed:failed?1:2,failed:failed?1:0,cancelled:0,skipped:0,todo:0,suites:0},suite_success:!failed,failures:failed?['synthetic assertion']:[],failures_truncated:false},source);return id;
}

test('one snapshot combines explicit decisions and latest plan progress without promoting AI reports or rewriting originals',async t=>{
 const f=await fixture(t),a=await f.decision('storage');
 const b=await f.decision('storage-replacement',{subject:'storage',action:'replace',choice_key:'db-only',targets:[a.record_id],expected_current_ids:[a.record_id]});
 const withdrawn=await f.decision('old-choice');await f.decision('withdraw',{subject:'old-choice',action:'withdraw',choice_key:undefined,targets:[withdrawn.record_id],expected_current_ids:[withdrawn.record_id]});
 await f.savePlan();const r=await f.note('AI가 구현과 성공을 보고',{report:{title:'완료 보고',summary:'합성 AI 보고',feature_updates:[{key:'alerts',state:'implemented',summary:'구현 보고'}]}});
 await f.call('memory_update_plan_item',{project_id:f.pid,run_id:f.rid,repository:'web',environment:'test',plan_key:'alerts-plan',version:1,item_key:'save',record_id:r.record_id,state:'completed',note:'저장 완료로 보고',criteria_results:[{key:'saved',met:true,detail:'합성 완료 보고'}],idempotency_key:'progress'});
 const raw=new DatabaseSync(f.path,{readOnly:true});t.after(()=>raw.close());const revision=raw.prepare('SELECT revision FROM projects WHERE id=?').get(f.pid).revision,bytes=readFileSync(f.path);
 const data=await f.query();assert.equal(data.snapshot,'single_database_read');assert.equal(data.project_revision,revision);assert.equal(data.claims_verified,false);assert.equal(data.agent_reports_promoted,false);
 assert.equal(data.decisions.items.find(d=>d.subject==='storage').active_choices[0].record_id,b.record_id);
 assert.equal(data.decisions.items.find(d=>d.subject==='old-choice').status,'withdrawn');
 assert.equal(data.plans.items[0].progress.percent,50);assert.equal(data.plans.items[0].remaining_items[0].key,'screen');
 assert.equal(data.checks.items[0].current_knowledge.status,'unknown');assert.equal(data.checks.items[0].agent_report.verified,false);
 const web=await f.query({component:'web'});assert.equal(web.plans.items[0].progress.percent,50);assert.equal(web.plans.items[0].selected_progress.percent,100);assert.equal(web.plans.items[0].remaining_total,0);
 assert.equal((await f.call('memory_get_evidence',{project_id:f.pid,record_id:a.record_id})).record.body,'storage');
 assert.equal(raw.prepare('SELECT revision FROM projects WHERE id=?').get(f.pid).revision,revision);assert.deepEqual(readFileSync(f.path),bytes);
 await f.savePlan('alerts-plan',{expected_version:1,idempotency_key:'v2'});assert.equal((await f.query()).plans.items[0].progress.percent,0);
});

test('current pass, current failure, stale, conflicting and unobservable checks remain distinct; source reads are memoized',async t=>{
 const f=await fixture(t);await f.savePlan();execution(f);const raw=new DatabaseSync(f.path,{readOnly:true});t.after(()=>raw.close());let lookups=0;
 const input={project_id:f.pid,repository:'web',environment:'test',component:'web'},reader=new SqliteCurrentKnowledge(raw,()=>{lookups++;return before;});
 let data=reader.query(input);assert.equal(data.checks.items[0].current_knowledge.status,'current');assert.equal(data.checks.items[0].current_knowledge.counts.passed,1);assert.equal(lookups,1);
 execution(f,{failed:true,command:'d'});data=reader.query(input);assert.equal(data.checks.items[0].current_knowledge.status,'current');assert.equal(data.checks.items[0].current_knowledge.counts.failed,1);
 execution(f,{failed:true});data=reader.query(input);assert.equal(data.checks.items[0].current_knowledge.status,'conflict');assert.equal(data.claims_verified,false);
 const stale=new SqliteCurrentKnowledge(raw,()=>({...before,commit:'d'.repeat(40)})).query(input);assert.equal(stale.checks.items[0].current_knowledge.status,'stale');
 assert.equal((await f.query()).checks.items[0].current_knowledge.status,'unknown');
});

test('sections paginate independently; exact project/repository/environment/component boundaries never infer missing links',async t=>{
 const f=await fixture(t);for(let i=0;i<3;i++){await f.decision('decision-'+i);await f.savePlan('plan-'+i);}
 const first=await f.query({limit:1});assert.equal(first.decisions.next_offset,1);assert.equal(first.plans.next_offset,1);
 const second=await f.query({limit:1,decisions_offset:1,plans_offset:1});assert.notEqual(first.decisions.items[0].subject,second.decisions.items[0].subject);assert.notEqual(first.plans.items[0].plan_key,second.plans.items[0].plan_key);
 for(const extra of [{repository:'other'},{environment:'other'},{component:'unclassified'}]){const x=await f.query(extra);assert.equal(x.decisions.items.length,0);assert.equal(x.plans.items.length,0);assert.equal(x.checks.items.length,0);}
 const pid2=(await f.call('memory_register_project',{key:'other',name:'Other',idempotency_key:'other'})).project.id;
 assert.equal((await f.query({project_id:pid2})).plans.items.length,0);
 await assert.rejects(f.query({limit:7}),{code:'invalid_input'});await assert.rejects(f.query({component:'../web'}),{code:'invalid_input'});
 const bound=openLocal(f.path,{version:1,key:'example',name:'현재 지식 시험',repository:'web',environment:'test'});t.after(()=>bound.close());
 assert.equal((await bound.dispatcher.call('memory_query_current_knowledge',{project_id:f.pid})).scope.repository,'web');
 await assert.rejects(bound.dispatcher.call('memory_query_current_knowledge',{project_id:f.pid,repository:'other'}),{code:'scope_mismatch'});
});

test('large remaining lists disclose truncation without changing the progress denominator',async t=>{
 const f=await fixture(t),items=Array.from({length:10},(_,i)=>({key:'item-'+i,title:'남은 일 '+i,component_key:'web',criteria:[{key:'ok',text:'조건 충족'}]}));
 await f.savePlan('many',{items});const data=await f.query();assert.equal(data.plans.items[0].remaining_total,10);assert.equal(data.plans.items[0].remaining_items.length,8);assert.equal(data.plans.items[0].remaining_truncated,true);assert.equal(data.plans.items[0].progress.required,10);
 for(let i=0;i<41;i++)execution(f);const raw=new DatabaseSync(f.path,{readOnly:true});t.after(()=>raw.close());const k=new SqliteCurrentKnowledge(raw,()=>before).query({project_id:f.pid}).checks.items[0].current_knowledge;
 assert.equal(k.status,'unknown');assert.equal(k.truncated,true);assert.equal(k.evidence.length,8);assert.equal(k.evidence_truncated,true);
});

test('remaining conditions preserve explicit partial completion reports and their saved work link',async t=>{
 const f=await fixture(t);await f.savePlan('partial',{items:[{key:'alerts',title:'알림',component_key:'web',criteria:[{key:'saved',text:'설정 저장'},{key:'shown',text:'화면 표시'}]}]});
 const r=await f.note('일부 조건 완료 보고');
 await f.call('memory_update_plan_item',{project_id:f.pid,run_id:f.rid,repository:'web',environment:'test',plan_key:'partial',version:1,item_key:'alerts',record_id:r.record_id,state:'in_progress',note:'화면은 남아 있습니다.',criteria_results:[{key:'saved',met:true,detail:'저장 구현 보고'},{key:'shown',met:false,detail:'화면 구현 전'}],idempotency_key:'partial-update'});
 const item=(await f.query()).plans.items[0].remaining_items[0];assert.equal(item.record_id,r.record_id);assert.equal(item.run_id,f.rid);assert.deepEqual(item.criteria.map(c=>c.reported_met),[true,false]);assert.ok(item.criteria.every(c=>c.claims_verified===false));
});

test('escaped large plans retain a bounded response, original progress and forward pagination',async t=>{
 const f=await fixture(t),items=Array.from({length:20},(_,i)=>({key:'item-'+i,title:'항목 '+i,component_key:'web',criteria:Array.from({length:4},(_,n)=>({key:'condition-'+n,text:'조건'+String.fromCharCode(1).repeat(80)}))}));
 for(let i=0;i<6;i++)await f.savePlan('large-'+i,{items});
 const result=await f.query({limit:6});assert.ok(Buffer.byteLength(JSON.stringify(result))<128*1024);assert.ok(result.plans.response_truncated);assert.ok(result.plans.items.length>0);assert.equal(result.plans.items[0].progress.required,20);assert.ok(result.plans.next_offset>0);
 const next=await f.query({limit:6,plans_offset:result.plans.next_offset});assert.notEqual(next.plans.items[0].plan_key,result.plans.items[0].plan_key);
});

test('fresh stdio MCP and authenticated HTTP share the projection and reject invalid input without database writes',async t=>{
 const f=await fixture(t);await f.decision('storage');await f.savePlan();execution(f);
 const viewer=await startViewer({db:f.path});t.after(()=>viewer.close());
 const headers={Authorization:'Bearer '+new URLSearchParams(new URL(viewer.url).hash.slice(1)).get('token')};
 assert.equal((await fetch(viewer.origin+'/api/current-knowledge?project='+f.pid)).status,401);
 const url=viewer.origin+'/api/current-knowledge?project='+f.pid+'&repository=web&environment=test';
 const http=await fetch(url,{headers}).then(r=>r.json());assert.equal((await fetch(url+'&limit=7',{headers})).status,400);
 const client=new Client({name:'current-knowledge-proof',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[new URL('../dist/runtime/local/main.js',import.meta.url).pathname,'serve','--db',f.path],stderr:'pipe'});transport.stderr.resume();await client.connect(transport);t.after(()=>client.close());
 assert.ok((await client.listTools()).tools.some(t=>t.name==='memory_query_current_knowledge'));
 const result=await client.callTool({name:'memory_query_current_knowledge',arguments:{project_id:f.pid,repository:'web',environment:'test'}});assert.notEqual(result.isError,true);const mcp=JSON.parse(result.content[0].text);
 for(const key of ['scope','project_revision','decisions','plans','checks','claims_verified','agent_reports_promoted'])assert.deepEqual(mcp[key],http[key]);
 const read=new SqliteViewer(f.path);t.after(()=>read.close());assert.deepEqual(read.currentKnowledge(f.pid,{repository:'web',environment:'test'}).checks,mcp.checks);
});
