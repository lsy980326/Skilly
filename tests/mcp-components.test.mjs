import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,symlinkSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openLocal} from '../dist/runtime/local/app.js';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
import {projectInstallationComponents} from '../dist/adapters/project/installation-components.js';
import {fixture,project,run,checkpoint} from './helpers.mjs';
const web={key:'web',name:'Web'},mobile={key:'mobile',name:'Mobile'};
function root(f,name,component){const candidate=join(f.directory,name);mkdirSync(candidate);const path=realpathSync(candidate);const binding={version:1,key:'example',name:'example',repository:'default',environment:'development',component};writeFileSync(join(path,'skilly.project.json'),JSON.stringify(binding));return {path,binding};}

test('MCP plans and skills use the same component classification and whole-plan denominator as the screen',async t=>{
 const f=fixture(t),pid=await project(f.call),w=root(f,'web',web),m=root(f,'mobile',mobile);
 writeFileSync(join(w.path,'skilly.components.json'),JSON.stringify({version:1,projects:[m.path]}));
 const app=openLocal(f.path,w.binding,w.path);t.after(()=>app.close());
 const call=(name,args)=>app.dispatcher.call(name,{project_id:pid,...args});
 const rid=await run(call,pid,{components:[web,mobile]});
 for(let i=0;i<15;i++)await call('memory_save_plan',{run_id:rid,plan_key:`old-${i}`,title:'Web 제목만',source_kind:'markdown',source_ref:'keep.md',source_body:'- [x] 예전 체크',idempotency_key:`old-${i}`});
 await call('memory_save_plan',{run_id:rid,plan_key:'mixed',title:'혼합',source_kind:'conversation',source_ref:'chat',source_body:'선택한 계획 원문',items:[{key:'w',title:'웹',component_key:'web',criteria:[{key:'done',text:'확인'}]},{key:'m',title:'모바일',component_key:'mobile',criteria:[{key:'done',text:'확인'}]}],idempotency_key:'mixed'});
 await call('memory_register_skill',{skill_key:'known',version:'1',source:'test:local',name:'스킬',body:'보존할 전문',install_instructions:'선택 설치',idempotency_key:'skill'});
 await call('memory_register_skill',{skill_key:'known',version:'2',source:'test:local',name:'스킬',body:'모바일 전문',install_instructions:'선택 설치',idempotency_key:'skill-v2'});
 const db=new DatabaseSync(f.path);t.after(()=>db.close());
 for(const path of [w.path,m.path])db.prepare('INSERT INTO skill_installations VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),pid,'known',path===m.path?'2':'1','default','development',path,'codex','use-skilly','2026-10-23T00:00:00Z');
 const screen=new SqliteViewer(f.path,Date.now,undefined,projectInstallationComponents(w.path));t.after(()=>screen.close());
 for(const component of ['web','mobile','unclassified']){
  const a=await call('memory_query_plans',{component}),b=screen.plans(pid,{component});assert.deepEqual(a,b);
  assert.deepEqual(await call('memory_list_skills',{component}),screen.skills(pid,{component}));
  assert.deepEqual(await call('memory_get_skill',{skill_key:'known',component}),screen.skills(pid,{key:'known',component}));
 }
 assert.equal((await call('memory_get_skill',{skill_key:'known',component:'mobile'})).skill.body,'모바일 전문');
 assert.equal((await call('memory_get_skill',{skill_key:'known',component:'web'})).skill.body,'보존할 전문');
 assert.equal((await call('memory_query_plans',{component:'web'})).items[0].progress.required,2);
 assert.equal((await call('memory_list_skills',{component:'web'})).items[0].installations.length,1);
 assert.equal((await call('memory_list_skills',{component:'web'})).items[0].loading_status,undefined);
 for(const name of ['memory_query_plans','memory_list_skills','memory_recovery_status'])await assert.rejects(call(name,{component:'../bad'}),{code:'invalid_input'});
});

test('MCP recovery matches screen classification before paging without changing retained payloads or scope',async t=>{
 const f=fixture(t),pid=await project(f.call),rid=await run(f.call,pid,{components:[web]});
 const db=new DatabaseSync(`${f.path}.recovery.sqlite`);t.after(()=>db.close());
 const insert=db.prepare('INSERT INTO requests(id,project_id,repository,environment,tool,request_key,payload_hash,input_json,received_at,last_error) VALUES(?,?,?,?,?,?,?,?,?,?)');
 const add=(id,input,repo='default')=>insert.run(id,pid,repo,'development','memory_checkpoint',id,'a'.repeat(64),input===null?null:JSON.stringify(input),'2026-10-23T00:00:00Z','busy');
 for(let i=0;i<43;i++)add(`old-${i}`,{goal:'웹 이름만'});
 add('web-linked',{run_id:rid});add('web-empty',{run_id:rid,components:[]});add('mobile-declared',{run_id:rid,components:[mobile]});add('wrong-scope',{run_id:rid},'other');add('rejected',null);add('invalid',{run_id:rid,components:['bad',null]});
 const before=db.prepare('SELECT * FROM requests ORDER BY id').all();
 const screen=new SqliteViewer(f.path);t.after(()=>screen.close());
 const all=async component=>{let offset=0,result=[];do{const r=await f.call('memory_recovery_status',{project_id:pid,component,include_rejected:true,offset,limit:20});result.push(...r.requests);offset=r.next_offset;}while(offset!==null);return result;};
 for(const component of ['web','mobile','unclassified']){
  const a=await all(component),b=[];let offset=0;do{const r=screen.recovery(pid,offset,'latest',component);b.push(...r.items.filter(x=>x.repository==='default'));offset=r.next_offset;}while(offset!==null);
  const shape=x=>[x.request_id,x.components,x.component_source,x.delivery_status];
  assert.deepEqual(a.map(shape).sort(),b.map(shape).sort());
 }
 const webStatus=await f.call('memory_recovery_status',{project_id:pid,component:'web'});assert.deepEqual(webStatus.unfinished_runs.map(x=>x.id),[rid]);assert.deepEqual(webStatus.unfinished_runs[0].components,[web]);
 const key='b'.repeat(64);add(key,{run_id:rid});assert.equal((await f.call('memory_recovery_status',{project_id:pid,component:'mobile',request_id:key})).requests.length,0);
 assert.equal((await f.call('memory_recovery_status',{project_id:pid,component:'web',request_id:key})).requests[0].request_id,key);
 const byId=await f.call('memory_recovery_status',{project_id:pid,request_id:key});assert.deepEqual(byId.requests[0].components,[web]);assert.equal(byId.requests[0].component_source,'stored_task');
 assert.deepEqual(db.prepare('SELECT * FROM requests WHERE id<>? ORDER BY id').all(key),before);
});

test('public component allowlist is bounded, explicit and never follows a symlink',t=>{
 const f=fixture(t),w=root(f,'web',web),m=root(f,'mobile',mobile),path=join(w.path,'skilly.components.json');
 assert.deepEqual(projectInstallationComponents(w.path).map(x=>x.key),['web']);
 writeFileSync(path,JSON.stringify({version:1,projects:[m.path]}));const before=readFileSync(path);assert.deepEqual(projectInstallationComponents(w.path).map(x=>x.key),['web','mobile']);assert.deepEqual(readFileSync(path),before);
 writeFileSync(path,JSON.stringify({version:1,projects:['relative']}));assert.throws(()=>projectInstallationComponents(w.path),/absolute/);
 writeFileSync(path,' '.repeat(4097));assert.throws(()=>projectInstallationComponents(w.path),/4 KiB/);
 const alias=root(f,'alias',web);symlinkSync(path,join(alias.path,'skilly.components.json'));assert.throws(()=>projectInstallationComponents(alias.path));
});

test('MCP unfinished runs disclose components omitted from the bounded projection',async t=>{
 const f=fixture(t),pid=await project(f.call),rid=await run(f.call,pid,{components:[web]});
 await f.call('memory_checkpoint',checkpoint(pid,rid,{components:Array.from({length:12},(_,i)=>({key:`z-${i.toString().padStart(2,'0')}`,name:`추가 ${i}`}))}));
 const status=await f.call('memory_recovery_status',{project_id:pid,component:'z-11'});
 assert.equal(status.unfinished_runs[0].id,rid);assert.equal(status.unfinished_runs[0].components.length,12);assert.equal(status.unfinished_runs[0].components_total,13);assert.equal(status.unfinished_runs[0].components_truncated,true);
});
