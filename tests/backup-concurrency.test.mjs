import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fork} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {openLocal} from '../dist/runtime/local/app.js';
import {recordLifecycle} from '../dist/adapters/storage/sqlite/lifecycle.js';
import {readDatabase} from '../dist/adapters/storage/transfer/database.js';
import {readEvents,validateEventPair} from '../dist/adapters/storage/transfer/events.js';
import {backupDatabase,restoreDatabase,openSnapshots,copySnapshot} from '../dist/adapters/storage/transfer/snapshot.js';
import {saveAttachment,attachmentOriginal} from '../dist/adapters/storage/sqlite/attachments.js';

async function fixture(t,{events=32,receipts=32,padding=0}={}) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'skilly-backup-concurrency-'))),path=join(root,'memory.sqlite');
 const binding={version:1,key:'backup-concurrency',name:'백업 테스트',repository:'main',environment:'test'};
 writeFileSync(join(root,'skilly.project.json'),JSON.stringify(binding));
 const app=openLocal(path,binding,root),call=(name,args)=>app.dispatcher.call(name,args);t.after(()=>app.close());
 const pid=(await call('memory_resolve_project',{})).project.id;
 const run=(await call('memory_begin_task',{project_id:pid,goal:'합성 백업 검사',mode:'diagnose',idempotency_key:'begin'})).run.id;
 const event=name=>recordLifecycle(path,root,{cwd:root,session_id:'synthetic-backup-test',hook_event_name:name}).observation_id;
 await call('memory_link_task_events',{project_id:pid,run_id:run,observation_id:event('SessionStart')});
 const input={project_id:pid,run_id:run,topic:'backup-test',kind:'note',body:'보존할 합성 원문',idempotency_key:'zz-note'};
 const record=(await call('memory_checkpoint',input)).record_id,anchor=event('Interrupt');
 const m=new DatabaseSync(path),e=new DatabaseSync(path+'.events.sqlite');
 try {
  m.exec('BEGIN');const put=m.prepare('INSERT INTO receipts VALUES(?,?,?,?)');
  for(let i=0;i<receipts;i++)put.run(pid,'a-padding-'+i,'0'.repeat(64),JSON.stringify({padding:'x'.repeat(padding),record_id:randomUUID()}));
  m.exec('COMMIT');e.exec('BEGIN');
  const add=e.prepare('INSERT INTO events SELECT NULL,?,project_key,repository,environment,root_hash,session_hash,turn_hash,event,source,tool_group,received_at FROM events WHERE id=?');
  const link=e.prepare('INSERT INTO event_task_links SELECT ?,link_id,saved_json FROM event_task_links WHERE event_id=?');
  for(let i=0;i<events;i++){const id=randomUUID();add.run(id,anchor);link.run(id,anchor);}e.exec('COMMIT');
 } finally {m.close();e.close();}
 return {root,path,pid,run,record,anchor,input,call,binding};
}
function pair(f,check){const m=readDatabase(f.path),e=readEvents(f.path+'.events.sqlite');try{return check(m,e);}finally{m.close();e.close();}}
function boundedScans(f){return pair(f,(m,e)=>{const prepare=m.prepare.bind(m);let scans=0;m.prepare=sql=>{const statement=prepare(sql);if(!/FROM receipts\b/i.test(sql))return statement;
 return new Proxy(statement,{get(target,key){const value=Reflect.get(target,key,target);return typeof value==='function'?(...args)=>{if(key==='get'||key==='iterate')scans++;return value.apply(target,args);}:value;}});};
 validateEventPair(m,e);assert.ok(scans<=2,'Expected at most two receipt scans per project, got '+scans);
});}
const hash=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
function message(child,predicate){return new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>{child.kill();cleanup();reject(new Error('Test worker deadline exceeded'));},15000);
 const receive=value=>{if(predicate(value)){cleanup();resolve(value);}};
 const exit=code=>{cleanup();reject(new Error('Test worker exited before response: '+code));};
 const cleanup=()=>{clearTimeout(timer);child.off('message',receive);child.off('exit',exit);};
 child.on('message',receive);child.on('exit',exit);
});}
function worker(t,args){const child=fork(new URL('./support/backup-concurrency-worker.mjs',import.meta.url),args,{execArgv:[],stdio:['ignore','ignore','pipe','ipc']});let errors='';child.stderr.on('data',data=>{errors+=data;});t.after(()=>{if(child.exitCode===null)child.kill();});child.on('error',()=>{});return {child,errors:()=>errors};}

test('event receipts are checked with bounded scope scans, including repeated saved points',async t=>{
 const f=await fixture(t);boundedScans(f);
});
test('receipt collection also checks many distinct records without per-reference scans',async t=>{
 const f=await fixture(t),m=new DatabaseSync(f.path),e=new DatabaseSync(f.path+'.events.sqlite');
 try{
  const original=m.prepare('SELECT * FROM records WHERE id=?').get(f.record),columns=Object.keys(original).filter(k=>k!=='seq');
  const insert=m.prepare('INSERT INTO records('+columns.join(',')+') VALUES('+columns.map(()=>'?').join(',')+')');
  m.exec('BEGIN');e.exec('BEGIN');let index=0;
  for(const row of e.prepare('SELECT * FROM event_task_links').all()){
   const id=randomUUID(),result=insert.run(...columns.map(k=>k==='id'?id:original[k])),saved=JSON.parse(row.saved_json);
   saved.record_id=id;saved.seq=Number(result.lastInsertRowid);
   e.prepare('UPDATE event_task_links SET saved_json=? WHERE event_id=?').run(JSON.stringify(saved),row.event_id);
   m.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(f.pid,'distinct-'+index++,'0'.repeat(64),JSON.stringify({record_id:id}));
  }m.exec('COMMIT');e.exec('COMMIT');boundedScans(f);
 }finally{m.close();e.close();}
});
test('receipt batch checks preserve record_ids, start, missing and foreign-scope semantics',async t=>{
 const f=await fixture(t),m=new DatabaseSync(f.path),e=new DatabaseSync(f.path+'.events.sqlite');
 try {
  m.prepare('UPDATE receipts SET result_json=? WHERE scope=? AND idempotency_key=?').run(JSON.stringify({record_ids:[f.record]}),f.pid,'zz-note');
  pair(f,validateEventPair);
  // SQLite json_each also supports scalar and object values in older receipts.
  for(const record_ids of [f.record,{first:f.record}]){m.prepare('UPDATE receipts SET result_json=? WHERE scope=? AND idempotency_key=?').run(JSON.stringify({record_ids}),f.pid,'zz-note');pair(f,validateEventPair);}
  m.prepare('UPDATE receipts SET result_json=? WHERE scope=? AND idempotency_key=?').run('{"record_id":9007199254740993,"run":{"id":9007199254740993},"record_ids":[9007199254740993,"'+f.record+'"]}',f.pid,'zz-note');pair(f,validateEventPair);
  m.prepare('UPDATE receipts SET scope=? WHERE scope=? AND idempotency_key=?').run(randomUUID(),f.pid,'zz-note');
  assert.throws(()=>pair(f,validateEventPair),error=>error.code==='invalid_event_link');
  e.exec("UPDATE event_task_links SET saved_json=json_remove(json_set(saved_json,'$.stage','start','$.record_id',NULL,'$.record_visible',json('false')),'$.seq','$.recorded_at')");
  pair(f,validateEventPair);
  m.prepare('UPDATE receipts SET scope=? WHERE scope=? AND idempotency_key=?').run(randomUUID(),f.pid,'begin');
  assert.throws(()=>pair(f,validateEventPair),error=>error.code==='invalid_event_link');
 }finally{m.close();e.close();}
});
test('a recovery reader reports an unretained write and releases it for an identical retry',async t=>{
 const f=await fixture(t),snapshots=openSnapshots(f.path,true),input={...f.input,body:'잠금 해제 뒤 같은 요청',idempotency_key:'blocked-then-retry'};
 try{await assert.rejects(f.call('memory_checkpoint',input),error=>error.code==='recovery_unavailable'&&error.recovery?.pending_retained!==true);}finally{snapshots.close();}
 const status=await f.call('memory_recovery_status',{project_id:f.pid,repository:'main',environment:'test'});assert.equal(status.requests.length,0);
 const main=new DatabaseSync(f.path,{readOnly:true}),journal=new DatabaseSync(f.path+'.recovery.sqlite',{readOnly:true});
 try{assert.equal(main.prepare('SELECT count(*) n FROM receipts WHERE scope=? AND idempotency_key=?').get(f.pid,input.idempotency_key).n,0);assert.equal(journal.prepare('SELECT count(*) n FROM requests WHERE project_id=? AND request_key=?').get(f.pid,input.idempotency_key).n,0);}finally{main.close();journal.close();}
 const saved=await f.call('memory_checkpoint',input),again=await f.call('memory_checkpoint',input);assert.equal(saved.status,'persisted');assert.equal(saved.record_id,again.record_id);
 const evidence=await f.call('memory_get_evidence',{project_id:f.pid,record_id:saved.record_id});assert.equal(evidence.record.body,input.body);assert.equal(evidence.verified,false);
});
test('releasing companion readers permits writes without changing the pinned main view',async t=>{
 const f=await fixture(t),s=openSnapshots(f.path,true),before=s.main.prepare('SELECT count(*) n FROM records').get().n;
 try{
  s.closeEvents();s.closeRecovery();s.closeEvents();s.closeRecovery();
  assert.equal((await f.call('memory_checkpoint',{...f.input,idempotency_key:'after-companion-copy'})).status,'persisted');
  assert.equal(s.main.prepare('SELECT count(*) n FROM records').get().n,before);
  const target=join(f.root,'pinned.sqlite');await copySnapshot(s.main,target);
  const c=new DatabaseSync(target,{readOnly:true});try{assert.equal(c.prepare('SELECT count(*) n FROM records').get().n,before);}finally{c.close();}
 }finally{s.close();s.close();}
});
test('large v17 bundles preserve attachments and interruption evidence while another process records',async t=>{
 const f=await fixture(t,{events:1200,receipts:1000,padding:4096}),bytes=Buffer.alloc(1024*1024,97);
 const attachment=saveAttachment(f.path,{project_id:f.pid,run_id:f.run,record_id:f.record,name:'synthetic.txt',data_base64:bytes.toString('base64')}).attachment;
 const before=hash(f.path+'.events.sqlite'),savedBefore=await f.call('memory_get_status',{project_id:f.pid,run_id:f.run});
 const w=worker(t,['writer',f.path,f.pid,f.run]),saved=[];w.child.on('message',m=>{if(m.kind==='saved')saved.push(m.record_id);});
 await message(w.child,m=>m.kind==='saved');
 const n=saved.length,started=performance.now(),b=worker(t,['backup',f.path,join(f.root,'backup')]);
 const backed=await message(b.child,m=>m.kind==='backup');assert.equal(backed.ok,true,b.errors());
 const backupMs=Math.round(performance.now()-started);
 w.child.send('stop');const observed=await message(w.child,m=>m.kind==='stopped');assert.deepEqual(observed.errors,[]);assert.ok(saved.length>n,'Expected concurrent records during the backup operation');
 const restored=await restoreDatabase(backed.result.directory,join(f.root,'restored'));
 const copy=openLocal(restored.db,f.binding,f.root);t.after(()=>copy.close());
 const state=await copy.dispatcher.call('memory_get_status',{project_id:f.pid,run_id:f.run});assert.deepEqual(state.task_recording.interruption,savedBefore.task_recording.interruption);
 const db=new DatabaseSync(restored.db,{readOnly:true});try{assert.deepEqual(attachmentOriginal(db,f.pid,f.run,attachment.id).bytes,bytes);assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);}finally{db.close();}
 assert.equal(hash(f.path+'.events.sqlite'),before);assert.ok(existsSync(join(backed.result.directory,'manifest.json')));
 for(const id of saved){const e=await f.call('memory_get_evidence',{project_id:f.pid,record_id:id});assert.equal(e.verified,false);}
 writeFileSync(join(f.root,'backup-observation.json'),JSON.stringify({synthetic:true,backup_ms:backupMs,concurrent_records:saved.length-n,write_errors:observed.errors,source_attachment_bytes:bytes.length,restored_attachment_matches:true,interruption_preserved:true,original_events_unchanged:true,claims_verified:false}),{flag:'wx'});
});
test('invalid saved-point evidence never publishes a manifest or leaves a blocking reader',async t=>{
 const f=await fixture(t),e=new DatabaseSync(f.path+'.events.sqlite');try{e.exec("UPDATE event_task_links SET saved_json=json_set(saved_json,'$.seq',999999)");}finally{e.close();}
 const target=join(f.root,'invalid');await assert.rejects(backupDatabase(f.path,target),error=>error.code==='invalid_event_link');assert.equal(existsSync(join(target,'manifest.json')),false);
 assert.equal((await f.call('memory_checkpoint',{...f.input,idempotency_key:'after-failure'})).status,'persisted');
});
test('destination validation failure retains partial copies without a completion manifest',async t=>{
 const f=await fixture(t),target=join(f.root,'partial'),prepare=DatabaseSync.prototype.prepare;
 const mock=t.mock.method(DatabaseSync.prototype,'prepare',function(sql){
  if(sql==='PRAGMA integrity_check'&&this.location()===join(target,'memory.sqlite'))throw new Error('Synthetic destination validation failure');
  return prepare.call(this,sql);
 });
 try{await assert.rejects(backupDatabase(f.path,target),/Synthetic destination validation failure/);}finally{mock.mock.restore();}
 assert.equal(existsSync(join(target,'memory.sqlite')),true);assert.equal(existsSync(join(target,'manifest.json')),false);
 assert.equal((await f.call('memory_checkpoint',{...f.input,idempotency_key:'after-partial-failure'})).status,'persisted');
});
