import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openLocal} from '../dist/runtime/local/app.js';
import {recordLifecycle,readLifecycle} from '../dist/adapters/storage/sqlite/lifecycle.js';
import {exportProject,importProject} from '../dist/adapters/storage/transfer/project.js';
import {backupDatabase,restoreDatabase} from '../dist/adapters/storage/transfer/snapshot.js';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
import {startViewer} from '../dist/transport/viewer/server.js';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const files=db=>[db,db+'.recovery.sqlite',db+'.events.sqlite'].filter(existsSync).map(p=>[p,hash(p)]);
async function fixture(t) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'skilly-project-events-'))),db=join(root,'source.sqlite');
 const key=randomUUID();
 const make=async suffix=>{
  const folder=join(root,suffix);mkdirSync(folder);
  const binding={version:1,key:'project-'+suffix+'-'+key,name:'교환 검증 '+suffix,repository:'web',environment:'test'};
  writeFileSync(join(folder,'skilly.project.json'),JSON.stringify(binding));
  const app=openLocal(db,binding,folder);t.after(()=>app.close());
  const call=(name,args)=>app.dispatcher.call(name,args),pid=(await call('memory_resolve_project',{})).project.id;
  const run=(await call('memory_begin_task',{project_id:pid,goal:'합성 중단 이벤트를 포함한 테스트용 작업 '+suffix,title:'이벤트 교환 테스트 '+suffix,mode:'change',components:[{key:'web',name:'Web'}],idempotency_key:'begin-'+suffix})).run.id;
  const note=async label=>(await call('memory_checkpoint',{project_id:pid,run_id:run,topic:'fixture',kind:'change',body:'합성 시험 원문 '+label,idempotency_key:label,report_origin:'contemporaneous'})).record_id;
  const event=name=>recordLifecycle(db,folder,{cwd:folder,session_id:'synthetic-'+suffix,hook_event_name:name,tool_name:'Bash'}).observation_id;
  return {folder,binding,app,call,pid,run,note,event};
 };
 const other=await make('foreign');await other.note('foreign-before');other.event('SessionStart');
 const a=await make('selected');const first=await a.note('selected-before');
 const unlinked=a.event('Interrupt'),anchor=a.event('SessionStart');
 await a.call('memory_link_task_events',{project_id:a.pid,run_id:a.run,observation_id:anchor});
 await other.note('foreign-between');other.event('Interrupt');
 const point=await a.note('selected-saved'),interrupt=a.event('Interrupt');
 const latest=await a.note('selected-after');
 // Explicit synthetic association failure, not an actual host event.
 const eventDb=new DatabaseSync(db+'.events.sqlite'),link=eventDb.prepare('SELECT * FROM task_links WHERE run_id=?').get(a.run),failure=randomUUID();
 eventDb.prepare('INSERT INTO events VALUES(NULL,?,?,?,?,?,?,?,?,?,?,?)').run(failure,link.project_key,link.repository,link.environment,link.root_hash,link.session_hash,null,'PostToolUse',null,'shell',new Date().toISOString());
 eventDb.prepare('INSERT INTO event_link_failures VALUES(?,?,?)').run(failure,link.id,'association_unconfirmed');eventDb.close();
 const status=async()=> (await a.call('memory_get_status',{project_id:a.pid,run_id:a.run})).task_recording;
 return {root,db,a,other,first,unlinked,anchor,point,interrupt,latest,failure,status};
}
function rewrite(bundle,filename,change) {
 const path=join(bundle,filename),rows=readFileSync(path,'utf8').trimEnd().split('\n').filter(Boolean).map(JSON.parse);change(rows);
 writeFileSync(path,rows.map(row=>JSON.stringify(row)+'\n').join(''));
 const manifestPath=join(bundle,'manifest.json'),m=JSON.parse(readFileSync(manifestPath));
 const key=filename==='events.ndjson'?'events':'main';m.files[key]={sha256:hash(path),bytes:statSync(path).size};
 m[filename==='events.ndjson'?'event_rows':'rows']=rows.length;writeFileSync(manifestPath,JSON.stringify(m));
}
async function imported(t,f,base) {
 const bundle=join(f.root,'bundle-'+randomUUID());exportProject(f.db,f.a.pid,bundle);
 const result=await importProject(bundle,join(f.root,'copy-'+randomUUID()),base);
 const moved=join(result.directory,'moved-project');mkdirSync(moved);writeFileSync(join(moved,'skilly.project.json'),JSON.stringify(f.a.binding));
 const app=openLocal(result.db,f.a.binding,moved);t.after(()=>app.close());
 const status=async()=> (await app.dispatcher.call('memory_get_status',{project_id:f.a.pid,run_id:f.a.run})).task_recording;
 return {bundle,result,moved,app,status};
}

test('one-project bundle keeps scoped unlinked/linked/failure events and saved-point identities without altering sources',async t=>{
 const f=await fixture(t),source=await f.status(),before=files(f.db),copy=await imported(t,f);
 const m=JSON.parse(readFileSync(join(copy.bundle,'manifest.json')));assert.equal(m.version,3);assert.ok(m.event_rows>0);
 const content=readFileSync(join(copy.bundle,'events.ndjson'),'utf8');assert.ok(!content.includes(f.other.binding.key));assert.ok(!content.includes(f.other.run));
 const s=await copy.status();assert.equal(s.linkage,'not_linked');assert.deepEqual(s.events,[]);
 const h=s.imported_history;assert.equal(h.linkage,'historical_import');assert.equal(h.current_session_binding,false);assert.equal(h.claims_verified,false);
 assert.equal(h.interruption.observation_id,f.interrupt);assert.equal(h.interruption.received_at,source.interruption.received_at);
 assert.equal(h.interruption.saved_during_event.record_id,f.point);assert.equal(h.interruption.saved_during_event.source_seq,source.interruption.saved_during_event.seq);
 assert.equal(h.association_unconfirmed,1);assert.equal(h.interruption.saved_during_event.receipt_confirmed,true);
 const reader=new SqliteViewer(copy.result.db);try{assert.deepEqual(reader.detail(f.a.pid,f.a.run).run.task_recording,s);assert.equal(reader.projects().items.length,1);}finally{reader.close();}
 const raw=new DatabaseSync(copy.result.db+'.events.sqlite',{readOnly:true});try{
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version,2);
  assert.ok(raw.prepare('SELECT 1 FROM events WHERE id=?').get(f.unlinked));
  assert.equal(raw.prepare('SELECT count(*) n FROM event_imports WHERE kind=\'event\'').get().n,raw.prepare('SELECT count(*) n FROM events').get().n);
 }finally{raw.close();}
 const evidence=await copy.app.dispatcher.call('memory_get_evidence',{project_id:f.a.pid,record_id:f.point});assert.equal(evidence.record.body,'합성 시험 원문 selected-saved');assert.equal(evidence.verified,false);
 assert.deepEqual(files(f.db),before);
});

test('merging into a new copy rebases three sequence spaces, retains native base events, and round-trips origins again',async t=>{
 const f=await fixture(t),base=await fixture(t),before=files(base.db),old=await base.status(),source=await f.status();
 const copy=await imported(t,f,base.db),s=await copy.status();
 const baseApp=openLocal(copy.result.db,base.a.binding,base.a.folder);t.after(()=>baseApp.close());
 assert.deepEqual((await baseApp.dispatcher.call('memory_get_status',{project_id:base.a.pid,run_id:base.a.run})).task_recording,old);
 assert.equal(s.imported_history.interruption.saved_during_event.source_seq,source.interruption.saved_during_event.seq);
 assert.notEqual(s.imported_history.interruption.saved_during_event.seq,source.interruption.saved_during_event.seq);
 const bundle=join(f.root,'second-bundle');exportProject(copy.result.db,f.a.pid,bundle);
 const again=await importProject(bundle,join(f.root,'second-copy'));
 const view=new SqliteViewer(again.db);try{const h=view.detail(f.a.pid,f.a.run).run.task_recording.imported_history;assert.equal(h.interruption.observation_id,f.interrupt);assert.equal(h.interruption.saved_during_event.source_seq,source.interruption.saved_during_event.seq);}finally{view.close();}
 const backed=await backupDatabase(copy.result.db,join(f.root,'full-backup')),restored=await restoreDatabase(backed.directory,join(f.root,'full-restored'));
 const restoredView=new SqliteViewer(restored.db);try{assert.deepEqual(restoredView.detail(f.a.pid,f.a.run).run.task_recording,s);}finally{restoredView.close();}
 assert.deepEqual(files(base.db),before);
});

test('imported observations cannot become current anchors or capture future events even at the original root/session',async t=>{
 const f=await fixture(t),copy=await imported(t,f),same=openLocal(copy.result.db,f.a.binding,f.a.folder);t.after(()=>same.close());
 const call=(n,a)=>same.dispatcher.call(n,a);
 assert.equal((await call('memory_get_status',{project_id:f.a.pid,run_id:f.a.run})).task_recording.linkage,'not_linked');
 await assert.rejects(call('memory_link_task_events',{project_id:f.a.pid,run_id:f.a.run,observation_id:f.anchor}),e=>e.code==='scope_mismatch');
 const event=name=>recordLifecycle(copy.result.db,f.a.folder,{cwd:f.a.folder,session_id:'synthetic-selected',hook_event_name:name}).observation_id;
 event('Interrupt');assert.equal((await copy.status()).imported_history.interruption.observation_id,f.interrupt);
 const run=(await call('memory_begin_task',{project_id:f.a.pid,goal:'새 세션의 별도 합성 시험 작업',mode:'diagnose',idempotency_key:'new-session-task'})).run.id;
 await call('memory_link_task_events',{project_id:f.a.pid,run_id:run,observation_id:event('SessionStart')});const interrupted=event('Interrupt');
 assert.equal((await call('memory_get_status',{project_id:f.a.pid,run_id:run})).task_recording.interruption.observation_id,interrupted);
 const lifecycle=readLifecycle(copy.result.db,f.a.binding,f.a.folder);assert.ok(!lifecycle.items.some(e=>e.observation_id===f.anchor));assert.ok(lifecycle.imported_observations.items.some(e=>e.observation_id===f.anchor));
});

test('fresh stdio MCP and authenticated HTTP return identical imported history at a moved root',async t=>{
 const f=await fixture(t),copy=await imported(t,f),transport=new StdioClientTransport({command:process.execPath,args:[new URL('../dist/runtime/local/main.js',import.meta.url).pathname,'serve','--db',copy.result.db,'--project',copy.moved],stderr:'pipe'});
 const client=new Client({name:'event-project-transfer',version:'1'});transport.stderr.resume();t.after(()=>client.close());await client.connect(transport);
 const response=await client.callTool({name:'memory_get_status',arguments:{project_id:f.a.pid,run_id:f.a.run}});assert.notEqual(response.isError,true);
 const mcp=JSON.parse(response.content[0].text).task_recording;
 const viewer=await startViewer({db:copy.result.db});t.after(()=>viewer.close());const url=new URL(viewer.url),token=new URLSearchParams(url.hash.slice(1)).get('token'),path=url.origin+'/api/runs/'+f.a.run+'?project='+f.a.pid;
 assert.equal((await fetch(path)).status,401);
 const http=await fetch(path,{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());assert.deepEqual(http.run.task_recording,mcp);
 assert.equal(mcp.imported_history.interruption.saved_during_event.record_id,f.point);assert.equal(mcp.linkage,'not_linked');
});

test('resealed foreign scopes, broken anchors, saved sequences and records are rejected before output creation',async t=>{
 const f=await fixture(t),before=files(f.db);
 for(const kind of ['foreign','anchor','record','sequence','duplicate','unknown']) {
  const bundle=join(f.root,'bad-'+kind);exportProject(f.db,f.a.pid,bundle);
  rewrite(bundle,'events.ndjson',rows=>{
   if(kind==='foreign')rows.find(x=>x.table==='events').row.project_key=f.other.binding.key;
   if(kind==='anchor')rows.find(x=>x.table==='task_links').row.anchor_id=randomUUID();
   if(kind==='record'||kind==='sequence'){const x=rows.find(x=>x.table==='event_task_links'),saved=JSON.parse(x.row.saved_json);if(kind==='record')saved.record_id=randomUUID();else saved.seq+=100;x.row.saved_json=JSON.stringify(saved);}
   if(kind==='duplicate')rows.splice(0,0,rows[0]);
   if(kind==='unknown')rows[0].row.prompt='must not be accepted';
  });
  const target=join(f.root,'reject-'+kind);await assert.rejects(importProject(bundle,target));assert.equal(existsSync(target),false,kind);
 }
 assert.deepEqual(files(f.db),before);
});

test('event identity conflicts never overwrite base events or publish a completed import',async t=>{
 const f=await fixture(t),before=files(f.db),bundle=join(f.root,'bundle');exportProject(f.db,f.a.pid,bundle);
 const output=join(f.root,'conflict');await assert.rejects(importProject(bundle,output,f.db),e=>e.code==='import_conflict');
 assert.equal(existsSync(join(output,'import.json')),false);assert.deepEqual(files(f.db),before);
});

test('legacy event-free bundles and unlinked-only sidecars remain readable without inventing a task binding',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'skilly-project-events-legacy-'))),db=join(root,'source.sqlite'),binding={version:1,key:randomUUID(),name:'Legacy transfer',repository:'web',environment:'test'};
 writeFileSync(join(root,'skilly.project.json'),JSON.stringify(binding));
 const app=openLocal(db,binding,root);t.after(()=>app.close());const pid=(await app.dispatcher.call('memory_resolve_project',{})).project.id;
 const bundle=join(root,'v1');exportProject(db,pid,bundle);assert.equal(JSON.parse(readFileSync(join(bundle,'manifest.json'))).version,1);
 const legacy=await importProject(bundle,join(root,'v1-copy'));assert.equal(legacy.events,'not_in_bundle');
 const observation=recordLifecycle(db,root,{cwd:root,session_id:'synthetic-unlinked',hook_event_name:'Interrupt'}).observation_id;
 const newer=join(root,'v3');exportProject(db,pid,newer);const result=await importProject(newer,join(root,'v3-copy'));
 const raw=new DatabaseSync(result.db+'.events.sqlite',{readOnly:true});try{assert.equal(raw.prepare('SELECT count(*) n FROM task_links').get().n,0);assert.ok(raw.prepare('SELECT 1 FROM events WHERE id=?').get(observation));}finally{raw.close();}
 const lifecycle=readLifecycle(result.db,binding,root);assert.deepEqual(lifecycle.items,[]);assert.equal(lifecycle.imported_observations.items[0].observation_id,observation);
});

test('undeclared companions and event overlays fail closed without a completed output',async t=>{
 const f=await fixture(t);
 for(const name of ['memory.sqlite.events.sqlite','memory.sqlite.events.sqlite-wal','events.ndjson-wal','events.ndjson-shm','events.ndjson-journal']){
  const bundle=join(f.root,'overlay-'+name);exportProject(f.db,f.a.pid,bundle);writeFileSync(join(bundle,name),'unsealed');
  const output=join(f.root,'overlay-output-'+name);await assert.rejects(importProject(bundle,output),e=>e.code==='unsealed_bundle');assert.equal(existsSync(output),false);
 }
 const bundle=join(f.root,'undeclared');exportProject(f.db,f.a.pid,bundle);
 const m=JSON.parse(readFileSync(join(bundle,'manifest.json')));m.version=1;delete m.files.events;delete m.event_rows;delete m.events_snapshot_at;writeFileSync(join(bundle,'manifest.json'),JSON.stringify(m));
 await assert.rejects(importProject(bundle,join(f.root,'undeclared-output')),e=>e.code==='unsealed_bundle');
});

test('unsupported source event schema cannot publish an export',async t=>{
 const f=await fixture(t),raw=new DatabaseSync(f.db+'.events.sqlite');raw.exec('PRAGMA user_version=99;');raw.close();const before=files(f.db),output=join(f.root,'unsupported');
 assert.throws(()=>exportProject(f.db,f.a.pid,output),e=>e.code==='invalid_event_store');assert.equal(existsSync(output),false);assert.deepEqual(files(f.db),before);
});
