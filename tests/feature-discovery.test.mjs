import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,mkdtempSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {fixture,project,run,checkpoint} from './helpers.mjs';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
import {openLocal} from '../dist/runtime/local/app.js';
import {initialize} from '../dist/adapters/storage/transfer/database.js';
import {backupDatabase,restoreDatabase} from '../dist/adapters/storage/transfer/snapshot.js';
import {exportProject,importProject} from '../dist/adapters/storage/transfer/project.js';
import {startViewer} from '../dist/transport/viewer/server.js';
import {validateDatabase} from '../dist/adapters/storage/transfer/database.js';

const feature={key:'login',name:'사용자 인증',description:'계정 접근',aliases:['접속','ＬＯＧＩＮ','문자%_검색'],code_paths:['./src\\web\\login.ts','src/auth']};
const overview=(f,pid,query,extra={})=>f.call('memory_query_overview',{project_id:pid,query,...extra});
test('explicit aliases and segment paths find features and existing links with reasons, without reclassifying history',async t=>{
 const f=fixture(t),pid=await project(f.call);
 const old=await run(f.call,pid,{goal:'과거 미분류 작업',idempotency_key:'old'});
 const saved=await f.call('memory_checkpoint',checkpoint(pid,old,{body:'원문 그대로',idempotency_key:'old-note'}));
 const rid=await run(f.call,pid,{goal:'화면 정리',features:[feature],components:[{key:'web',name:'Web'}],idempotency_key:'new'});
 const viewer=new SqliteViewer(f.path);t.after(()=>viewer.close());
 for(const query of ['접속','login','src/web','src/web/login.ts','src/auth/session.ts','문자%_검색']){
  const ai=await overview(f,pid,query);assert.deepEqual(ai.items.map(x=>x.id),[rid]);assert.ok(ai.items[0].match_reasons.length);
  const human=viewer.runs(pid,{query});assert.deepEqual(human.items[0].match_reasons,ai.items[0].match_reasons);
  const candidates=await overview(f,pid,query,{view:'features'});assert.deepEqual(candidates.items.map(x=>x.key),['login']);
  assert.deepEqual(viewer.overview(pid,'features',0,{query,repository:'default',environment:'development'}).items,candidates.items);
 }
 const paths=(await overview(f,pid,'src/web',{view:'features'})).items[0];
 assert.equal(paths.match_reasons[0].kind,'code_path');assert.equal(paths.match_reasons[0].value,'src/web/login.ts');
 assert.equal(paths.discovery.file_access,'not_performed');assert.equal(paths.discovery.aliases.length,3);
 assert.deepEqual((await overview(f,pid,'src/web-other')).items,[]);
 assert.deepEqual((await overview(f,pid,'접속',{component:'unclassified'})).items,[]);
 assert.deepEqual((await f.call('memory_get_status',{project_id:pid,run_id:old})).run.components,[]);
 assert.equal((await f.call('memory_get_evidence',{project_id:pid,record_id:saved.record_id})).record.body,'원문 그대로');
});

test('project, repository, environment and component scope intersect search; equal aliases remain distinct candidates',async t=>{
 const f=fixture(t),pid=await project(f.call),other=await project(f.call,'other');
 await run(f.call,other,{features:[feature]});
 const web=await run(f.call,pid,{features:[feature],repository:'web',components:[{key:'web',name:'Web'}],idempotency_key:'web'});
 const api=await run(f.call,pid,{features:[{...feature,aliases:['서버 전용'],code_paths:['src/server']}],repository:'api',components:[{key:'api',name:'API'}],idempotency_key:'api'});
 await run(f.call,pid,{features:[{...feature,aliases:['스테이징'],code_paths:['src/stage']}],repository:'web',environment:'stage',idempotency_key:'stage'});
 assert.deepEqual((await overview(f,pid,'접속',{repository:'web'})).items.map(x=>x.id),[web]);
 assert.deepEqual((await overview(f,pid,'접속',{repository:'api'})).items,[]);
 assert.deepEqual((await overview(f,pid,'서버 전용',{coverage:'service',component:'web'})).items,[]);
 assert.deepEqual((await overview(f,pid,'서버 전용',{coverage:'service',component:'api'})).items.map(x=>x.id),[api]);
 assert.deepEqual((await overview(f,pid,'스테이징',{repository:'web'})).items,[]);
 await run(f.call,pid,{features:[{key:'other-login',name:'별도 인증',aliases:['접속']}],repository:'web',idempotency_key:'ambiguous'});
 const candidates=await overview(f,pid,'접속',{repository:'web',view:'features'});
 assert.deepEqual(candidates.items.map(x=>x.key),['login','other-login']);assert.equal(candidates.claims_verified,false);
 const bound=openLocal(f.path,{version:1,key:'example',name:'example',repository:'web',environment:'development'});t.after(()=>bound.close());
 await assert.rejects(bound.dispatcher.call('memory_query_overview',{project_id:other,query:'접속'}),{code:'scope_mismatch'});
});

test('search is applied before pagination and metadata truncation does not hide registered search terms',async t=>{
 const f=fixture(t),pid=await project(f.call);let rid;
 for(let i=0;i<45;i++)rid=await run(f.call,pid,{features:[{key:`f-${String(i).padStart(2,'0')}`,name:`기능 ${i}`,aliases:[i===44?'마지막 별칭':`별칭 ${i}`]}],idempotency_key:`r-${i}`});
 assert.equal((await overview(f,pid,'마지막 별칭',{view:'features',limit:1})).items[0].key,'f-44');
 assert.equal((await overview(f,pid,'마지막 별칭',{limit:1})).items[0].id,rid);
 await f.call('memory_checkpoint',checkpoint(pid,rid,{features:[{key:'f-44',name:'기능 44',aliases:Array.from({length:8},(_,i)=>`추가${i}`)}]}));
 const page=await overview(f,pid,'추가7',{view:'features'});assert.equal(page.items[0].match_reasons[0].value,'추가7');assert.equal(page.items[0].discovery.truncated,true);
 const all=await overview(f,pid,'별칭',{view:'features',limit:1});const next=await overview(f,pid,'별칭',{view:'features',limit:1,offset:all.next_offset});
 assert.notEqual(all.items[0].key,next.items[0].key);assert.ok(Buffer.byteLength(JSON.stringify(page))<32768);
});

test('invalid paths reject before writes and failed metadata registration leaves no partial links or records',async t=>{
 const f=fixture(t),pid=await project(f.call),rid=await run(f.call,pid);
 for(const path of ['/Users/private/code.ts','../src/a.ts','src/../a.ts','C:\\src\\a.ts','https://example.test/code','src/.env','src/private.key']){
  await assert.rejects(run(f.call,pid,{features:[{key:'bad',name:'bad',code_paths:[path]}],idempotency_key:path}),{code:'invalid_input'});
 }
 for(let i=0;i<8;i++)await f.call('memory_checkpoint',checkpoint(pid,rid,{features:[{key:'many',name:'Many',aliases:Array.from({length:8},(_,j)=>`a-${i}-${j}`)}],idempotency_key:`batch-${i}`}));
 await assert.rejects(f.call('memory_checkpoint',checkpoint(pid,rid,{features:[{key:'many',name:'Many',aliases:['overflow']},{key:'partial',name:'Partial'}],idempotency_key:'overflow'})),{code:'invalid_input'});
 assert.equal((await overview(f,pid,'overflow')).items.length,0);
 assert.equal((await overview(f,pid,'Partial',{view:'features'})).items.length,0);
});

test('v9 reads do not migrate or classify history; v10 upgrade preserves original rows and old receipts',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'skilly-discovery-old-')),path=join(dir,'old.sqlite'),pid=randomUUID(),rid=randomUUID(),date=new Date().toISOString();
 const db=new DatabaseSync(path);initialize(db,false,9);db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(pid,'old','Old',0,date);
 db.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)').run(rid,pid,'原文','change','development','default','completed',date,date);
 db.prepare('INSERT INTO features VALUES(?,?,?,?)').run(pid,'old-feature','과거 기능','');db.prepare('INSERT INTO run_features VALUES(?,?,?)').run(pid,rid,'old-feature');
 const original=db.prepare('SELECT * FROM runs').all();db.close();const bytes=readFileSync(path);
 const reader=new SqliteViewer(path);assert.equal(reader.overview(pid,'features',0,{query:'과거'}).items.length,1);reader.close();assert.deepEqual(readFileSync(path),bytes);
 const app=openLocal(path);await app.close();const after=new DatabaseSync(path,{readOnly:true});t.after(()=>after.close());
 assert.equal(after.prepare('PRAGMA user_version').get().user_version,10);assert.deepEqual(after.prepare('SELECT * FROM runs').all(),original);
 assert.equal(after.prepare('SELECT count(*) AS n FROM run_components').get().n,0);assert.equal(after.prepare('SELECT count(*) AS n FROM feature_aliases').get().n,0);
});

test('aliases and path source links survive full backup and single-project copy without leaking other projects',async t=>{
 const f=fixture(t),pid=await project(f.call),other=await project(f.call,'other');await run(f.call,pid,{features:[feature]});await run(f.call,other,{features:[{key:'secret-other',name:'다른 프로젝트',aliases:['다른 비공개 별칭']}]});
 const root=realpathSync(f.directory),source=realpathSync(f.path),backup=join(root,'backup');await backupDatabase(source,backup);const restored=await restoreDatabase(backup,join(root,'restored'));
 const bundle=join(root,'bundle');exportProject(source,pid,bundle);assert.ok(!readFileSync(join(bundle,'data.ndjson'),'utf8').includes('다른 비공개 별칭'));
 const imported=await importProject(bundle,join(root,'imported'));
 for(const path of [restored.db,imported.db]){const reader=new SqliteViewer(path);try{assert.equal(reader.overview(pid,'features',0,{query:'접속'}).items[0].match_reasons[0].kind,'feature_alias');assert.equal(reader.runs(pid,{query:'src/web'}).items.length,1);}finally{reader.close();}}
});

test('authenticated HTTP and MCP projections return the same scoped match reasons',async t=>{
 const f=fixture(t),pid=await project(f.call);await run(f.call,pid,{features:[feature]});
 const server=await startViewer({db:f.path,port:0});t.after(()=>server.close());const token=new URLSearchParams(new URL(server.url).hash.slice(1)).get('token');
 const params=new URLSearchParams({project:pid,view:'features',query:'接続なし',repository:'default',environment:'development'});
 assert.equal((await fetch(`${server.origin}/api/overview?${params}`)).status,401);
 params.set('query','接続なし');const none=await fetch(`${server.origin}/api/overview?${params}`,{headers:{Authorization:`Bearer ${token}`}});assert.deepEqual((await none.json()).items,[]);
 params.set('query','접속');const response=await fetch(`${server.origin}/api/overview?${params}`,{headers:{Authorization:`Bearer ${token}`}});
 const human=await response.json(),ai=await overview(f,pid,'접속',{view:'features'});assert.deepEqual(human.items,ai.items);assert.equal(response.status,200);
});

test('backup validation rejects empty metadata and a source task not linked to that feature',async t=>{
 const f=fixture(t),pid=await project(f.call),rid=await run(f.call,pid,{features:[feature]});
 const unrelated=await run(f.call,pid,{idempotency_key:'unrelated'}),db=new DatabaseSync(f.path);t.after(()=>db.close());
 db.prepare('UPDATE feature_aliases SET source_run_id=?').run(unrelated);assert.throws(()=>validateDatabase(db),{code:'invalid_data'});
 db.prepare('UPDATE feature_aliases SET source_run_id=?').run(rid);
 db.prepare('UPDATE feature_aliases SET alias=?,normalized_alias=? WHERE alias=?').run('','','접속');assert.throws(()=>validateDatabase(db),{code:'invalid_data'});
});
