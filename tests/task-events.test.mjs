import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLocal } from '../dist/runtime/local/app.js';
import { recordLifecycle } from '../dist/adapters/storage/sqlite/lifecycle.js';
import { SqliteViewer } from '../dist/adapters/storage/sqlite/viewer.js';

const binding={version:1,key:'event-link-test',name:'테스트 서비스',repository:'web',environment:'development'};
async function fixture(t) {
  const root=mkdtempSync(join(realpathSync(tmpdir()),'skilly-task-events-')),path=join(root,'memory.sqlite');
  writeFileSync(join(root,'skilly.project.json'),JSON.stringify(binding));
  const app=openLocal(path,binding,root);t.after(()=>app.close());
  const call=(name,args)=>app.dispatcher.call(name,args);
  const p=(await call('memory_resolve_project',{})).project.id;
  const begin=async key=>(await call('memory_begin_task',{project_id:p,goal:'연결 검증용 작업 '+key,mode:'change',idempotency_key:key})).run.id;
  const event=(name='PostToolUse',session='session-a',extra={})=>recordLifecycle(path,root,{hook_event_name:name,session_id:session,cwd:root,tool_name:'Bash',...extra}).observation_id;
  const link=(r,id)=>call('memory_link_task_events',{project_id:p,run_id:r,observation_id:id});
  const status=async r=>(await call('memory_get_status',{project_id:p,run_id:r})).task_recording;
  const note=(r,key)=>call('memory_checkpoint',{project_id:p,run_id:r,topic:'test',kind:'change',body:'테스트 변경 '+key,idempotency_key:key});
  const finish=r=>call('memory_finish_task',{project_id:p,run_id:r,summary:'테스트 종료',outcome:'completed',idempotency_key:'finish-'+r});
  return {root,path,app,call,p,begin,event,link,status,note,finish};
}

test('future-only task link preserves records and interruption-time saved point in both AI and viewer',async t=>{
  const f=await fixture(t),r=await f.begin('a');
  const old=f.event('Interrupt'),anchor=f.event();
  const first=await f.note(r,'before');
  const linked=await f.link(r,anchor);assert.equal(linked.status,'persisted');
  assert.equal((await f.status(r)).events.length,0);
  const interrupted=f.event('Interrupt');
  const s=await f.status(r);
  assert.equal(s.task_state,'active');assert.equal(s.interruption.observation_id,interrupted);
  assert.equal(s.interruption.saved_during_event.record_id,first.record_id);
  assert.equal(s.interruption.saved_during_event.receipt_confirmed,true);
  assert.ok(!s.events.some(e=>e.observation_id===old));
  const latest=await f.note(r,'after');
  assert.equal((await f.status(r)).last_saved.record_id,latest.record_id);
  assert.equal((await f.status(r)).interruption.saved_during_event.record_id,first.record_id);
  const view=new SqliteViewer(f.path);
  try {
    assert.deepEqual(view.detail(f.p,r).run.task_recording.interruption,s.interruption);
    assert.equal(view.runs(f.p).items[0].interruption_observed,true);
  } finally {view.close();}
  const raw=new DatabaseSync(f.path,{readOnly:true});
  try {assert.equal(raw.prepare('SELECT body FROM records WHERE id=?').get(first.record_id).body,'테스트 변경 before');assert.equal(raw.prepare('PRAGMA user_version').get().user_version,9);}
  finally{raw.close();}
});

test('another active task cannot take over a session; explicit same-task retry is stable',async t=>{
  const f=await fixture(t),a=await f.begin('a'),b=await f.begin('b'),anchor=f.event();
  const link=await f.link(a,anchor);
  f.event();
  assert.deepEqual(await f.link(a,anchor),link);
  await assert.rejects(f.link(b,anchor),e=>e.code==='link_conflict');
  assert.equal((await f.status(b)).linkage,'not_linked');
  await f.finish(a);
  const next=f.event();await f.link(b,next);const interrupt=f.event('Interrupt');
  assert.equal((await f.status(b)).interruption.observation_id,interrupt);
  assert.equal((await f.status(a)).interruption,null);
});

test('forks, other roots and scopes do not inherit task associations',async t=>{
  const f=await fixture(t),r=await f.begin('a');await f.link(r,f.event());
  const fork=f.event('SessionStart','fork-session',{source:'fork'});f.event('Interrupt','fork-session');
  assert.equal((await f.status(r)).interruption,null);
  const foreignRoot=mkdtempSync(join(realpathSync(tmpdir()),'skilly-task-other-'));
  writeFileSync(join(foreignRoot,'skilly.project.json'),JSON.stringify({...binding,repository:'api'}));
  const foreign=recordLifecycle(f.path,foreignRoot,{cwd:foreignRoot,hook_event_name:'SessionStart',source:'startup',session_id:'other'}).observation_id;
  await assert.rejects(f.link(r,foreign),e=>e.code==='scope_mismatch');
  await assert.rejects(f.call('memory_link_task_events',{project_id:'00000000-0000-4000-8000-000000000000',run_id:r,observation_id:fork}),e=>e.code==='scope_mismatch');
});

test('stale anchors and closed tasks are rejected; later events never attach to closed work',async t=>{
  const f=await fixture(t),r=await f.begin('a'),old=f.event();f.event();
  await assert.rejects(f.link(r,old),e=>e.code==='stale_anchor');
  await assert.rejects(f.link(r,f.event('Stop')),e=>e.code==='stale_anchor');
  await f.link(r,f.event());f.event('Interrupt');await f.finish(r);
  const before=(await f.status(r)).events.length;f.event('Interrupt');
  assert.equal((await f.status(r)).events.length,before);
  const other=await f.begin('b');await f.finish(other);
  await assert.rejects(f.link(other,f.event('SessionStart','other-session',{source:'startup'})),e=>e.code==='run_closed');
});

test('start-only save and pending writes are not promoted to saved changes',async t=>{
  const f=await fixture(t),r=await f.begin('a');await f.link(r,f.event());
  const lock=new DatabaseSync(f.path);lock.exec('BEGIN IMMEDIATE');let failure;
  try{await f.note(r,'pending');}catch(e){failure=e;}finally{lock.exec('ROLLBACK');lock.close();}
  assert.equal(failure.recovery.pending_retained,true);f.event('Interrupt');
  const s=await f.status(r);assert.equal(s.last_saved.stage,'start');assert.equal(s.interruption.saved_during_event.stage,'start');
  const recovered=await f.call('memory_retry_write',{project_id:f.p,request_id:failure.recovery.request_id});
  assert.equal((await f.status(r)).last_saved.record_id,recovered.record_id);
  assert.equal((await f.status(r)).interruption.saved_during_event.stage,'start');
});

test('association failure is disclosed and not replayed; old events stay unlinked after recovery',async t=>{
  const f=await fixture(t),r=await f.begin('a');await f.link(r,f.event());
  renameSync(f.path,f.path+'.retained');let unlinked;
  try{unlinked=f.event('Interrupt');}finally{renameSync(f.path+'.retained',f.path);}
  const s=await f.status(r);assert.equal(s.association_unconfirmed,1);assert.equal(s.interruption,null);
  assert.ok(!s.events.some(e=>e.observation_id===unlinked));
  const again=await f.status(r);assert.equal(again.association_unconfirmed,1);
});

test('last interruption stays visible beyond the bounded recent events page',async t=>{
  const f=await fixture(t),r=await f.begin('a');await f.link(r,f.event());const stop=f.event('Interrupt');
  for(let i=0;i<25;i++)f.event();
  const s=await f.status(r);assert.equal(s.events.length,20);assert.equal(s.history_truncated,true);assert.equal(s.interruption.observation_id,stop);
});
