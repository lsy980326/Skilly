import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,mkdirSync,existsSync,readdirSync,statSync,symlinkSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openLocal} from '../dist/runtime/local/app.js';
import {recordLifecycle} from '../dist/adapters/storage/sqlite/lifecycle.js';
import {previewProjectTransfer} from '../dist/runtime/local/project-transfer.js';
import {openTransferD1} from '../dist/runtime/local/transfer-d1.js';
import {SqliteD1ProjectTransfer} from '../dist/adapters/storage/portable/transfer.js';
import {withD1Generation} from '../dist/adapters/storage/d1/authority.js';
import {D1AtomicCommitStore} from '../dist/adapters/storage/d1/atomic-store.js';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';

const hash=v=>createHash('sha256').update(v).digest('hex');
function cli(f,command,extra=[],ok=true){const r=spawnSync(process.execPath,['dist/runtime/local/main.js','project-transfer',command,'--db',f.db,'--project-id',f.pid,'--d1',f.d1,'--state',f.state,...extra],{encoding:'utf8',timeout:30000});assert.equal(r.status,ok?0:1,r.stderr||r.stdout);return JSON.parse((ok?r.stdout:r.stderr.trim().split('\n').at(-1)));}
async function fixture(t){const root=realpathSync(mkdtempSync(join(tmpdir(),'skilly-transfer-cli-'))),folder=join(root,'project');mkdirSync(folder);const db=join(folder,'memory.sqlite'),binding={version:1,key:'cli-test',name:'명령 시험',repository:'web',environment:'test'};writeFileSync(join(folder,'skilly.project.json'),JSON.stringify(binding));const app=openLocal(db,binding,folder),call=(n,i)=>app.dispatcher.call(n,i);t.after(()=>app.close());const pid=(await call('memory_resolve_project',{})).project.id,rid=(await call('memory_begin_task',{project_id:pid,goal:'테스트 원문',mode:'change',idempotency_key:'start'})).run.id;const point=(await call('memory_checkpoint',{project_id:pid,run_id:rid,kind:'change',topic:'cli',body:'비공개 시험 원문, preview에는 나오지 않음',idempotency_key:'point'})).record_id;const anchor=recordLifecycle(db,folder,{cwd:folder,session_id:'synthetic-cli',hook_event_name:'SessionStart'}).observation_id;await call('memory_link_task_events',{project_id:pid,run_id:rid,observation_id:anchor});const interruption=recordLifecycle(db,folder,{cwd:folder,session_id:'synthetic-cli',hook_event_name:'Interrupt'}).observation_id;return {root,folder,db,binding,app,call,pid,rid,point,interruption,d1:join(root,'local-d1'),state:join(root,'operation')};}
async function note(db,f,body){const s=db.withSession('first-primary'),p=(await s.prepare('SELECT * FROM projects WHERE id=?').bind(f.pid).all()).results[0],id=randomUUID(),at=new Date().toISOString();await new D1AtomicCommitStore(db,f.pid).commit({project:{id:f.pid,key:f.binding.key,name:f.binding.name,revision:p.revision+1,created_at:p.created_at},expected_revision:p.revision,record:{id,project_id:f.pid,run_id:f.rid,topic:'cli',kind:'change',body,repository:'web',environment:'test',observed_at:at,recorded_at:at,source_fingerprint:null,supersedes:null,superseded_by:null,report_origin:'contemporaneous'},receipt:{scope:f.pid,key:id,hash:hash(id),result:{status:'persisted',record_id:id}}});return id;}
function files(root){return Object.fromEntries(readdirSync(root).filter(n=>!n.endsWith('-shm')).map(n=>[n,{hash:hash(readFileSync(join(root,n))),mode:statSync(join(root,n)).mode}]));}
function retainedIntent(f,p){const i={version:1,id:randomUUID(),source:f.db,project_id:f.pid,d1:f.d1,state:f.state,source_identity:p.source_identity,snapshot_hash:p.snapshot_hash,schema_hash:p.schema_hash,expected_hash:p.expected_hash};mkdirSync(f.state,{mode:0o700});writeFileSync(join(f.state,'intent.json'),JSON.stringify(i));const lock=new DatabaseSync(join(f.state,'command.sqlite'));lock.exec('CREATE TABLE command_lock(id INTEGER PRIMARY KEY) STRICT;');lock.close();return i;}

test('preview is read-only, bounded and stale approvals/path collisions fail before fencing',async t=>{
 const f=await fixture(t),before=files(f.folder),p=cli(f,'preview');assert.equal(p.files_changed,false);assert.ok(p.rows>0);assert.equal(JSON.stringify(p).includes('비공개 시험 원문'),false);assert.deepEqual(files(f.folder),before);assert.equal(existsSync(f.state),false);assert.equal(existsSync(f.d1),false);
 const collision={...f,state:join(f.d1,'nested')};cli(collision,'preview',[],false);assert.equal(existsSync(f.d1),false);
 const linked=join(f.root,'linked');symlinkSync(f.folder,linked);cli({...f,db:join(linked,'memory.sqlite')},'preview',[],false);
 cli(f,'execute',['--expect','0'.repeat(64)],false);assert.equal(existsSync(f.state),false);
 await f.call('memory_checkpoint',{project_id:f.pid,run_id:f.rid,kind:'note',topic:'cli',body:'미리보기 후 변경',idempotency_key:'changed'});
 cli(f,'execute',['--expect',p.expected_hash],false);assert.equal(existsSync(f.state),false);assert.equal(existsSync(f.d1),false);
 const raw=new DatabaseSync(f.db);try{assert.equal(raw.prepare("SELECT 1 FROM sqlite_master WHERE name='project_authority'").get(),undefined);}finally{raw.close();}
 cli(f,'status',[],false);assert.equal(existsSync(f.state),false);
});

test('separate CLI processes activate, inspect, resume and return; old writers stay fenced',{timeout:120000},async t=>{
 const f=await fixture(t),old=new DatabaseSync(f.db),stmt=old.prepare('UPDATE runs SET goal=? WHERE id=?');t.after(()=>old.close());const p=cli(f,'preview'),a=cli(f,'execute',['--expect',p.expected_hash]);assert.equal(a.phase,'active');assert.equal(a.source.write_allowed,false);assert.equal(a.target.write_allowed,true);assert.equal(a.latest_saved_record.id,f.point);assert.throws(()=>stmt.run('old',f.rid),/project_write_blocked/);
 assert.equal(cli(f,'resume').transfer_id,a.transfer_id,'lost output must reuse the same operation');assert.equal(cli(f,'status').latest_saved_record.id,f.point);
 const intent=JSON.parse(readFileSync(join(f.state,'intent.json'),'utf8')),runtime=await openTransferD1(f.d1,intent.id,intent.schema_hash,false);let newRecord;
 try{newRecord=await note(withD1Generation(runtime.db,a.target.generation),f,'D1의 새 원문');}finally{await runtime.close();}
 cli({...f,d1:join(f.root,'wrong-endpoint')},'status',[],false);assert.equal(existsSync(join(f.root,'wrong-endpoint')),false);
 const out=join(f.root,'returned');mkdirSync(out);mkdirSync(join(out,'copy-1'));writeFileSync(join(out,'copy-1/partial'),'합성 중단 출력');writeFileSync(join(f.state,'bridge/return.json'),JSON.stringify({directory:out}));
 const back=cli(f,'resume');assert.equal(back.phase,'returned');assert.match(back.active_sqlite_db,/copy-2/);assert.equal(readFileSync(join(out,'copy-1/partial'),'utf8'),'합성 중단 출력');assert.equal(back.target.write_allowed,false);assert.equal(back.latest_saved_record.id,newRecord);assert.equal(back.last_interruption.saved_during_event.record_id,f.point);
 const fresh=openLocal(back.active_sqlite_db,f.binding,f.folder);try{const status=await fresh.dispatcher.call('memory_get_status',{project_id:f.pid,run_id:f.rid});assert.equal(status.task_recording.imported_history.interruption.saved_during_event.record_id,f.point);await fresh.dispatcher.call('memory_checkpoint',{project_id:f.pid,run_id:f.rid,kind:'note',topic:'cli',body:'복귀 후 새 저장',idempotency_key:'returned'});}finally{await fresh.close();}
 const reader=new SqliteViewer(back.active_sqlite_db);try{assert.ok(JSON.stringify(reader.detail(f.pid,f.rid)).includes(newRecord));}finally{reader.close();}
 assert.equal(cli(f,'resume').active_sqlite_db,back.active_sqlite_db);assert.throws(()=>stmt.run('still old',f.rid),/project_write_blocked/);
 const stale=await openTransferD1(f.d1,intent.id,intent.schema_hash,false);try{await assert.rejects(note(withD1Generation(stale.db,a.target.generation),f,'old D1'),{code:'project_write_blocked'});}finally{await stale.close();}
 cli(f,'return',['--output',join(f.root,'other-return')],false);assert.equal(existsSync(join(f.root,'other-return')),false);
 const result=cli(f,'status');assert.equal(result.phase,'returned');const read=new DatabaseSync(result.active_sqlite_db,{readOnly:true});try{assert.equal(read.prepare("SELECT count(*) n FROM records WHERE body='복귀 후 새 저장'").get().n,1);}finally{read.close();}
 const ready=JSON.parse(readFileSync(join(f.d1,'endpoint-ready.json'),'utf8')),file=join(f.d1,ready.file);renameSync(file,file+'.retained');try{cli(f,'status',[],false);assert.equal(existsSync(file),false,'status must not let the emulator create a replacement database');}finally{renameSync(file+'.retained',file);}
});

test('fresh CLI resumes a retained import failure and explicit return works',{timeout:120000},async t=>{
 const f=await fixture(t),p=await previewProjectTransfer({db:f.db,projectId:f.pid,d1:f.d1,state:f.state});
 // Synthetic interruption at the import boundary, using the same durable command format.
 const i=retainedIntent(f,p);assert.equal(cli(f,'status').phase,'initializing');assert.equal(existsSync(f.d1),false);
 const runtime=await openTransferD1(f.d1,i.id,i.schema_hash,true),failing={withSession(c){const s=runtime.db.withSession(c);return {prepare:q=>s.prepare(q),async batch(){throw Error('synthetic import unavailable');}};}};
 try{await assert.rejects(new SqliteD1ProjectTransfer(f.db,failing,f.pid,join(f.state,'bridge')).prepare(p.snapshot_hash));}finally{await runtime.close();}
 const interrupted=cli(f,'status');assert.equal(interrupted.phase,'preparing');assert.equal(interrupted.source.write_allowed,false);
 const active=cli(f,'resume');assert.equal(active.phase,'active');assert.equal(active.latest_saved_record.id,f.point);
 const returned=cli(f,'return',['--output',join(f.root,'fresh-return')]);assert.equal(returned.phase,'returned');assert.equal(returned.latest_saved_record.id,f.point);assert.equal(cli(f,'status').active_sqlite_db,returned.active_sqlite_db);
});

test('initialization retry and a change racing the fence preserve new source records on recovery',{timeout:120000},async t=>{
 const f=await fixture(t),p=await previewProjectTransfer({db:f.db,projectId:f.pid,d1:f.d1,state:f.state}),i=retainedIntent(f,p);
 // Startup was interrupted after approval and command lock, before any D1/source mutation.
 assert.equal(cli(f,'status').phase,'initializing');assert.equal(existsSync(f.d1),false);
 const runtime=await openTransferD1(f.d1,i.id,i.schema_hash,true);let changed=false,added;
 const racing={withSession(c){const s=runtime.db.withSession(c);return {prepare(q){const wrap=stmt=>({bind(...v){return wrap(stmt.bind(...v));},async all(){const r=await stmt.all();if(!changed&&q==='SELECT id FROM d1_store_identity'){changed=true;added=(await f.call('memory_checkpoint',{project_id:f.pid,run_id:f.rid,kind:'note',topic:'race',body:'봉인 직전 새 원문',idempotency_key:'race'})).record_id;}return r;}});return wrap(s.prepare(q));},batch:statements=>s.batch(statements)};}};
 try{await assert.rejects(new SqliteD1ProjectTransfer(f.db,racing,f.pid,join(f.state,'bridge')).prepare(p.snapshot_hash),{code:'preview_changed'});}finally{await runtime.close();}
 const status=cli(f,'status');assert.equal(status.phase,'preparing');assert.equal(status.source.write_allowed,false);assert.equal(status.latest_saved_record.id,added);
 cli(f,'resume',[],false);const returned=cli(f,'return',['--output',join(f.root,'race-return')]);assert.equal(returned.latest_saved_record.id,added);assert.equal(returned.target.write_allowed,false);
 const startup=await fixture(t),preview=cli(startup,'preview');retainedIntent(startup,preview);assert.equal(cli(startup,'execute',['--expect',preview.expected_hash]).phase,'active');
});
