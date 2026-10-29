import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { openLocal } from '../dist/runtime/local/app.js';
import { recordLifecycle, openLifecycleStore } from '../dist/adapters/storage/sqlite/lifecycle.js';
import { eventCapacity } from '../dist/adapters/storage/sqlite/event-retention.js';
import { eventRetentionCommand } from '../dist/runtime/local/event-retention.js';
import { readEvents } from '../dist/adapters/storage/transfer/events.js';
import { backupDatabase, restoreDatabase } from '../dist/adapters/storage/transfer/snapshot.js';
import { exportProject } from '../dist/adapters/storage/transfer/project.js';
import { prepareTransfer } from '../dist/adapters/storage/transfer/cutover.js';
import { readLocalProject } from '../dist/adapters/storage/portable/sqlite.js';
import { SqliteViewer } from '../dist/adapters/storage/sqlite/viewer.js';
import { eventImportSchemaSql } from '../dist/adapters/storage/sqlite/event-imports.js';
import { putAuthority } from '../dist/adapters/storage/sqlite/project-authority.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const binding={version:1,key:'retention-test',name:'훅 이벤트 보관 테스트',repository:'main',environment:'test'};
const side = f => f.db+'.events.sqlite';
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
async function fixture(t) {
  const root=mkdtempSync(join(realpathSync(tmpdir()),'skilly-event-retention-')), db=join(root,'memory.sqlite');
  writeFileSync(join(root,'skilly.project.json'),JSON.stringify(binding));
  const app=openLocal(db,binding,root);t.after(()=>app.close());
  const call=(name,input)=>app.dispatcher.call(name,input), p=(await call('memory_resolve_project',{})).project.id;
  const run=(await call('memory_begin_task',{project_id:p,goal:'합성 이벤트 보관 시험',mode:'change',idempotency_key:'begin'})).run.id;
  const f={root,db,p,run,call};
  f.event=(event='PostToolUse',extra={})=>recordLifecycle(db,root,{cwd:root,session_id:'synthetic-only',hook_event_name:event,...extra}).observation_id;
  f.link=id=>call('memory_link_task_events',{project_id:p,run_id:run,observation_id:id});
  f.status=async()=> (await call('memory_get_status',{project_id:p,run_id:run})).task_recording;
  f.preview=()=>eventRetentionCommand('events-retention-status',{db});
  f.enable=()=>eventRetentionCommand('events-retention-enable',{db,expect:f.preview().expect});
  f.anchor=f.event('SessionStart');await f.link(f.anchor);
  f.record=(await call('memory_checkpoint',{project_id:p,run_id:run,kind:'note',topic:'synthetic',body:'보존할 테스트 원문',idempotency_key:'note'})).record_id;
  f.interrupt=f.event('Interrupt');
  return f;
}
function seed(f,total,{associate=false,pad=false}={}) {
  const db=new DatabaseSync(side(f));db.exec('BEGIN IMMEDIATE');
  try {
    const source=db.prepare('SELECT * FROM events ORDER BY seq DESC LIMIT 1').get();
    const link=db.prepare('SELECT id FROM task_links ORDER BY seq DESC LIMIT 1').get().id;
    const saved=db.prepare('SELECT saved_json FROM event_task_links LIMIT 1').get().saved_json;
    const insert=db.prepare('INSERT INTO events VALUES(NULL,?,?,?,?,?,?,?,?,?,?,?)');
    const linkInsert=db.prepare('INSERT INTO event_task_links VALUES(?,?,?)');
    let n=db.prepare('SELECT count(*) n FROM events').get().n;
    for(;n<total;n++) {
      const id=randomUUID();insert.run(id,source.project_key,source.repository,source.environment,source.root_hash,source.session_hash,null,'PostToolUse',null,'shell',source.received_at);
      if(associate) linkInsert.run(id,link,pad?saved.padEnd(4096,' '):saved);
    }
    db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}finally{db.close();}
}
function rows(f) {
  const db=new DatabaseSync(side(f),{readOnly:true});
  try{return Object.fromEntries(['events','task_links','event_task_links','event_link_failures'].map(t=>[t,db.prepare('SELECT * FROM '+t+' ORDER BY rowid').all()]));}finally{db.close();}
}
const withCapacity=f=>{const d=readEvents(side(f));try{return eventCapacity(d,true);}finally{d.close();}};

test('legacy full is retained, never auto-activated or represented as a queue',async t=>{
  const f=await fixture(t);seed(f,10000);const before=digest(side(f));
  assert.throws(()=>f.event(),e=>e.code==='event_store_full');
  const c=(await f.status()).event_retention;
  assert.equal(c.capture_status,'activation_required');assert.equal(c.schema_version,1);
  assert.equal(c.total_events,10000);assert.equal(c.missing_event_count,null);
  assert.equal(c.automatic_activation,false);assert.equal(digest(side(f)),before);
  const p=f.preview();assert.equal(p.event_retention.capture_status,'activation_required');
  assert.throws(()=>eventRetentionCommand('events-retention-enable',{db:f.db,expect:'0'.repeat(64)}),e=>e.code==='event_store_changed');
  assert.equal(digest(side(f)),before);
});

test('explicit activation retains original rows and interruption; fresh capture does not inherit stale binding',async t=>{
  const f=await fixture(t);seed(f,10000);const before=rows(f),status=await f.status();
  assert.equal(f.enable().status,'persisted');
  assert.deepEqual(rows(f),before);
  assert.equal(withCapacity(f).archived_events,10000);assert.equal(withCapacity(f).active_events,0);
  assert.deepEqual((await f.status()).interruption,status.interruption);
  assert.equal((await f.status()).linkage,'historical_retained');
  const unrelated=f.event('Interrupt');assert.equal((await f.status()).interruption.observation_id,f.interrupt);
  const raw=new DatabaseSync(side(f),{readOnly:true});try{assert.equal(raw.prepare('SELECT * FROM event_task_links WHERE event_id=?').get(unrelated),undefined);}finally{raw.close();}
  await assert.rejects(f.link(f.anchor),e=>e.code==='stale_anchor');
  const anchor=f.event();await f.link(anchor);const next=f.event('Interrupt');
  assert.equal((await f.status()).interruption.observation_id,next);
  assert.equal((await f.status()).interruption.saved_during_event.record_id,f.record);
  const after=rows(f);for(const table of Object.keys(before))assert.deepEqual(after[table].slice(0,before[table].length),before[table]);
});

test('ordinary storage rollover preserves a healthy current binding and the immutable saved point',async t=>{
  const f=await fixture(t);f.enable();await f.link(f.event());seed(f,10002);
  assert.equal(withCapacity(f).capture_status,'rollover_ready');
  const interrupted=f.event('Interrupt'),c=withCapacity(f);
  assert.equal(c.windows,3);assert.equal(c.active_events,1);assert.equal(c.archived_events,10002);
  const status=await f.status();assert.equal(status.capture_epoch_binding,true);assert.equal(status.current_session_binding,undefined);
  assert.equal(status.interruption.observation_id,interrupted);assert.equal(status.interruption.saved_during_event.record_id,f.record);
  const viewer=new SqliteViewer(f.db);try{assert.deepEqual(viewer.detail(f.p,f.run).run.task_recording.interruption,status.interruption);}finally{viewer.close();}
});

test('v2 import origins remain historical and enabling is idempotent without editing existing rows',async t=>{
  const f=await fixture(t);const d=new DatabaseSync(side(f));
  try{d.exec(eventImportSchemaSql+'PRAGMA user_version=2;');d.prepare('INSERT INTO event_imports VALUES(?,?,?,?,?)').run('event',f.interrupt,2,null,'a'.repeat(64));}finally{d.close();}
  const original=rows(f);assert.equal(f.preview().event_retention.schema_version,2);
  f.enable();assert.deepEqual(rows(f),original);const before=digest(side(f));f.enable();assert.equal(digest(side(f)),before);
  const reader=readEvents(side(f));try{assert.equal(reader.prepare('SELECT count(*) n FROM event_imports').get().n,1);}finally{reader.close();}
});

test('writable and blocked managed stores reject activation before changing authority or recovery compatibility',async t=>{
  for(const state of ['writable','blocked']) {
    const f=await fixture(t),d=new DatabaseSync(side(f));
    try{putAuthority(d,'events',{project_id:f.p,project_key:binding.key,transfer_id:randomUUID(),generation:1,role:'target',state,updated_at:new Date().toISOString()});}finally{d.close();}
    const before=digest(side(f)),preview=f.preview();
    assert.throws(()=>eventRetentionCommand('events-retention-enable',{db:f.db,expect:preview.expect}),e=>e.code==='unsupported_event_retention_transfer');
    assert.equal(digest(side(f)),before);assert.equal(f.preview().event_retention.schema_version,1);
  }
});

test('post-insert budget fault rolls back only the attempted observation and releases the writer lock',async t=>{
  const f=await fixture(t);f.enable();const before=rows(f),hash=digest(side(f));
  const prepare=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql,...args){
    if(sql==='PRAGMA page_count') {
      const statement=prepare.call(this,sql,...args),db=this;
      return {get(){const n=prepare.call(db,'SELECT count(*) n FROM events').get().n;return n>2?{page_count:67108864/4096+1}:statement.get();}};
    }
    return prepare.call(this,sql,...args);
  };
  try{assert.throws(()=>f.event(),e=>e.code==='event_store_full');}finally{DatabaseSync.prototype.prepare=prepare;}
  assert.deepEqual(rows(f),before);assert.equal(digest(side(f)),hash);
  assert.equal(typeof f.event(),'string');assert.equal(withCapacity(f).total_events,3);
});

test('body reserve shows collection stopped and never queues a refused observation',async t=>{
  const f=await fixture(t);f.enable();const before=digest(side(f)),prepare=DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare=function(sql,...args){return sql==='PRAGMA page_count'?{get:()=>({page_count:67108864/4096-16})}:prepare.call(this,sql,...args);};
  try {
    assert.equal((await f.status()).event_retention.capture_status,'storage_full');
    assert.throws(()=>f.event(),e=>e.code==='event_store_full');
    assert.equal((await f.status()).event_retention.missing_event_count,null);
  }finally{DatabaseSync.prototype.prepare=prepare;}
  assert.equal(digest(side(f)),before);
});

test('capacity pins one snapshot across a concurrent WAL rollover and validates sealed ranges',async t=>{
  const f=await fixture(t);f.enable();seed(f,10002);
  const setup=new DatabaseSync(side(f));setup.exec('PRAGMA journal_mode=WAL');setup.close();
  const reader=new DatabaseSync(side(f),{readOnly:true}),prepare=DatabaseSync.prototype.prepare;let injected=false;
  DatabaseSync.prototype.prepare=function(sql,...args){
    const statement=prepare.call(this,sql,...args);
    if(this===reader && sql.startsWith('SELECT * FROM event_windows') && !injected) {
      return {all(){const rows=statement.all();injected=true;f.event();return rows;}};
    }
    return statement;
  };
  try{const status=eventCapacity(reader);assert.equal(status.windows,2);assert.equal(status.active_events,10000);assert.equal(status.total_events,10002);}
  finally{DatabaseSync.prototype.prepare=prepare;reader.close();}
  const fresh=openLifecycleStore(side(f));try{assert.equal(eventCapacity(fresh).windows,3);assert.equal(eventCapacity(fresh).active_events,1);}finally{fresh.close();}
  const bad=new DatabaseSync(side(f));try{bad.prepare('INSERT INTO event_windows VALUES(4,?,?)').run(10004,new Date().toISOString());}finally{bad.close();}
  assert.throws(()=>f.event(),e=>e.code==='invalid_event_retention');assert.equal((await f.status()).linkage,'unavailable');
});

test('activation after transfer preflight is caught before the source write fence',async t=>{
  const f=await fixture(t),prepare=DatabaseSync.prototype.prepare;let activated=false;
  DatabaseSync.prototype.prepare=function(sql,...args){
    if(!activated && sql.startsWith('INSERT INTO operation VALUES')) {activated=true;f.enable();}
    return prepare.call(this,sql,...args);
  };
  try{await assert.rejects(prepareTransfer(f.db,f.p,join(f.root,'raced-transfer')),e=>e.code==='unsupported_event_retention_transfer');}
  finally{DatabaseSync.prototype.prepare=prepare;}
  assert.equal(activated,true);const main=new DatabaseSync(f.db,{readOnly:true});
  try{assert.equal(main.prepare("SELECT 1 FROM sqlite_schema WHERE name='project_authority'").get(),undefined);}finally{main.close();}
  assert.equal(withCapacity(f).schema_version,3);
  await f.call('memory_checkpoint',{project_id:f.p,run_id:f.run,kind:'note',topic:'synthetic',body:'동시 경계 후에도 원본 쓰기 허용',idempotency_key:'after-race'});
});

test('pre-activation unfinished binding still fences another task; completion does not claim a current session',async t=>{
  const f=await fixture(t);f.enable();const anchor=f.event();
  const other=(await f.call('memory_begin_task',{project_id:f.p,goal:'다른 합성 작업',mode:'change',idempotency_key:'other'})).run.id;
  await assert.rejects(f.call('memory_link_task_events',{project_id:f.p,run_id:other,observation_id:anchor}),e=>e.code==='link_conflict');
  await f.link(anchor);await f.call('memory_finish_task',{project_id:f.p,run_id:f.run,summary:'합성 시험 종료',outcome:'completed',idempotency_key:'finish'});
  const s=await f.status();assert.equal(s.capture_epoch_binding,true);assert.equal(s.current_session_binding,undefined);assert.equal(s.live_execution,'unknown');
});

test('duplicate retry is stable at a full window and concurrent receivers allocate only one next window',async t=>{
  const f=await fixture(t);f.enable();const id=f.event('PostToolUse',{tool_use_id:'same-input'});seed(f,10002);
  assert.equal(f.event('PostToolUse',{tool_use_id:'same-input'}),id);assert.equal(withCapacity(f).windows,2);
  const code=`import {recordLifecycle} from ${JSON.stringify(new URL('../dist/adapters/storage/sqlite/lifecycle.js',import.meta.url).href)}; const [db,root,key]=process.argv.slice(1);try{console.log(JSON.stringify(recordLifecycle(db,root,{cwd:root,session_id:'synthetic-only',hook_event_name:'PostToolUse',tool_use_id:key})));}catch(e){console.error(e.code);process.exitCode=1;}`;
  const child=()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',code,f.db,f.root,'concurrent-same'],{stdio:['ignore','pipe','pipe']});let out='',err='';p.stdout.on('data',b=>out+=b);p.stderr.on('data',b=>err+=b);p.on('error',reject);p.on('close',n=>n?reject(new Error(err)):resolve(JSON.parse(out)));});
  const [a,b]=await Promise.all([child(),child()]);assert.equal(a.observation_id,b.observation_id);
  const c=withCapacity(f);assert.equal(c.windows,3);assert.equal(c.active_events,1);
});

test('retained window exhaustion rejects the new observation without changing any retained row',async t=>{
  const f=await fixture(t);f.enable();
  for(let i=0;i<7;i++){const c=withCapacity(f);seed(f,c.total_events+10000-c.active_events);if(i<6)f.event();}
  const c=withCapacity(f);assert.equal(c.windows,8);assert.equal(c.capture_status,'retention_full');
  const before=digest(side(f));assert.throws(()=>f.event(),e=>e.code==='event_store_full');assert.equal(digest(side(f)),before);
  assert.equal((await f.status()).event_retention.capture_status,'retention_full');
});

test('whole backup and fresh restore retain all windows, IDs, links and saved JSON above 10000 events',async t=>{
  const f=await fixture(t);seed(f,10000);f.enable();await f.link(f.event());f.event('Interrupt');
  const original=rows(f),before=digest(side(f)),status=await f.status();
  const backed=await backupDatabase(f.db,join(f.root,'backup')),restored=await restoreDatabase(backed.directory,join(f.root,'restore'));
  const restoredFixture={...f,db:restored.db};assert.deepEqual(rows(restoredFixture),original);
  assert.deepEqual(withCapacity(restoredFixture),withCapacity(f));assert.equal(digest(side(f)),before);
  const app=openLocal(restored.db,binding,f.root);t.after(()=>app.close());
  const read=await app.dispatcher.call('memory_get_status',{project_id:f.p,run_id:f.run});
  assert.deepEqual(read.task_recording.interruption,status.interruption);
  const client=new Client({name:'retention-fresh-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[new URL('../dist/runtime/local/main.js',import.meta.url).pathname,'serve','--db',restored.db,'--project',f.root],stderr:'pipe'});
  await client.connect(transport);t.after(()=>client.close());
  const result=await client.callTool({name:'memory_get_status',arguments:{project_id:f.p,run_id:f.run}});
  const data=JSON.parse(result.content.find(x=>x.type==='text').text);
  assert.deepEqual(data.task_recording.interruption,status.interruption);assert.equal(data.task_recording.event_retention.total_events,10002);
});

test('unsupported project transfer paths fail before output/fencing and retained metadata rejects mutation',async t=>{
  const f=await fixture(t);f.enable();const before=digest(side(f));
  const output=join(f.root,'export');assert.throws(()=>exportProject(f.db,f.p,output),e=>e.code==='unsupported_event_retention_transfer');assert.equal(existsSync(output),false);
  const operation=join(f.root,'transfer');await assert.rejects(prepareTransfer(f.db,f.p,operation),e=>e.code==='unsupported_event_retention_transfer');assert.equal(existsSync(operation),false);
  assert.throws(()=>readLocalProject(f.db,f.p),e=>e.code==='unsupported_event_retention_transfer');assert.equal(digest(side(f)),before);
  const db=new DatabaseSync(side(f));try{
    assert.throws(()=>db.exec('UPDATE event_windows SET first_seq=2 WHERE id=1'),/immutable_event_window/);
    assert.throws(()=>db.exec('UPDATE event_retention SET capture_from_seq=1'),/immutable_event_retention/);
    assert.throws(()=>db.prepare('INSERT OR REPLACE INTO event_retention VALUES(1,1,1,?)').run(new Date().toISOString()),/immutable_event_retention/);
    assert.throws(()=>db.prepare('INSERT OR REPLACE INTO event_windows VALUES(1,1,?)').run(new Date().toISOString()),/immutable_event_window/);
  }finally{db.close();}
  assert.equal(digest(side(f)),before);
});

test('unexpected or overflowing window metadata fails closed without an empty-success projection',async t=>{
  const f=await fixture(t);f.enable();
  const db=new DatabaseSync(side(f));try{db.prepare('INSERT INTO event_windows VALUES(3,?,?)').run(99999,new Date().toISOString());}finally{db.close();}
  assert.throws(()=>readEvents(side(f)),e=>e.code==='invalid_event_retention');
  assert.equal((await f.status()).linkage,'unavailable');
  assert.throws(()=>f.event(),e=>e.code==='invalid_event_retention');
});
