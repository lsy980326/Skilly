import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,realpathSync,writeFileSync,readFileSync,existsSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openLocal} from '../dist/runtime/local/app.js';
import {recordLifecycle} from '../dist/adapters/storage/sqlite/lifecycle.js';
import {prepareTransfer,activateTransfer,recoverTransfer,transferStatus} from '../dist/adapters/storage/transfer/cutover.js';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
import {startViewer} from '../dist/transport/viewer/server.js';
import {backupDatabase,restoreDatabase} from '../dist/adapters/storage/transfer/snapshot.js';
import {exportProject,importProject} from '../dist/adapters/storage/transfer/project.js';
import {SqliteTaskEvents} from '../dist/adapters/storage/sqlite/task-events.js';
const runtime=new URL('../dist/runtime/local/main.js',import.meta.url).pathname;
async function fixture(t,{linked=true}={}){
 const root=realpathSync(mkdtempSync('/private/tmp/skilly-cutover-')),db=join(root,'memory.sqlite');
 const make=async name=>{
  const folder=join(root,name);mkdirSync(folder);const binding={version:1,key:name+'-'+randomUUID(),name:'전환 시험 '+name,repository:'web',environment:'test'};
  writeFileSync(join(folder,'skilly.project.json'),JSON.stringify(binding));const app=openLocal(db,binding,folder);t.after(()=>app.close());
  const call=(name,args)=>app.dispatcher.call(name,args),pid=(await call('memory_resolve_project',{})).project.id;
  const run=(await call('memory_begin_task',{project_id:pid,goal:'합성 이벤트를 사용한 쓰기 전환 시험',title:'독립 이전 쓰기 시험',mode:'diagnose',components:[{key:'web',name:'Web'}],idempotency_key:'begin'})).run.id;
  const note=async(label)=>(await call('memory_checkpoint',{project_id:pid,run_id:run,kind:'change',topic:'cutover',body:'원문 보존 '+label,idempotency_key:label})).record_id;
  const point=await note('첫 저장');return {folder,binding,app,call,pid,run,note,point};
 };
 const a=await make('selected'),other=await make('other');
 const event=name=>recordLifecycle(db,a.folder,{cwd:a.folder,session_id:'synthetic-cutover',hook_event_name:name}).observation_id;
 const anchor=event('SessionStart');if(linked)await a.call('memory_link_task_events',{project_id:a.pid,run_id:a.run,observation_id:anchor});const interrupt=event('Interrupt');
 const state=join(root,'transfer'),status=async app=>(await app.dispatcher.call('memory_get_status',{project_id:a.pid,run_id:a.run}));
 const open=path=>{const app=openLocal(path,a.binding,a.folder);t.after(()=>app.close());return app;};
 return {root,db,a,other,event,interrupt,state,status,open};
}
const blocked=error=>error.code==='project_write_blocked'||error.message.includes('project_write_blocked');

test('prepared transfer fences existing writers in main/recovery/events, preserves other projects and activates only the target',async t=>{
 const f=await fixture(t),beforeBinding=readFileSync(join(f.a.folder,'skilly.project.json'));
 const old=new DatabaseSync(f.db),journal=new DatabaseSync(f.db+'.recovery.sqlite'),events=new DatabaseSync(f.db+'.events.sqlite');t.after(()=>{old.close();journal.close();events.close();});
 const oldStatement=old.prepare('UPDATE runs SET updated_at=updated_at WHERE id=?');
 const prepared=await prepareTransfer(f.db,f.a.pid,f.state);assert.equal(prepared.status,'prepared');assert.equal(prepared.active_db,null);
 await assert.rejects(f.a.note('blocked'),blocked);
 assert.throws(()=>oldStatement.run(f.a.run),blocked);
 assert.throws(()=>old.prepare('UPDATE records SET body=body WHERE id=?').run(f.a.point),blocked);
 assert.throws(()=>old.prepare('UPDATE receipts SET payload_hash=payload_hash WHERE scope=?').run(f.a.pid),blocked);
 assert.throws(()=>journal.prepare('UPDATE requests SET last_error=last_error WHERE project_id=?').run(f.a.pid),blocked);
 assert.throws(()=>events.prepare('UPDATE events SET received_at=received_at WHERE project_key=?').run(f.a.binding.key),blocked);
 assert.throws(()=>f.event('Stop'),blocked);
 const source=await f.status(f.a.app);assert.equal(source.write_authority.status,'fenced');assert.equal((await f.a.call('memory_resolve_project',{})).write_authority.write_allowed,false);
 await f.other.note('다른 프로젝트는 계속 저장');
 const activated=activateTransfer(f.state);assert.equal(activated.status,'active');assert.deepEqual(activateTransfer(f.state),activated);
 const target=f.open(activated.active_db),status=await f.status(target);assert.equal(status.write_authority.current_copy,'target');assert.equal(status.write_authority.write_allowed,true);
 const id=(await target.dispatcher.call('memory_checkpoint',{project_id:f.a.pid,run_id:f.a.run,kind:'change',topic:'cutover',body:'전환 후 저장',idempotency_key:'after'})).record_id;
 assert.ok((await target.dispatcher.call('memory_get_evidence',{project_id:f.a.pid,record_id:id})).record);
 assert.equal(status.task_recording.imported_history.interruption.saved_during_event.record_id,f.a.point);
 const retained=new DatabaseSync(f.db+'.recovery.sqlite',{readOnly:true});try{assert.equal(retained.prepare("SELECT count(*) n FROM requests WHERE request_key='blocked'").get().n,0);}finally{retained.close();}
 assert.deepEqual(readFileSync(join(f.a.folder,'skilly.project.json')),beforeBinding);
});

test('recovery before activation reopens the source and leaves the unused target fenced',async t=>{
 const f=await fixture(t);await prepareTransfer(f.db,f.a.pid,f.state);const restored=await recoverTransfer(f.state);
 assert.equal(restored.status,'aborted');assert.equal(restored.active_db,f.db);assert.deepEqual(await recoverTransfer(f.state),restored);await f.a.note('원본에서 재개');
 const target=f.open(join(f.state,'target','memory.sqlite'));assert.equal((await f.status(target)).write_authority.write_allowed,false);
});

test('recovery after target writes preserves the newest records in a fresh return copy and keeps both older copies fenced',async t=>{
 const f=await fixture(t);await prepareTransfer(f.db,f.a.pid,f.state);const activated=activateTransfer(f.state),target=f.open(activated.active_db);
 const changed=(await target.dispatcher.call('memory_checkpoint',{project_id:f.a.pid,run_id:f.a.run,kind:'change',topic:'cutover',body:'새 DB의 최신 원문',idempotency_key:'target-latest'})).record_id;
 const result=await recoverTransfer(f.state);assert.equal(result.status,'returned');assert.notEqual(result.active_db,f.db);assert.notEqual(result.active_db,activated.active_db);
 const returned=f.open(result.active_db),evidence=await returned.dispatcher.call('memory_get_evidence',{project_id:f.a.pid,record_id:changed});assert.equal(evidence.record.body,'새 DB의 최신 원문');assert.equal(evidence.verified,false);
 assert.equal((await f.status(returned)).write_authority.current_copy,'return');
 assert.equal((await f.status(target)).write_authority.write_allowed,false);assert.equal((await f.status(f.a.app)).write_authority.write_allowed,false);
 await assert.rejects(f.a.note('still-blocked'),blocked);
 await assert.rejects(target.dispatcher.call('memory_checkpoint',{project_id:f.a.pid,run_id:f.a.run,kind:'note',topic:'cutover',body:'blocked',idempotency_key:'target-blocked'}),blocked);
 assert.deepEqual(await recoverTransfer(f.state),result);await f.other.note('원래 DB의 다른 프로젝트 유지');
 const backed=await backupDatabase(result.active_db,join(f.root,'backup')),restored=await restoreDatabase(backed.directory,join(f.root,'restored'));
 const viewer=new SqliteViewer(restored.db);try{assert.equal(viewer.detail(f.a.pid,f.a.run).run.write_authority.current_copy,'return');}finally{viewer.close();}
});

test('a crash between activation and its receipt cannot reopen an outdated source',async t=>{
 const f=await fixture(t);await prepareTransfer(f.db,f.a.pid,f.state);activateTransfer(f.state);
 // Synthetic lost final coordinator commit; the target fence still records its activation.
 const db=new DatabaseSync(join(f.state,'operation.sqlite'));db.exec("UPDATE operation SET phase='prepared'");db.close();
 const result=await recoverTransfer(f.state);assert.equal(result.status,'returned');assert.notEqual(result.active_db,f.db);assert.equal((await f.status(f.a.app)).write_authority.write_allowed,false);
});

test('a second crash after target fencing cannot erase its durable activation intent',async t=>{
 const f=await fixture(t);await prepareTransfer(f.db,f.a.pid,f.state);const active=activateTransfer(f.state),target=f.open(active.active_db);
 const record=(await target.dispatcher.call('memory_checkpoint',{project_id:f.a.pid,run_id:f.a.run,kind:'change',topic:'cutover',body:'두 번째 중단 전 새 기록',idempotency_key:'double-crash'})).record_id;
 // Synthetic crash checkpoints: first coordinator commit lost, then target fencing committed.
 const control=new DatabaseSync(join(f.state,'operation.sqlite'));control.exec("UPDATE operation SET phase='prepared'");control.close();
 for(const suffix of ['', '.recovery.sqlite','.events.sqlite']){const db=new DatabaseSync(active.active_db+suffix);db.exec("UPDATE project_authority SET state='blocked'");db.close();}
 assert.equal(transferStatus(f.state).activation_intent,true);
 const recovered=await recoverTransfer(f.state);assert.equal(recovered.status,'returned');assert.notEqual(recovered.active_db,f.db);
 assert.equal((await f.status(f.a.app)).write_authority.write_allowed,false);
 assert.equal((await f.open(recovered.active_db).dispatcher.call('memory_get_evidence',{project_id:f.a.pid,record_id:record})).record.body,'두 번째 중단 전 새 기록');
});

test('a lifecycle-only sidecar receives every link fence before an old linking connection can create tables',async t=>{
 const f=await fixture(t,{linked:false}),observation=f.event('PostToolUse'),oldDb=new DatabaseSync(f.db),oldLinker=new SqliteTaskEvents(oldDb,f.db,f.a.folder);t.after(()=>oldDb.close());
 await prepareTransfer(f.db,f.a.pid,f.state);
 await assert.rejects(oldLinker.link(f.a.pid,f.a.run,observation),blocked);
 assert.equal(transferStatus(f.state).status,'prepared');
});

test('unfinished executions, foreign ownership and replaced source identities never create two writable copies',async t=>{
 const f=await fixture(t),id=f.a.app.executions.start({project_id:f.a.pid,run_id:f.a.run,executable:'synthetic',command_hash:'a'.repeat(64)});
 await assert.rejects(prepareTransfer(f.db,f.a.pid,f.state),e=>e.code==='execution_in_progress');assert.equal((await f.status(f.a.app)).write_authority.write_allowed,true);
 assert.ok(id);const original=join(f.root,'source-retained.sqlite');renameSync(f.db,original);writeFileSync(f.db,'replacement');
 assert.throws(()=>transferStatus(f.state),e=>e.code==='source_changed');assert.ok(existsSync(original));
});

test('a fenced source runner does not spawn a child and does not add an execution result',async t=>{
 const f=await fixture(t);await prepareTransfer(f.db,f.a.pid,f.state);activateTransfer(f.state);const marker=join(f.root,'should-not-exist');
 const result=spawnSync(process.execPath,[runtime,'exec','--db',f.db,'--project',f.a.folder,'--run-id',f.a.run,'--',process.execPath,'-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`],{encoding:'utf8'});
 assert.notEqual(result.status,0);assert.match(result.stderr,/project_write_blocked/);assert.equal(existsSync(marker),false);
});

test('managed logical exports require an explicit activation workflow and physical backups do not inherit writing',async t=>{
 const f=await fixture(t);await prepareTransfer(f.db,f.a.pid,f.state);const active=activateTransfer(f.state),bundle=join(f.root,'copy-export');exportProject(active.active_db,f.a.pid,bundle);
 assert.equal(JSON.parse(readFileSync(join(bundle,'manifest.json'))).requires_activation,true);
 const output=join(f.root,'unmanaged-import');await assert.rejects(importProject(bundle,output),e=>e.code==='activation_required');assert.equal(existsSync(output),false);
 const backed=await backupDatabase(active.active_db,join(f.root,'backup-copy')),restored=await restoreDatabase(backed.directory,join(f.root,'backup-restore'));
 const copy=f.open(restored.db);assert.equal((await f.status(copy)).write_authority.write_allowed,false);
 await assert.rejects(copy.dispatcher.call('memory_begin_task',{project_id:f.a.pid,goal:'should not start',mode:'change',idempotency_key:'no-copy-writer'}),blocked);
});

test('failed activation stays fenced, can recover safely, and conflicting transfers cannot take over',async t=>{
 const f=await fixture(t);await prepareTransfer(f.db,f.a.pid,f.state);
 await assert.rejects(prepareTransfer(f.db,f.a.pid,join(f.root,'competing')),e=>e.code==='authority_conflict');
 const target=join(f.state,'target','memory.sqlite'),journal=new DatabaseSync(target+'.recovery.sqlite');journal.exec('BEGIN IMMEDIATE');
 try {assert.throws(()=>activateTransfer(f.state));assert.equal((await f.status(f.a.app)).write_authority.write_allowed,false);assert.equal((await f.status(f.open(target))).write_authority.write_allowed,false);}
 finally{journal.exec('ROLLBACK');journal.close();}
 const recovered=await recoverTransfer(f.state);assert.equal(recovered.status,'returned');assert.equal((await f.status(f.a.app)).write_authority.write_allowed,false);
 const resumed=f.open(recovered.active_db);await resumed.dispatcher.call('memory_checkpoint',{project_id:f.a.pid,run_id:f.a.run,kind:'change',topic:'cutover',body:'실패 후 복귀 사본 저장',idempotency_key:'after-failed-activation'});
});

test('new MCP connections and authenticated HTTP agree on source, target and return authority',async t=>{
 const f=await fixture(t);await prepareTransfer(f.db,f.a.pid,f.state);const active=activateTransfer(f.state);
 const query=async db=>{
  const client=new Client({name:'cutover-proof',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[runtime,'serve','--db',db,'--project',f.a.folder],stderr:'pipe'});transport.stderr.resume();await client.connect(transport);
  try{const result=await client.callTool({name:'memory_get_status',arguments:{project_id:f.a.pid,run_id:f.a.run}});assert.notEqual(result.isError,true);return JSON.parse(result.content[0].text);}finally{await client.close();}
 };
 const compare=async db=>{
  const mcp=await query(db),viewer=await startViewer({db});try{const token=new URLSearchParams(new URL(viewer.url).hash.slice(1)).get('token');assert.equal((await fetch(viewer.origin+'/api/projects')).status,401);
   const http=await fetch(viewer.origin+'/api/runs/'+f.a.run+'?project='+f.a.pid,{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());assert.deepEqual(http.run.write_authority,mcp.write_authority);return mcp;
  }finally{await viewer.close();}
 };
 assert.equal((await compare(f.db)).write_authority.status,'fenced');assert.equal((await compare(active.active_db)).write_authority.current_copy,'target');
 const returned=await recoverTransfer(f.state);assert.equal((await compare(returned.active_db)).write_authority.current_copy,'return');
});

test('fenced HTTP imports and acknowledgements explain the block without asking for a retry',async t=>{
 const f=await fixture(t);await f.a.call('memory_finish_task',{project_id:f.a.pid,run_id:f.a.run,outcome:'completed',summary:'합성 시험 종료',idempotency_key:'finish'});
 const updated=(await f.status(f.a.app)).run.updated_at,viewer=await startViewer({db:f.db});t.after(()=>viewer.close());
 const headers={Authorization:'Bearer '+new URLSearchParams(new URL(viewer.url).hash.slice(1)).get('token'),Origin:viewer.origin,'Content-Type':'application/json'};
 const post=async(path,input)=>{const response=await fetch(viewer.origin+path,{method:'POST',headers,body:JSON.stringify(input)});return {status:response.status,data:await response.json()};};
 const input={project_id:f.a.pid,target_run_id:f.a.run,component_key:'web',path:'docs/test-selected.md',text:'# 합성 시험 문서'};
 const preview=await post('/api/documents/preview',input);assert.equal(preview.status,200);
 await prepareTransfer(f.db,f.a.pid,f.state);
 for(const [path,body] of [['/api/documents/import',{...input,preview_token:preview.data.preview_token}],['/api/runs/acknowledge',{project_id:f.a.pid,run_id:f.a.run,expected_updated_at:updated}]]) {
  const r=await post(path,body);assert.equal(r.status,409);assert.equal(r.data.code,'project_write_blocked');assert.match(r.data.error,/재시도하지 말고/);
 }
});
