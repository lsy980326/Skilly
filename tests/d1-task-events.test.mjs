import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,createHash } from 'node:crypto';
import { mkdtempSync,readFileSync,writeFileSync,realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { D1AtomicCommitStore } from '../dist/adapters/storage/d1/atomic-store.js';
import { D1TaskEvents } from '../dist/adapters/storage/d1/task-events.js';
import { openLocal } from '../dist/runtime/local/app.js';
import { recordLifecycle,readLifecycle } from '../dist/adapters/storage/sqlite/lifecycle.js';
import { d1WorkerModules } from './support/d1-modules.mjs';

const at='2026-10-25T00:00:00.000Z',hash=x=>createHash('sha256').update(x).digest('hex');
function fault(db,c){return {withSession(constraint){const s=db.withSession(constraint);return {
  prepare(sql){if(c.blockReceipt&&c.committed&&sql.startsWith('SELECT payload_hash'))return {bind(){return this;},async all(){throw Error('injected receipt unavailable');}};return s.prepare(sql);},
  async batch(statements){c.count=statements.length;const submitted=[...statements];
    if(c.failBefore!==undefined)submitted.splice(c.failBefore,0,s.prepare('INSERT INTO event_fault VALUES(0)'));
    if(c.beforeBatch){const hook=c.beforeBatch;c.beforeBatch=null;await hook();}
    const result=await s.batch(submitted);c.committed=true;
    if(c.loseResponse){c.loseResponse=false;throw Error('injected loss after actual local D1 commit');}return result;
  }};}};}

test('actual local D1 received events, explicit tasks and interruption snapshots',{timeout:150000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'skilly-d1-events-'));
  const options={...d1WorkerModules(fileURLToPath(new URL('./support/d1-runtime-worker.mjs',import.meta.url))),
    compatibilityDate:'2026-07-30',d1Databases:{DB:randomUUID()},d1Persist:join(root,'d1'),host:'127.0.0.1',port:0,
    outboundService:()=>new Response('external fetch disabled',{status:403})};
  let mf=new Miniflare(options);t.after(()=>mf.dispose());let db=await mf.getD1Database('DB');
  const all=async(sql,...args)=>(await db.prepare(sql).bind(...args).all()).results;
  const apply=async names=>{for(const name of names){const sql=readFileSync(new URL('../migrations/d1/'+name,import.meta.url),'utf8')
    .replace(/^--[^\n]*$/gm,'').trim().split(/;\s*(?=CREATE\s|$)/i).filter(Boolean);await db.batch(sql.map(s=>db.prepare(s)));}};
  await apply(['001-atomic-memory.sql','002-work.sql','003-decisions-plans.sql','004-execution-evidence.sql']);
  const scope=f=>({project_id:f.p.id,repository:'api',environment:'test',root_hash:hash('test-root'),session_hash:hash('test-session')});
  const receipt=(p,result={status:'persisted'})=>{const key=randomUUID();return {scope:p.id,key,hash:hash(key),result};};
  const mutation=async(f,extra={})=>{const revision=(await all('SELECT revision FROM projects WHERE id=?',f.p.id))[0].revision;
    return {project:{...f.p,revision:revision+1},expected_revision:revision,receipt:receipt(f.p),...extra};};
  const seed=async()=>{
    const p={id:randomUUID(),key:'event-'+randomUUID(),name:'D1 이벤트 테스트',revision:0,created_at:at},f={p,store:new D1AtomicCommitStore(db,p.id)};
    await f.store.commit({project:p,expected_revision:null,receipt:receipt(p)});
    f.run={id:randomUUID(),project_id:p.id,goal:'테스트용 수신 이벤트 연결',mode:'change',repository:'api',environment:'test',state:'active',created_at:at,updated_at:at};
    await f.store.commit(await mutation(f,{run:f.run,receipt:receipt(p,{run:f.run})}));f.events=new D1TaskEvents(db,scope(f));return f;
  };
  const input=(event='PostToolUse',extra={})=>({idempotency_key:randomUUID(),observation_id:randomUUID(),event,observed_at:at,turn_hash:hash('tool-group'),source:null,tool_group:'shell',...extra});
  const receive=async(f,event='PostToolUse',extra={})=>{const i=input(event,extra);return {i,receipt:await f.events.receive(i)};};
  const link=(f,anchor,extra={})=>({run_id:f.run.id,observation_id:anchor,idempotency_key:randomUUID(),...extra});
  const note=async(f,mode='single')=>{
    const r={id:randomUUID(),project_id:f.p.id,run_id:f.run.id,topic:'events-test',kind:'change',body:'테스트용 저장 지점 원문',
      repository:'api',environment:'test',source_fingerprint:null,observed_at:at,recorded_at:at,supersedes:null,superseded_by:null,report_origin:'contemporaneous'};
    await f.store.commit(await mutation(f,{record:r,receipt:receipt(f.p,mode==='none'?{}:mode==='multipart'?{record_ids:[r.id]}:{record_id:r.id})}));return r;
  };
  const status=f=>f.events.status(f.run.id);
  const worker=async(input,status=200)=>{const res=await mf.dispatchFetch('http://local-events.invalid/',{method:'POST',body:JSON.stringify({...input,project_id:input.scope.project_id})});
    const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));return body;};
  const tables=['projects','runs','records','receipts','lifecycle_events','task_event_links','event_task_snapshots','skilly_write_assertions'];
  const snapshot=async()=>JSON.stringify(await Promise.all(tables.map(table=>all(`SELECT * FROM ${table} ORDER BY 1,2`))));

  await t.test('004 remains unsupported without empty-success or installing schema automatically',async()=>{
    const f=await seed();assert.equal((await status(f)).schema_supported,false);
    assert.equal((await f.events.observations()).status,'unsupported');
    await assert.rejects(f.events.receive(input()),{code:'unsupported_capability'});
    await assert.rejects(f.events.link(link(f,randomUUID())),{code:'unsupported_capability'});
  });
  await apply(['005-task-events.sql']);await db.prepare('CREATE TABLE event_fault(ok INTEGER NOT NULL CHECK(ok=1)) STRICT').run();
  await t.test('Worker stores received events separately, links future events only, and freezes interruption-time saved point',async()=>{
    const f=await seed(),old=await receive(f,'Interrupt'),anchor=await receive(f);
    const before=await note(f),request=link(f,anchor.i.observation_id);
    const linked=await worker({operation:'event-link',scope:scope(f),input:request});assert.equal(linked.status,'persisted');
    assert.equal((await status(f)).events.length,0);
    const stop=input('Interrupt');await worker({operation:'event-receive',scope:scope(f),input:stop});
    const first=await worker({operation:'event-status',scope:scope(f),run_id:f.run.id});
    assert.equal(first.interruption.observation_id,stop.observation_id);assert.equal(first.interruption.saved_during_event.record_id,before.id);
    assert.equal(first.interruption.saved_during_event.receipt_confirmed,true);assert.equal(first.task_state,'active');
    assert.ok(!first.events.some(x=>x.observation_id===old.i.observation_id));
    const after=await note(f);const next=await new D1TaskEvents(db,scope(f)).status(f.run.id);
    assert.equal(next.last_saved.record_id,after.id);assert.deepEqual(next.interruption,first.interruption);
    assert.equal(next.missing_record_count,null);assert.equal(next.live_execution,'unknown');assert.equal(next.completeness,'unknown');
    assert.deepEqual(await f.events.link(request),linked);
    await assert.rejects(db.prepare('UPDATE event_task_snapshots SET saved_json=? WHERE project_id=?').bind('{}',f.p.id).run());
  });
  await t.test('delayed anchors survive tool groups/PreCompact but no received event before the link is backfilled',async()=>{
    const f=await seed(),a=await receive(f);await receive(f,'PostToolUse',{turn_hash:hash('different-tool-group')});await receive(f,'PreCompact');
    const other=new D1TaskEvents(db,{...scope(f),session_hash:hash('other-session')});await other.receive(input('Stop'));
    const watermark=(await all('SELECT max(seq) AS n FROM lifecycle_events'))[0].n+1;
    await f.events.link(link(f,a.i.observation_id));assert.equal((await status(f)).events.length,0);
    const row=(await all('SELECT from_seq FROM task_event_links WHERE project_id=?',f.p.id))[0];assert.equal(row.from_seq,watermark);
    await receive(f,'Interrupt');assert.equal((await status(f)).events.length,1);
  });
  await t.test('closing/restart anchors are stale even after later tools, and foreign scope/session/root cannot be used',async()=>{
    for(const boundary of ['Stop','Interrupt','SessionEnd','SessionStart']){
      const f=await seed(),a=await receive(f);const b=await receive(f,boundary);await receive(f);
      await assert.rejects(f.events.link(link(f,a.i.observation_id)),{code:'stale_anchor'});
      if(boundary!=='SessionStart')await assert.rejects(f.events.link(link(f,b.i.observation_id)),{code:'stale_anchor'});
      const fresh=await receive(f);await f.events.link(link(f,fresh.i.observation_id));
    }
    const f=await seed(),a=await receive(f),other=await seed();
    for(const s of [{...scope(f),repository:'web'},{...scope(f),environment:'production'},{...scope(f),root_hash:hash('elsewhere')},
      {...scope(f),session_hash:hash('fork')},scope(other)])await assert.rejects(new D1TaskEvents(db,s).link(link(f,a.i.observation_id)),{code:'scope_mismatch'});
  });
  await t.test('active task takeover is blocked, same-task link receipts stay stable, and closed tasks receive no new associations',async()=>{
    const f=await seed(),a=await receive(f),original=await f.events.link(link(f,a.i.observation_id));
    const other={...f,run:{...f.run,id:randomUUID()}};await f.store.commit(await mutation(other,{run:other.run}));
    await assert.rejects(f.events.link(link(other,a.i.observation_id)),{code:'link_conflict'});
    await receive(f,'Interrupt');const before=await status(f);
    assert.deepEqual(await f.events.link(link(f,a.i.observation_id)),original);
    await f.store.commit(await mutation(f,{run:{...f.run,state:'completed'}}));
    const closed=await receive(f,'Stop');const observations=await f.events.observations();
    assert.equal(observations.items.find(x=>x.observation_id===closed.i.observation_id).association_status,'run_closed');
    assert.equal((await status(f)).events.length,before.events.length);
    const current=await receive(f);await f.events.link(link(other,current.i.observation_id));await receive(f,'Interrupt');
    assert.equal((await status(other)).events.length,1);assert.equal((await status(f)).current_session_binding,false);
  });
  await t.test('start receipts, visible but unconfirmed records and multipart receipts remain distinct; later saves do not alter the snapshot',async()=>{
    const f=await seed(),a=await receive(f);await f.events.link(link(f,a.i.observation_id));await receive(f,'Interrupt');
    const startPoint=(await status(f)).interruption.saved_during_event;assert.equal(startPoint.stage,'start');assert.equal(startPoint.record_visible,false);
    const visible=await note(f,'none');await receive(f,'Interrupt');let read=await status(f);
    assert.equal(read.interruption.saved_during_event.record_id,visible.id);assert.equal(read.interruption.saved_during_event.receipt_confirmed,false);
    const confirmed=await note(f,'multipart');read=await status(f);assert.equal(read.last_saved.record_id,confirmed.id);assert.equal(read.last_saved.receipt_confirmed,true);
    assert.equal(read.interruption.saved_during_event.record_id,visible.id);
    await receive(f,'Interrupt');assert.equal((await status(f)).interruption.saved_during_event.receipt_confirmed,true);
  });
  await t.test('event IDs and request keys deduplicate without backfilling; changed payloads and arbitrary data are rejected',async()=>{
    const f=await seed(),i=input('Interrupt'),first=await f.events.receive(i),a=await receive(f);await f.events.link(link(f,a.i.observation_id));
    assert.deepEqual(await f.events.receive(i),first);
    await f.events.receive({...i,idempotency_key:randomUUID()});assert.equal((await status(f)).events.length,0);
    await assert.rejects(f.events.receive({...i,event:'Stop'}),{code:'idempotency_conflict'});
    await assert.rejects(f.events.receive({...i,event:'Stop',idempotency_key:randomUUID()}),{code:'event_conflict'});
    for(const extra of [{prompt:'no'},{cwd:'/not/read'},{session_hash:hash('foreign')},{project_id:randomUUID()},{event:'Unknown'}])
      await assert.rejects(f.events.receive({...input(),...extra}),{code:'invalid_input'});
    assert.equal((await all('SELECT count(*) n FROM lifecycle_events WHERE project_id=? AND id=?',f.p.id,i.observation_id))[0].n,1);
  });
  await t.test('event and link CAS races reread only original inputs; interruption snapshot has one actual receipt order',async()=>{
    const f=await seed(),a=await receive(f);await f.events.link(link(f,a.i.observation_id));const before=await note(f),later={};
    const c={beforeBatch:async()=>{later.record=await note(f);}};
    await new D1TaskEvents(fault(db,c),scope(f)).receive(input('Interrupt'));
    assert.equal((await status(f)).interruption.saved_during_event.record_id,later.record.id);assert.notEqual(before.id,later.record.id);
    const g=await seed(),anchor=await receive(g),c2={beforeBatch:async()=>{await receive(g,'Stop');}};
    await assert.rejects(new D1TaskEvents(fault(db,c2),scope(g)).link(link(g,anchor.i.observation_id)),{code:'stale_anchor'});
    assert.equal((await status(g)).linkage,'not_linked');
  });
  await t.test('every SQL event/snapshot/link/receipt boundary rolls back atomically; old receipt collision cannot claim a new event',async()=>{
    const f=await seed(),a=await receive(f),control={failBefore:0},events=new D1TaskEvents(fault(db,control),scope(f)),l=link(f,a.i.observation_id);
    let before=await snapshot();await assert.rejects(events.link(l),{code:'persistence_unknown'});let n=control.count;
    for(let i=1;i<=n;i++){control.failBefore=i;await assert.rejects(events.link(l),{code:'persistence_unknown'});assert.equal(await snapshot(),before);}
    await f.events.link(l);await note(f);const i=input('Interrupt');control.failBefore=0;before=await snapshot();
    await assert.rejects(events.receive(i),{code:'persistence_unknown'});n=control.count;
    for(let k=1;k<=n;k++){control.failBefore=k;await assert.rejects(events.receive(i),{code:'persistence_unknown'});assert.equal(await snapshot(),before);}
    const existing=await f.store.getReceipt(f.p.id,l.idempotency_key),raw=await mutation(f);raw.receipt=existing;
    raw.lifecycle={operation:'receive',input:{...input(),...scope(f),idempotency_key:l.idempotency_key},at:new Date().toISOString()};
    before=await snapshot();assert.equal(await f.store.commit(raw),'conflict');assert.equal(await snapshot(),before);
  });
  await t.test('lost event/link responses replay original receipts without changing watermarks or interruption snapshots',async()=>{
    const f=await seed(),a=await receive(f),l=link(f,a.i.observation_id),c={loseResponse:true,blockReceipt:true};
    await assert.rejects(new D1TaskEvents(fault(db,c),scope(f)).link(l),{code:'persistence_unknown'});
    const recovered=await new D1TaskEvents(db,scope(f)).link(l);assert.equal(recovered.status,'persisted');
    const r=await note(f),i=input('Interrupt'),c2={loseResponse:true,blockReceipt:true};
    await assert.rejects(new D1TaskEvents(fault(db,c2),scope(f)).receive(i),{code:'persistence_unknown'});
    const original=(await status(f)).interruption;await note(f);await f.events.receive(i);
    assert.deepEqual((await status(f)).interruption,original);assert.equal(original.saved_during_event.record_id,r.id);
    assert.equal((await all('SELECT count(*) n FROM event_task_snapshots WHERE project_id=? AND event_id=?',f.p.id,i.observation_id))[0].n,1);
  });
  await t.test('bounded history still returns the last interruption separately and empty event pages never prove no omissions',async()=>{
    const f=await seed(),a=await receive(f);await f.events.link(link(f,a.i.observation_id));const stop=await receive(f,'Interrupt');
    for(let i=0;i<25;i++)await receive(f);const read=await status(f);
    assert.equal(read.events.length,20);assert.equal(read.history_truncated,true);assert.equal(read.interruption.observation_id,stop.i.observation_id);
    const one=await f.events.observations(),two=await f.events.observations(one.next_offset);assert.equal(two.next_offset,null);
    assert.equal(one.items.length+two.items.length,27);
    const empty=await new D1TaskEvents(db,{...scope(f),session_hash:hash('unobserved')}).observations();
    assert.equal(empty.status,'not_observed');assert.equal(empty.missing_record_count,null);assert.equal(empty.completeness,'unknown');
    assert.equal(empty.recording_coverage.unreceived_work_requests,'not_observable');
  });
  await t.test('received ordering is separate from producer time; project event/link caps preserve existing data and reject new retention',async()=>{
    const f=await seed(),anchor=await receive(f);await f.events.link(link(f,anchor.i.observation_id));const latest=await note(f);
    const delayed=await receive(f,'Interrupt',{observed_at:'2000-01-01T00:00:00.000Z'}),read=await status(f);
    assert.equal(read.interruption.observation_id,delayed.i.observation_id);assert.equal(read.interruption.observed_at,'2000-01-01T00:00:00.000Z');
    assert.equal(read.interruption.saved_during_event.record_id,latest.id);assert.notEqual(read.interruption.received_at,read.interruption.observed_at);
    // Capacity fixtures only; not claims of 10,000 real host events or task links.
    const full=await seed(),s=scope(full);
    await db.prepare(`WITH RECURSIVE n(x) AS(VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<99)
      INSERT INTO lifecycle_events(id,project_id,project_key,repository,environment,root_hash,session_hash,turn_hash,event,source,tool_group,observed_at,received_at,payload_hash,association_status)
      SELECT printf('%064x',a.x*100+b.x),?,?,'api','test',?,?,NULL,'PostToolUse',NULL,NULL,?,?,?,'not_linked' FROM n a CROSS JOIN n b`)
      .bind(full.p.id,full.p.key,s.root_hash,s.session_hash,at,at,hash('capacity fixture')).run();
    let before=await snapshot();await assert.rejects(full.events.receive(input()),{code:'event_store_full'});assert.equal(await snapshot(),before);
    const g=await seed(),a=await receive(g),gs=scope(g);
    await db.prepare(`WITH RECURSIVE n(x) AS(VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<99)
      INSERT INTO task_event_links(id,project_id,run_id,repository,environment,root_hash,session_hash,anchor_id,from_seq,linked_at)
      SELECT printf('00000000-0000-4000-8000-%012x',a.x*100+b.x),?,?,'api','test',?,?,?,(SELECT max(seq)+1 FROM lifecycle_events),? FROM n a CROSS JOIN n b`)
      .bind(g.p.id,g.run.id,gs.root_hash,gs.session_hash,a.i.observation_id,at).run();
    await g.store.commit(await mutation(g,{run:{...g.run,state:'completed'}}));
    const other={...g,run:{...g.run,id:randomUUID()}};await g.store.commit(await mutation(other,{run:other.run}));
    before=await snapshot();await assert.rejects(g.events.link(link(other,a.i.observation_id)),{code:'link_store_full'});assert.equal(await snapshot(),before);
    await assert.rejects(f.events.observations(100001),{code:'invalid_input'});
  });

  let actual;
  await t.test('real local collector input is received by D1 without changing live hook settings; synthetic Interrupt is not an actual user button claim',async()=>{
    const f=await seed(),localRoot=realpathSync(mkdtempSync(join(tmpdir(),'skilly-hook-to-d1-'))),path=join(localRoot,'test.sqlite');
    const binding={version:1,key:f.p.key,name:f.p.name,repository:'api',environment:'test'};writeFileSync(join(localRoot,'skilly.project.json'),JSON.stringify(binding));
    const app=openLocal(path,binding,localRoot);t.after(()=>app.close());await app.dispatcher.call('memory_resolve_project',{});
    const emit=event=>{const receipt=recordLifecycle(path,localRoot,{cwd:localRoot,hook_event_name:event,session_id:'synthetic-test-session',tool_name:'Bash'});
      assert.equal(receipt.work_record_saved,false);return readLifecycle(path,binding,localRoot).items.find(x=>x.observation_id===receipt.observation_id);};
    const anchor=emit('PostToolUse'),s={...scope(f),root_hash:hash(localRoot),session_hash:anchor.session_hash};
    const sink=new D1TaskEvents(db,s),normalized=e=>({idempotency_key:randomUUID(),observation_id:e.observation_id,event:e.event,observed_at:e.received_at,
      turn_hash:e.turn_hash,source:e.source,tool_group:e.tool_group});
    const received=await sink.receive(normalized(anchor));assert.equal(received.work_record_saved,false);await sink.link(link(f,anchor.observation_id));
    const saved=await note(f),interrupted=emit('Interrupt');await sink.receive(normalized(interrupted));
    const before=await sink.status(f.run.id);assert.equal(before.interruption.saved_during_event.record_id,saved.id);
    assert.equal(before.interruption.saved_during_event.receipt_confirmed,true);assert.equal(before.authenticity,'not_attested');
    await note(f);actual={f,s,before,interrupted};
  });
  await t.test('fresh binding/workerd restart and a different current session preserve the same interruption point without inheriting its link',async()=>{
    const {f,s,before,interrupted}=actual;
    await mf.dispose();mf=new Miniflare(options);db=await mf.getD1Database('DB');
    const next=await worker({operation:'event-status',scope:s,run_id:f.run.id});
    assert.deepEqual(next.interruption,before.interruption);assert.notEqual(next.last_saved.record_id,next.interruption.saved_during_event.record_id);
    const fork={...s,session_hash:hash('new-explicit-session')};const fresh=new D1TaskEvents(db,fork),read=await fresh.status(f.run.id);
    assert.equal(read.current_session_binding,false);assert.deepEqual(read.interruption,before.interruption);
    await fresh.receive(input('Interrupt'));assert.equal((await fresh.status(f.run.id)).interruption.observation_id,interrupted.observation_id);
  });
});
