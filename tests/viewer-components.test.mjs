import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
import {installationComponents} from '../dist/adapters/project/installation-components.js';
import {recoverySchemaSql} from '../dist/adapters/storage/sqlite/recovery-schema.js';
import {startViewer} from '../dist/transport/viewer/server.js';
import {fixture,project,run,checkpoint} from './helpers.mjs';

const web={key:'web',name:'Web'},mobile={key:'mobile',name:'Mobile'};
function root(f,name,component,key='example'){
 const path=join(f.directory,name);mkdirSync(path);writeFileSync(join(path,'skilly.project.json'),JSON.stringify({version:1,key,name:key,repository:'workspace',environment:'development',component}));return realpathSync(path);
}
function reader(t,f,bindings=[]){const r=new SqliteViewer(f.path,Date.now,undefined,bindings);t.after(()=>r.close());return r;}

test('features use only stored task links in the selected project and scope, never a title guess',async t=>{
 const f=fixture(t),pid=await project(f.call),other=await project(f.call,'other');
 await run(f.call,pid,{components:[web],features:[{key:'shared',name:'공유 기능'}],repository:'web-repo',idempotency_key:'web'});
 await run(f.call,pid,{components:[mobile],features:[{key:'shared',name:'공유 기능'}],repository:'mobile-repo',idempotency_key:'mobile'});
 await run(f.call,pid,{title:'Web 모바일 작업',features:[{key:'old',name:'Web 예전 기능'}],idempotency_key:'unknown'});
 await run(f.call,other,{components:[{key:'foreign',name:'다른 프로젝트'}],features:[{key:'shared',name:'공유 기능'}],idempotency_key:'foreign'});
 const r=reader(t,f),all=r.overview(pid,'features').items;
 assert.deepEqual(all.find(x=>x.key==='shared').components.map(c=>c.key),['mobile','web']);
 assert.deepEqual(r.overview(pid,'features',0,{component:'web'}).items.map(x=>x.key),['shared']);
 assert.deepEqual(r.overview(pid,'features',0,{component:'unclassified'}).items.map(x=>x.key),['old']);
 assert.deepEqual(r.overview(pid,'features',0,{repository:'web-repo'}).items[0].components,[web]);
 assert.equal(r.overview(pid,'features',0,{component:'foreign'}).items.length,0);
});

test('plan classification uses only latest-version item declarations before pagination and preserves whole-plan progress',async t=>{
 const f=fixture(t),pid=await project(f.call),rid=await run(f.call,pid,{components:[web,mobile]});
 const save=(key,extra={})=>f.call('memory_save_plan',{project_id:pid,run_id:rid,plan_key:key,title:key,source_kind:'markdown',source_ref:'original.md',source_body:'- [x] Web 이름만 있는 항목\n- [ ] 나머지',idempotency_key:key,...extra});
 for(let i=0;i<14;i++)await save(`plan-${i}`);
 const items=[{key:'web',title:'웹 항목',component_key:'web',criteria:[{key:'done',text:'저장'}]},{key:'unknown',title:'미지정 항목',criteria:[{key:'done',text:'확인'}]}];
 await save('z-mixed',{source_kind:'conversation',items});
 const r=reader(t,f);let result=r.plans(pid,{component:'web',sort:'name'});
 assert.equal(result.items.length,1);assert.equal(result.next_offset,null);assert.equal(result.items[0].plan_key,'z-mixed');assert.deepEqual(result.items[0].components,[web]);assert.equal(result.items[0].components_partial,true);assert.equal(result.items[0].progress.required,2);
 assert.equal(r.plans(pid,{component:'unclassified'}).items.length,12);assert.equal(r.plans(pid,{component:'mobile'}).items.length,0);
 await save('z-mixed',{source_kind:'conversation',expected_version:1,items:[{...items[0],component_key:'mobile'}],idempotency_key:'version2'});
 assert.equal(r.plans(pid,{component:'web'}).items.length,0);assert.equal(r.plans(pid,{component:'mobile'}).items[0].version,2);
 assert.throws(()=>r.plans(pid,{component:'../web'}),{code:'invalid_input'});
});

test('skill components come only from exact permitted root bindings; installations are never followed or treated as execution',async t=>{
 const f=fixture(t),pid=await project(f.call),webRoot=root(f,'web-root',web),mobileRoot=root(f,'mobile-root',mobile),foreignRoot=root(f,'foreign-root',web,'other');
 const bindings=installationComponents([webRoot,mobileRoot,foreignRoot]);
 const db=new DatabaseSync(f.path);t.after(()=>db.close());
 const insert=db.prepare('INSERT INTO skill_installations VALUES(?,?,?,?,?,?,?,?,?,?)');
 for(let i=0;i<15;i++)await f.call('memory_register_skill',{project_id:pid,skill_key:`skill-${i}`,version:'1',source:'local:test',name:`스킬 ${i}`,body:'보존할 전문',install_instructions:'실행하지 않는 안내',idempotency_key:`skill-${i}`});
 const assign=(key,path,repo='workspace')=>insert.run(randomUUID(),pid,key,'1',repo,'development',path,'codex','test','2026-10-23T00:00:00Z');
 assign('skill-14',webRoot);assign('skill-14',mobileRoot);assign('skill-13',join(f.directory,'never-open-this'));assign('skill-12',foreignRoot);assign('skill-11',webRoot,'other-scope');
 const r=reader(t,f,bindings),only=r.skills(pid,{component:'web'});assert.equal(only.items.length,1);assert.equal(only.items[0].skill_key,'skill-14');assert.equal(only.next_offset,null);
 assert.deepEqual(only.items[0].components.map(x=>x.key),['mobile','web']);assert.equal(only.items[0].component_source,'installation_binding');assert.ok(only.items[0].installations.every(x=>x.state==='not_checked'));
 assert.equal(r.skills(pid,{component:'mobile'}).items[0].skill_key,'skill-14');assert.equal(r.skills(pid,{component:'unclassified'}).items.length,12);
 assert.equal(reader(t,f).skills(pid,{component:'web'}).items.length,0);
 assert.equal(r.skills(pid,{key:'skill-14'}).skill.body,'보존할 전문');
 assert.throws(()=>installationComponents(['relative']),/absolute/);assert.throws(()=>installationComponents(Array(17).fill(webRoot)),/limit/);
});

test('recovery classification filters before paging, distinguishes pending declarations and enforces stored task scope',async t=>{
 const f=fixture(t),pid=await project(f.call),rid=await run(f.call,pid,{components:[web]}),r=reader(t,f);
 const journal=new DatabaseSync(`${f.path}.recovery.sqlite`);if(!journal.prepare("SELECT 1 FROM sqlite_master WHERE name='requests'").get())journal.exec(recoverySchemaSql);t.after(()=>journal.close());
 const insert=journal.prepare('INSERT INTO requests(id,project_id,repository,environment,tool,request_key,payload_hash,input_json,received_at,last_error) VALUES(?,?,?,?,?,?,?,?,?,?)');
 const add=(id,input,repo='default')=>insert.run(id,pid,repo,'development','memory_checkpoint',id,'a'.repeat(64),input===null?null:JSON.stringify(input),'2026-10-23T00:00:00Z','busy');
 for(let i=0;i<43;i++)add(`old-${i}`,{goal:'Web 요청 이름만'});
 add('web-linked',{run_id:rid});add('web-empty',{run_id:rid,components:[]});add('mobile-declared',{run_id:rid,components:[mobile]});add('wrong-scope',{run_id:rid},'other');add('removed',null);add('invalid-declaration',{components:['not an object',null]});
 const before=journal.prepare('SELECT * FROM requests ORDER BY id').all();
 let result=r.recovery(pid,0,'latest','web');assert.equal(result.status,'available');assert.deepEqual(result.items.map(x=>x.request_id),['web-linked','web-empty']);assert.equal(result.next_offset,null);assert.ok(result.items.every(x=>x.component_source==='stored_task'));
 result=r.recovery(pid,0,'latest','mobile');assert.equal(result.items.length,1);assert.equal(result.items[0].component_source,'request_declaration');assert.equal(result.items[0].delivery_status,'recovery_pending');
 assert.deepEqual(result.items[0].components,[mobile]);assert.equal('input_json' in result.items[0],false);
 const unknown=r.recovery(pid,0,'latest','unclassified');assert.equal(unknown.status,'available');assert.equal(unknown.items.length,40);assert.equal(unknown.next_offset,40);assert.equal(r.recovery(pid,40,'latest','unclassified').items.length,6);
 assert.deepEqual(journal.prepare('SELECT * FROM requests ORDER BY id').all(),before);
 await f.call('memory_checkpoint',checkpoint(pid,rid,{components:Array.from({length:12},(_,i)=>({key:`extra-${i}`,name:`추가 ${i}`}))}));
 const truncated=r.recovery(pid,0,'latest','extra-11');assert.equal(truncated.items.length,2);assert.ok(truncated.items.every(x=>x.components.length===12&&x.components_truncated));
});

test('HTTP component filtering stays authenticated, reads only configured public bindings and survives reload',async t=>{
 const f=fixture(t),pid=await project(f.call),path=root(f,'permitted',web),original=readFileSync(join(path,'skilly.project.json'));
 await run(f.call,pid,{components:[web],features:[{key:'sample',name:'기능'}]});
 const server=await startViewer({db:f.path,sourceProjects:[path]});t.after(()=>server.close());
 const token=new URLSearchParams(new URL(server.url).hash.slice(1)).get('token'),headers={Authorization:`Bearer ${token}`};
 for(const api of ['/api/plans','/api/skills','/api/recovery','/api/overview']){
  const suffix=api==='/api/overview'?'&view=features':'';
  assert.equal((await fetch(`${server.origin}${api}?project=${pid}&component=web${suffix}`,{headers})).status,200);
  assert.equal((await fetch(`${server.origin}${api}?project=${pid}&component=../bad${suffix}`,{headers})).status,400);
  assert.equal((await fetch(`${server.origin}${api}?project=${pid}&component=web${suffix}`)).status,401);
 }
 server.reload();assert.equal((await fetch(`${server.origin}/api/overview?project=${pid}&view=features&component=web`,{headers})).status,200);
 assert.deepEqual(readFileSync(join(path,'skilly.project.json')),original);
});
