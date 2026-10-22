import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,existsSync,statSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openLocal} from '../dist/runtime/local/app.js';
import {recordLifecycle} from '../dist/adapters/storage/sqlite/lifecycle.js';
import {backupDatabase,restoreDatabase,openSnapshots} from '../dist/adapters/storage/transfer/snapshot.js';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
async function fixture(t) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'skilly-event-backup-'))),db=join(root,'memory.sqlite');
 const binding={version:1,key:'test-events-backup',name:'테스트',repository:'workspace',environment:'development',component:{key:'web',name:'Web'}};
 writeFileSync(join(root,'skilly.project.json'),JSON.stringify(binding));
 const app=openLocal(db,binding,root);t.after(()=>app.close());
 const call=(n,a)=>app.dispatcher.call(n,a),pid=(await call('memory_resolve_project',{})).project.id;
 const run=(await call('memory_begin_task',{project_id:pid,goal:'테스트 중단',mode:'diagnose',idempotency_key:'begin'})).run.id;
 const event=name=>recordLifecycle(db,root,{hook_event_name:name,session_id:'synthetic-test-only',cwd:root}).observation_id;
 await call('memory_link_task_events',{project_id:pid,run_id:run,observation_id:event('SessionStart')});
 const record=(await call('memory_checkpoint',{project_id:pid,run_id:run,topic:'test',kind:'note',body:'원문 보존',idempotency_key:'note'})).record_id;
 const interrupt=event('Interrupt');
 const status=()=>call('memory_get_status',{project_id:pid,run_id:run});
 return {root,db,binding,pid,run,record,interrupt,status,event};
}
function reseal(directory) {
 const file=join(directory,'memory.sqlite.events.sqlite'),manifestFile=join(directory,'manifest.json');
 const m=JSON.parse(readFileSync(manifestFile));m.files.events={sha256:hash(file),bytes:statSync(file).size};writeFileSync(manifestFile,JSON.stringify(m));
}
test('backup and restore retain event IDs, task linkage and immutable saved point without changing originals',async t=>{
 const f=await fixture(t),original=await f.status(),before=hash(f.db),eventsBefore=hash(f.db+'.events.sqlite');
 const backed=await backupDatabase(f.db,join(f.root,'backup'));
 assert.equal(backed.events,'included');assert.equal(JSON.parse(readFileSync(join(backed.directory,'manifest.json'))).version,2);
 const restored=await restoreDatabase(backed.directory,join(f.root,'restored'));
 const fresh=openLocal(restored.db,f.binding,f.root);t.after(()=>fresh.close());
 const recalled=await fresh.dispatcher.call('memory_get_status',{project_id:f.pid,run_id:f.run});
 assert.deepEqual(recalled.task_recording,original.task_recording);
 assert.equal(recalled.task_recording.interruption.observation_id,f.interrupt);
 assert.equal(recalled.task_recording.interruption.saved_during_event.record_id,f.record);
 const view=new SqliteViewer(restored.db);try{assert.deepEqual(view.detail(f.pid,f.run).run.task_recording.interruption,recalled.task_recording.interruption);}finally{view.close();}
 assert.equal(hash(f.db),before);assert.equal(hash(f.db+'.events.sqlite'),eventsBefore);
 assert.equal(statSync(restored.db+'.events.sqlite').mode&0o777,0o600);
});
test('moved roots preserve historical viewer evidence but never inherit an active session binding',async t=>{
 const f=await fixture(t),b=await backupDatabase(f.db,join(f.root,'backup')),r=await restoreDatabase(b.directory,join(f.root,'restored'));
 const moved=join(f.root,'moved');mkdirSync(moved);writeFileSync(join(moved,'skilly.project.json'),JSON.stringify(f.binding));
 const app=openLocal(r.db,f.binding,moved);t.after(()=>app.close());
 const s=await app.dispatcher.call('memory_get_status',{project_id:f.pid,run_id:f.run});assert.equal(s.task_recording.linkage,'not_linked');
 const v=new SqliteViewer(r.db);try{assert.equal(v.detail(f.pid,f.run).run.task_recording.interruption.observation_id,f.interrupt);}finally{v.close();}
 recordLifecycle(r.db,moved,{cwd:moved,session_id:'new-synthetic-session',hook_event_name:'Interrupt'});
 const v2=new SqliteViewer(r.db);try{assert.equal(v2.detail(f.pid,f.run).run.task_recording.interruption.observation_id,f.interrupt);}finally{v2.close();}
});
test('tampered event checksums and cross-task saved references cannot publish a restored bundle',async t=>{
 const f=await fixture(t);
 for(const resealed of [false,true]) {
  const b=await backupDatabase(f.db,join(f.root,'backup-'+resealed));
  const d=new DatabaseSync(b.db+'.events.sqlite');
  d.prepare("UPDATE event_task_links SET saved_json=json_set(saved_json,'$.record_id',?)").run('00000000-0000-4000-8000-000000000000');d.close();
  if(resealed)reseal(b.directory);
  const target=join(f.root,'invalid-'+resealed);
  await assert.rejects(restoreDatabase(b.directory,target),e=>e.code===(resealed?'invalid_event_link':'checksum_mismatch'));
  assert.equal(existsSync(target),false);
 }
});
test('unsealed overlays, undeclared event companion and custom schema fail closed',async t=>{
 const f=await fixture(t),b=await backupDatabase(f.db,join(f.root,'backup'));
 writeFileSync(b.db+'.events.sqlite-wal','unsealed');
 await assert.rejects(restoreDatabase(b.directory,join(f.root,'overlay')),e=>e.code==='unsealed_bundle');
 const b2=await backupDatabase(f.db,join(f.root,'backup2')),m=JSON.parse(readFileSync(join(b2.directory,'manifest.json')));
 m.version=1;delete m.files.events;writeFileSync(join(b2.directory,'manifest.json'),JSON.stringify(m));
 await assert.rejects(restoreDatabase(b2.directory,join(f.root,'undeclared')),e=>e.code==='unsealed_bundle');
 const d=new DatabaseSync(f.db+'.events.sqlite');d.exec('CREATE TABLE extra (body TEXT)');d.close();
 await assert.rejects(backupDatabase(f.db,join(f.root,'custom')),e=>e.code==='invalid_event_store');
 assert.equal(existsSync(join(f.root,'custom')),false);
});
test('event snapshot is pinned before the main snapshot and does not absorb later observations',async t=>{
 const f=await fixture(t);
 // Exercise concurrent snapshots in a WAL fixture; normal rollback stores may block a writer.
 const writer=new DatabaseSync(f.db+'.events.sqlite');writer.exec('PRAGMA journal_mode=WAL;');writer.close();
 const s=openSnapshots(f.db,true);
 try{const count=s.events.prepare('SELECT count(*) n FROM events').get().n;f.event('PostToolUse');assert.equal(s.events.prepare('SELECT count(*) n FROM events').get().n,count);}
 finally{s.close();}
});
