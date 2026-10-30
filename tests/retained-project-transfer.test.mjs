import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync,readdirSync,cpSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {exportProject,importProject} from '../dist/adapters/storage/transfer/project.js';
import {prepareTransfer,activateTransfer,recoverTransfer} from '../dist/adapters/storage/transfer/cutover.js';
import {backupDatabase,restoreDatabase} from '../dist/adapters/storage/transfer/snapshot.js';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
import {startViewer} from '../dist/transport/viewer/server.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {retainedFixture,fileHashes,capacity,inspectEvents,selectedRows,assertHistory,blocked,digest} from './support/retained-project-fixture.mjs';

const runtime=new URL('../dist/runtime/local/main.js',import.meta.url).pathname;
const manifest=dir=>JSON.parse(readFileSync(join(dir,'manifest.json')));
const readRows=(dir,name)=>readFileSync(join(dir,name),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
function reseal(dir,name,rows){const path=join(dir,name);writeFileSync(path,rows.map(x=>JSON.stringify(x)+'\n').join(''));const m=manifest(dir),key=name==='events.ndjson'?'events':'main';m.files[key]={sha256:digest(path),bytes:statSync(path).size};writeFileSync(join(dir,'manifest.json'),JSON.stringify(m));}
const omitCapacity=({event_retention,...rest})=>rest;

test('v4 selected history above 10000 round-trips without global metadata or foreign project data',async t=>{
 const f=await retainedFixture(t),source=(await f.status()).task_recording,before=fileHashes(f.db),rows=selectedRows(f.db,f.a.binding.key);
 assert.ok(rows.length>10000);const bundle=join(f.root,'bundle');exportProject(f.db,f.a.p,bundle);
 const m=manifest(bundle);assert.equal(m.version,4);assert.equal(m.event_retention,'retained_windows_v1');
 const content=readFileSync(join(bundle,'events.ndjson'),'utf8');assert.ok(!content.includes(f.b.binding.key));assert.ok(!content.includes('event_windows'));assert.ok(!content.includes('capture_from_seq'));
 const result=await importProject(bundle,join(f.root,'import'));assert.equal(result.status,'completed');
 assert.deepEqual(selectedRows(result.db,f.a.binding.key),rows);assertHistory(await f.status(result.db),f);
 const h=(await f.status(result.db)).task_recording.imported_history;
 assert.equal(h.interruption.saved_during_event.source_seq,source.interruption.saved_during_event.seq);assert.equal(h.interruption.received_at,source.interruption.received_at);
 assert.equal(capacity(result.db).schema_version,3);assert.equal(capacity(result.db).total_events,rows.length);assert.equal(capacity(result.db).windows,2);
 const view=new SqliteViewer(result.db);try{assert.equal(view.projects().items.length,1);assert.equal(view.detail(f.a.p,f.a.run).run.task_recording.imported_history.interruption.saved_during_event.record_id,f.point);}finally{view.close();}
 const bundle2=join(f.root,'bundle2');exportProject(result.db,f.a.p,bundle2);const again=await importProject(bundle2,join(f.root,'again'));assertHistory(await f.status(again.db),f);
 const origins=path=>inspectEvents(path,d=>d.prepare('SELECT * FROM event_imports ORDER BY kind,id').all());assert.deepEqual(origins(again.db),origins(result.db));
 assert.deepEqual(fileHashes(f.db),before);
});

test('merge into retained base appends windows while preserving its epoch, native links and original files',async t=>{
 const f=await retainedFixture(t),base=await retainedFixture(t,{large:false}),baseBefore=fileHashes(base.db),sourceBefore=fileHashes(f.db);
 const settings=inspectEvents(base.db,d=>d.prepare('SELECT * FROM event_retention').all()),windows=inspectEvents(base.db,d=>d.prepare('SELECT * FROM event_windows ORDER BY id').all()),old=(await base.status()).task_recording;
 const bundle=join(f.root,'bundle');exportProject(f.db,f.a.p,bundle);const copy=await importProject(bundle,join(f.root,'merged'),base.db);
 assert.equal(copy.base_bindings_renewal_required,false);
 assert.deepEqual(inspectEvents(copy.db,d=>d.prepare('SELECT * FROM event_retention').all()),settings);
 assert.deepEqual(inspectEvents(copy.db,d=>d.prepare('SELECT * FROM event_windows ORDER BY id').all()).slice(0,windows.length),windows);
 assert.deepEqual(omitCapacity((await base.status(copy.db)).task_recording),omitCapacity(old));assertHistory(await f.status(copy.db),f);
 assert.equal(inspectEvents(copy.db,d=>d.prepare('SELECT count(*) n FROM events WHERE project_key=?').get(f.b.binding.key).n),0);
 assert.deepEqual(fileHashes(base.db),baseBefore);assert.deepEqual(fileHashes(f.db),sourceBefore);
});

test('retained import upgrades only a new legacy-base copy and reports native-binding renewal',async t=>{
 const f=await retainedFixture(t,{large:false}),base=await retainedFixture(t,{large:false,retained:false}),before=fileHashes(base.db),old=(await base.status()).task_recording;
 const bundle=join(f.root,'bundle');exportProject(f.db,f.a.p,bundle);const copy=await importProject(bundle,join(f.root,'merged'),base.db);
 assert.equal(copy.base_bindings_renewal_required,true);assert.equal(capacity(copy.db).schema_version,3);
 const state=(await base.status(copy.db)).task_recording;assert.equal(state.linkage,'historical_retained');assert.deepEqual(state.interruption,old.interruption);
 assertHistory(await f.status(copy.db),f);assert.equal(capacity(base.db).schema_version,1);assert.deepEqual(fileHashes(base.db),before);
});

test('legacy history merges into retained base without downgrading its policy',async t=>{
 const f=await retainedFixture(t,{large:false,retained:false}),base=await retainedFixture(t,{large:false}),before=fileHashes(base.db);
 const bundle=join(f.root,'legacy');exportProject(f.db,f.a.p,bundle);assert.equal(manifest(bundle).version,3);
 const copy=await importProject(bundle,join(f.root,'merged'),base.db);assert.equal(capacity(copy.db).schema_version,3);assertHistory(await f.status(copy.db),f);assert.deepEqual(fileHashes(base.db),before);
});

test('missing capability, forged versions and unsorted retained sequence are refused before creating output',async t=>{
 const f=await retainedFixture(t,{large:false}),bundle=join(f.root,'bundle');exportProject(f.db,f.a.p,bundle);
 for(const kind of ['marker','version','order','duplicate-seq']){
  const bad=join(f.root,'bad-'+kind);cpSync(bundle,bad,{recursive:true,errorOnExist:true,force:false});
  if(kind==='marker'||kind==='version'){const m=manifest(bad);if(kind==='marker'){const {event_retention,...rest}=m;writeFileSync(join(bad,'manifest.json'),JSON.stringify(rest));}else writeFileSync(join(bad,'manifest.json'),JSON.stringify({...m,version:3}));}
  else{const rows=readRows(bad,'events.ndjson'),indices=rows.map((x,i)=>x.table==='events'?i:-1).filter(i=>i>=0);if(kind==='order')[rows[indices[0]],rows[indices[1]]]=[rows[indices[1]],rows[indices[0]]];else rows[indices[1]].row.seq=rows[indices[0]].row.seq;reseal(bad,'events.ndjson',rows);}
  const output=join(f.root,'invalid-'+kind);await assert.rejects(importProject(bad,output));assert.equal(existsSync(output),false);
 }
});

test('imported anchors remain history at the original root and only fresh observations capture a new saved point',async t=>{
 const f=await retainedFixture(t,{large:false}),bundle=join(f.root,'bundle');exportProject(f.db,f.a.p,bundle);const copy=await importProject(bundle,join(f.root,'copy')),app=f.open(copy.db,f.a);
 await assert.rejects(f.a.link(f.a.anchor,app),e=>e.code==='scope_mismatch');const original=(await f.status(copy.db)).task_recording.imported_history.interruption;
 f.a.event('Interrupt',copy.db);assert.deepEqual((await f.status(copy.db)).task_recording.imported_history.interruption,original);
 await f.a.link(f.a.event('SessionStart',copy.db,'new-copy-session'),app);
 const point=(await app.dispatcher.call('memory_checkpoint',{project_id:f.a.p,run_id:f.a.run,kind:'note',topic:'retained-transfer',body:'새 위치에서 확인한 저장',idempotency_key:'fresh-point'})).record_id;
 const interruption=f.a.event('Interrupt',copy.db,'new-copy-session'),s=(await f.status(copy.db)).task_recording;
 assert.equal(s.interruption.observation_id,interruption);assert.equal(s.interruption.saved_during_event.record_id,point);assert.deepEqual(s.imported_history.interruption,original);
});

test('retained cutover fences old writers and returns target writes with the last interruption intact',async t=>{
 const f=await retainedFixture(t),rows=selectedRows(f.db,f.a.binding.key),old=new DatabaseSync(f.db),events=new DatabaseSync(f.db+'.events.sqlite');t.after(()=>{old.close();events.close();});
 const statement=old.prepare('UPDATE records SET body=body WHERE id=?'),eventStatement=events.prepare('UPDATE events SET event=event WHERE id=?');
 assert.equal((await prepareTransfer(f.db,f.a.p,f.state)).status,'prepared');assert.throws(()=>statement.run(f.point),blocked);assert.throws(()=>eventStatement.run(f.interrupt),blocked);await assert.rejects(f.a.note('blocked'),blocked);
 await f.b.note('foreign-still-writable');f.b.event();assert.deepEqual(selectedRows(f.db,f.a.binding.key),rows);
 const active=activateTransfer(f.state),app=f.open(active.active_db,f.a);assert.equal(capacity(active.active_db).schema_version,3);assertHistory(await f.status(active.active_db),f);
 await f.a.link(f.a.event('SessionStart',active.active_db,'target-session'),app);
 const point=(await app.dispatcher.call('memory_checkpoint',{project_id:f.a.p,run_id:f.a.run,topic:'retained-transfer',kind:'change',body:'대상 최신 원문',idempotency_key:'target-point'})).record_id;
 const interruption=f.a.event('Interrupt',active.active_db,'target-session');
 const returned=await recoverTransfer(f.state);assert.equal(returned.status,'returned');assert.equal(capacity(returned.active_db).schema_version,3);
 const s=(await f.status(returned.active_db));assert.equal(s.write_authority.write_allowed,true);assert.equal(s.task_recording.imported_history.interruption.observation_id,interruption);assert.equal(s.task_recording.imported_history.interruption.saved_during_event.record_id,point);
 assert.equal((await f.status(f.db)).write_authority.write_allowed,false);assert.equal((await f.status(active.active_db)).write_authority.write_allowed,false);assert.deepEqual(await recoverTransfer(f.state),returned);
 const fresh=f.open(returned.active_db,f.a);assert.equal((await fresh.dispatcher.call('memory_get_evidence',{project_id:f.a.p,record_id:point})).record.body,'대상 최신 원문');
});

test('aborting before activation reopens the original retained source without replacing its windows',async t=>{
 const f=await retainedFixture(t,{large:false}),windows=inspectEvents(f.db,d=>d.prepare('SELECT * FROM event_windows').all());
 await prepareTransfer(f.db,f.a.p,f.state);const result=await recoverTransfer(f.state);assert.equal(result.status,'aborted');assert.equal(result.active_db,f.db);
 assert.deepEqual(inspectEvents(f.db,d=>d.prepare('SELECT * FROM event_windows').all()),windows);await f.a.note('source-resumed');
 assert.equal((await f.status(join(f.state,'target','memory.sqlite'))).write_authority.write_allowed,false);
});

for(const fault of ['rollback','kill','authority-budget'])test(`pre-activation ${fault} preserves original history and quarantines partial target before reopening source`,async t=>{
 const f=await retainedFixture(t,{large:false}),rows=selectedRows(f.db,f.a.binding.key),windows=inspectEvents(f.db,d=>d.prepare('SELECT * FROM event_windows').all());
 const script=join(f.root,'failed-import.mjs');writeFileSync(script,`import {DatabaseSync} from 'node:sqlite';
 const prepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql,...args){const statement=prepare.call(this,sql,...args);
 const file=prepare.call(this,'PRAGMA database_list').get().file;
 if(file===${JSON.stringify(join(f.state,'target','memory.sqlite.events.sqlite'))}){
  if(${JSON.stringify(fault)}==='authority-budget'&&sql==='PRAGMA page_count'&&prepare.call(this,"SELECT 1 FROM sqlite_schema WHERE name='project_authority'").get())return{get:()=>({page_count:1000000})};
  if(${JSON.stringify(fault)}!=='authority-budget'&&/^INSERT INTO events\\b/.test(sql))return{run(...params){const r=statement.run(...params);if(${JSON.stringify(fault)}==='kill')process.kill(process.pid,'SIGKILL');throw new Error('injected-import-failure');}};
 }return statement;};
 const {prepareTransfer}=await import(${JSON.stringify(new URL('../dist/adapters/storage/transfer/cutover.js',import.meta.url).href)});await prepareTransfer(${JSON.stringify(f.db)},${JSON.stringify(f.a.p)},${JSON.stringify(f.state)});`);
 const child=spawnSync(process.execPath,[script],{encoding:'utf8'});
 if(fault==='kill')assert.equal(child.signal,'SIGKILL',child.stderr);else{assert.equal(child.status,1,child.stderr);assert.match(child.stderr,fault==='rollback'?/injected-import-failure/:/body budget exceeded/);}
 assert.equal((await f.status()).write_authority.write_allowed,false);
 const target=join(f.state,'target','memory.sqlite'),partial=new DatabaseSync(target,{readOnly:true});try{assert.equal(partial.prepare('SELECT count(*) n FROM projects').get().n,0);}finally{partial.close();}
 const result=await recoverTransfer(f.state);assert.equal(result.status,'aborted');assert.equal(result.active_db,f.db);
 assert.deepEqual(selectedRows(f.db,f.a.binding.key),rows);assert.deepEqual(inspectEvents(f.db,d=>d.prepare('SELECT * FROM event_windows').all()),windows);
 assert.equal((await f.status()).task_recording.interruption.saved_during_event.record_id,f.point);
 const fenced=new DatabaseSync(target,{readOnly:true});try{assert.equal(fenced.prepare('SELECT state FROM project_authority WHERE project_id=?').get(f.a.p).state,'blocked');}finally{fenced.close();}
 assert.throws(()=>f.a.event('Interrupt',target),blocked);await f.a.note('resumed-after-'+fault);assert.deepEqual(await recoverTransfer(f.state),result);
 assert.ok(existsSync(target));assert.equal(existsSync(join(f.state,'target','import.json')),false);
});

test('source authority allocation over budget rolls back before any original writer is fenced',async t=>{
 const f=await retainedFixture(t,{large:false}),before=fileHashes(f.db),script=join(f.root,'source-budget.mjs');
 writeFileSync(script,`import {DatabaseSync} from 'node:sqlite';const prepare=DatabaseSync.prototype.prepare;DatabaseSync.prototype.prepare=function(sql,...args){
 const statement=prepare.call(this,sql,...args);if(sql==='PRAGMA page_count'&&prepare.call(this,'PRAGMA database_list').get().file===${JSON.stringify(f.db+'.events.sqlite')}&&prepare.call(this,"SELECT 1 FROM sqlite_schema WHERE name='project_authority'").get())return{get:()=>({page_count:1000000})};return statement;};
 const {prepareTransfer}=await import(${JSON.stringify(new URL('../dist/adapters/storage/transfer/cutover.js',import.meta.url).href)});await prepareTransfer(${JSON.stringify(f.db)},${JSON.stringify(f.a.p)},${JSON.stringify(f.state)});`);
 const failed=spawnSync(process.execPath,[script],{encoding:'utf8'});assert.equal(failed.status,1,failed.stderr);assert.match(failed.stderr,/body budget exceeded/);
 assert.deepEqual(fileHashes(f.db),before);assert.equal((await f.status()).write_authority.write_allowed,true);
 await f.a.note('still-writable-after-budget-failure');
 const result=await recoverTransfer(f.state);assert.equal(result.status,'aborted');assert.equal(result.active_db,f.db);
 assert.deepEqual(await recoverTransfer(f.state),result);assert.throws(()=>f.a.event('Interrupt',join(f.state,'target','memory.sqlite')),blocked);
});

test('a concurrent event lock delays authority allocation while main remains writable and its new record transfers',async t=>{
 const f=await retainedFixture(t,{large:false}),lock=new DatabaseSync(f.db+'.events.sqlite'),script=join(f.root,'concurrent-prepare.mjs');
 writeFileSync(script,`import {DatabaseSync} from 'node:sqlite';const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){if(sql.includes('BEGIN IMMEDIATE')&&this.prepare('PRAGMA database_list').get().file===${JSON.stringify(f.db+'.events.sqlite')})process.send('waiting');return exec.call(this,sql);};
 const {prepareTransfer}=await import(${JSON.stringify(new URL('../dist/adapters/storage/transfer/cutover.js',import.meta.url).href)});await prepareTransfer(${JSON.stringify(f.db)},${JSON.stringify(f.a.p)},${JSON.stringify(f.state)});process.disconnect();`);
 lock.exec('BEGIN IMMEDIATE');const child=spawn(process.execPath,[script],{stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr.on('data',b=>errors+=b);
 const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
 let record;
 try{
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('authority allocation did not reach lock')),5000);child.once('message',()=>{clearTimeout(timer);resolve();});child.once('exit',()=>{clearTimeout(timer);reject(new Error(errors));});});
  assert.equal((await f.status()).write_authority.write_allowed,true);record=await f.a.note('during-event-lock');
 }finally{lock.exec('ROLLBACK');lock.close();}
 const result=await exited;assert.equal(result.code,0,errors);assert.equal(result.signal,null);
 const target=activateTransfer(f.state).active_db,app=f.open(target,f.a);
 assert.equal((await app.dispatcher.call('memory_get_evidence',{project_id:f.a.p,record_id:record})).record.id,record);
 assert.equal((await f.status()).write_authority.write_allowed,false);
});

for(const fault of ['absent','unowned','zero-byte'])test(`preparing recovery handles ${fault} target without inferring permission from missing metadata`,async t=>{
 const f=await retainedFixture(t,{large:false}),script=join(f.root,'before-import.mjs');
 writeFileSync(script,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const mkdir=fs.mkdirSync;fs.mkdirSync=function(path,...args){const r=mkdir.call(this,path,...args);if(String(path)===${JSON.stringify(join(f.state,'target'))})throw new Error('before-target-init');return r;};syncBuiltinESMExports();const {prepareTransfer}=await import(${JSON.stringify(new URL('../dist/adapters/storage/transfer/cutover.js',import.meta.url).href)});await prepareTransfer(${JSON.stringify(f.db)},${JSON.stringify(f.a.p)},${JSON.stringify(f.state)});`);
 const failed=spawnSync(process.execPath,[script],{encoding:'utf8'});assert.equal(failed.status,1,failed.stderr);assert.match(failed.stderr,/before-target-init/);
 const target=join(f.state,'target','memory.sqlite');assert.equal(existsSync(target),false);
 if(fault==='unowned'){
  const other=await retainedFixture(t,{large:false}),snapshot=await backupDatabase(other.db,join(other.root,'unowned-snapshot'));
  cpSync(snapshot.db,target,{force:false,errorOnExist:true});
  const check=new DatabaseSync(target,{readOnly:true});try{assert.equal(check.prepare('SELECT count(*) n FROM projects').get().n,2);}finally{check.close();}
 }
 if(fault==='zero-byte')writeFileSync(target,'',{flag:'wx'});
 if(fault==='absent'){
  assert.equal((await recoverTransfer(f.state)).status,'aborted');await f.a.note('resume-before-import');
  assert.throws(()=>f.a.event('Interrupt',target),blocked);
 }else{
  const before=readFileSync(target);await assert.rejects(recoverTransfer(f.state),e=>['incomplete_transfer','unsupported_database'].includes(e.code));
  assert.deepEqual(readFileSync(target),before);assert.equal((await f.status()).write_authority.write_allowed,false);
 }
});

for(const field of ['state','transfer_id'])test(`preparing recovery refuses a ${field} authority mismatch without reopening the source`,async t=>{
 const f=await retainedFixture(t,{large:false});await prepareTransfer(f.db,f.a.p,f.state);
 const control=new DatabaseSync(join(f.state,'operation.sqlite'));control.exec("UPDATE operation SET phase='preparing'");control.close();
 const target=join(f.state,'target','memory.sqlite'),d=new DatabaseSync(target);
 d.prepare(`UPDATE project_authority SET ${field}=?`).run(field==='state'?'writable':'00000000-0000-4000-8000-000000000001');d.close();
 await assert.rejects(recoverTransfer(f.state),e=>e.code==='authority_conflict');assert.equal((await f.status()).write_authority.write_allowed,false);
});

for(const stage of ['export','copy','selection'])test(`retained recovery survives child-process termination at ${stage} and preserves partial attempts`,async t=>{
 const f=await retainedFixture(t,{large:false});await prepareTransfer(f.db,f.a.p,f.state);const target=activateTransfer(f.state).active_db;
 const script=join(f.root,'crash.mjs');writeFileSync(script,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const mkdir=fs.mkdirSync,write=fs.writeFileSync;
 fs.mkdirSync=function(path,...args){const r=mkdir.call(this,path,...args);if(String(path).includes('return-attempt-')&&String(path).endsWith('/${stage}')){write.call(fs,String(path)+'/partial','keep');process.kill(process.pid,'SIGKILL');}return r;};
 fs.writeFileSync=function(path,...args){const r=write.call(this,path,...args);if(${JSON.stringify(stage)}==='selection'&&String(path).endsWith('/return-selection.json'))process.kill(process.pid,'SIGKILL');return r;};syncBuiltinESMExports();const {recoverTransfer}=await import(${JSON.stringify(new URL('../dist/adapters/storage/transfer/cutover.js',import.meta.url).href)});await recoverTransfer(${JSON.stringify(f.state)});`);
 const killed=spawnSync(process.execPath,[script],{encoding:'utf8'});assert.equal(killed.signal,'SIGKILL',killed.stderr);
 const attempts=readdirSync(f.state).filter(n=>n.startsWith('return-attempt-'));assert.equal(attempts.length,1);
 assert.equal((await f.status(f.db)).write_authority.write_allowed,false);assert.equal((await f.status(target)).write_authority.write_allowed,false);
 const selected=existsSync(join(f.state,'return-selection.json'))?JSON.parse(readFileSync(join(f.state,'return-selection.json'))).slot:null;
 const result=await recoverTransfer(f.state);assert.equal(result.status,'returned');assertHistory(await f.status(result.active_db),f);assert.equal(capacity(result.active_db).schema_version,3);
 assert.ok(existsSync(join(f.state,attempts[0])));if(selected)assert.ok(result.active_db.includes(selected));else assert.equal(readFileSync(join(f.state,attempts[0],stage,'partial'),'utf8'),'keep');
});

test('current retained backup restores only the selected project and rejects capability downgrade',async t=>{
 const f=await retainedFixture(t,{large:false}),seed=join(f.root,'seed');exportProject(f.db,f.a.p,seed);
 // Normalize imported saved-point key order before constructing two bundles
 // whose row bytes are identical and whose only difference is retention policy.
 const normalized=await importProject(seed,join(f.root,'normalized'));await prepareTransfer(normalized.db,f.a.p,f.state);const target=activateTransfer(f.state).active_db;
 const latest=join(f.root,'latest-export');exportProject(target,f.a.p,latest);
 const legacy=join(f.root,'legacy-export');cpSync(latest,legacy,{recursive:true,errorOnExist:true,force:false});const {event_retention,...old}=manifest(legacy);writeFileSync(join(legacy,'manifest.json'),JSON.stringify({...old,version:3}));
 const authority=(()=>{const d=new DatabaseSync(target,{readOnly:true});try{return {...d.prepare('SELECT * FROM project_authority WHERE project_id=?').get(f.a.p),state:'blocked'};}finally{d.close();}})();
 const legacyCopy=await importProject(legacy,join(f.root,'legacy-copy'),undefined,authority);const proof=join(f.root,'legacy-proof');exportProject(legacyCopy.db,f.a.p,proof);
 assert.equal(readFileSync(join(proof,'events.ndjson'),'utf8'),readFileSync(join(latest,'events.ndjson'),'utf8'));
 const bad=await backupDatabase(legacyCopy.db,join(f.root,'legacy-backup'));await assert.rejects(recoverTransfer(f.state,bad.directory),e=>e.code==='stale_backup');
 const backup=await backupDatabase(target,join(f.root,'current-backup')),before=fileHashes(backup.db),result=await recoverTransfer(f.state,backup.directory);
 assert.equal(result.status,'returned');assertHistory(await f.status(result.active_db),f);assert.equal(capacity(result.active_db).schema_version,3);assert.deepEqual(fileHashes(backup.db),before);
});

test('fresh stdio MCP and authenticated viewer agree on retained history and the interruption saved point',async t=>{
 const f=await retainedFixture(t,{large:false}),bundle=join(f.root,'bundle');exportProject(f.db,f.a.p,bundle);const copy=await importProject(bundle,join(f.root,'copy'));
 const backup=await backupDatabase(copy.db,join(f.root,'backup')),restored=await restoreDatabase(backup.directory,join(f.root,'restore'));
 const client=new Client({name:'retained-project-read',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[runtime,'serve','--db',restored.db,'--project',f.a.root],stderr:'pipe'});transport.stderr.resume();t.after(()=>client.close());await client.connect(transport);
 const tools=await client.listTools();assert.ok(tools.tools.some(x=>x.name==='memory_get_status'));
 const response=await client.callTool({name:'memory_get_status',arguments:{project_id:f.a.p,run_id:f.a.run}});assert.notEqual(response.isError,true);const status=JSON.parse(response.content[0].text);assertHistory(status,f);assert.equal(status.task_recording.event_retention.schema_version,3);
 const view=new SqliteViewer(restored.db);try{assert.deepEqual(view.detail(f.a.p,f.a.run).run.task_recording,status.task_recording);}finally{view.close();}
 const viewer=await startViewer({db:restored.db});try{
  assert.equal((await fetch(viewer.origin+'/api/projects')).status,401);
  const token=new URLSearchParams(new URL(viewer.url).hash.slice(1)).get('token');
  const response=await fetch(viewer.origin+'/api/runs/'+f.a.run+'?project='+f.a.p,{headers:{Authorization:'Bearer '+token}});assert.equal(response.status,200);
  assert.deepEqual((await response.json()).run.task_recording,status.task_recording);
 }finally{await viewer.close();}
});

test('retained re-export has bounded room for origin rows beyond the legacy 100000-row limit',async t=>{
 const f=await retainedFixture(t,{large:false});
 while(capacity(f.db).windows<8){const c=capacity(f.db);f.seed(c.window_limit-c.active_events);f.a.event();}
 const current=capacity(f.db);f.seed(current.window_limit-current.active_events);
 const bundle=join(f.root,'large-bundle');exportProject(f.db,f.a.p,bundle);
 const copy=await importProject(bundle,join(f.root,'large-copy')),again=join(f.root,'large-reexport');exportProject(copy.db,f.a.p,again);
 const m=manifest(again);assert.ok(m.rows+m.event_rows>100000);assert.ok(m.rows+m.event_rows<=260000);assert.equal(m.version,4);
 assert.equal(selectedRows(copy.db,f.a.binding.key).length,selectedRows(f.db,f.a.binding.key).length);
 const incoming=await retainedFixture(t,{large:false}),input=join(incoming.root,'bundle');exportProject(incoming.db,incoming.a.p,input);
 const before=fileHashes(f.db),out=join(f.root,'exhausted-merge');await assert.rejects(importProject(input,out,f.db),e=>e.code==='transfer_limit');
 assert.deepEqual(fileHashes(f.db),before);assert.equal(existsSync(join(out,'import.json')),false);
});
