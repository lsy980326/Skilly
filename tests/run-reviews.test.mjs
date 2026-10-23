import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, project, run } from './helpers.mjs';
import { SqliteMemoryStore } from '../dist/adapters/storage/sqlite/store.js';
import { SqliteViewer } from '../dist/adapters/storage/sqlite/viewer.js';
import { startViewer } from '../dist/transport/viewer/server.js';
import { backupDatabase, restoreDatabase } from '../dist/adapters/storage/transfer/snapshot.js';
import { exportProject, importProject } from '../dist/adapters/storage/transfer/project.js';

async function completed(f, pid, key) {
  const rid = await run(f.call,pid,{idempotency_key:key});
  await f.call('memory_finish_task',{project_id:pid,run_id:rid,outcome:'completed',summary:key,idempotency_key:key+'-end'});
  const reader = new SqliteViewer(f.path); const row=reader.detail(pid,rid).run;reader.close();return row;
}
test('explicit acknowledgement preserves original work, survives restart, and filters before pagination', async t => {
  const f=fixture(t), pid=await project(f.call), reader=new SqliteViewer(f.path);t.after(()=>reader.close());
  const store=new SqliteMemoryStore(f.path);t.after(()=>store.close());
  const done=[]; for(let i=0;i<43;i++) done.push(await completed(f,pid,'done'+i));
  const all=reader.runs(pid,{state:'completed'}).items;
  const before=reader.detail(pid,all[0].id);
  for(const item of all) store.reviews.acknowledge(pid,item.id,item.updated_at);
  const pending=reader.runs(pid,{state:'completed',unreviewed:true});
  assert.equal(pending.items.length,3,'old unseen work is not hidden behind acknowledged first page');
  assert.equal(reader.projects().items[0].unreviewed_completed,3);
  assert.equal(reader.runs(pid,{state:'completed'}).items.length,40);
  assert.equal(reader.detail(pid,all[0].id).run.state,'completed');
  assert.deepEqual(reader.detail(pid,all[0].id).records,before.records);
  const again=store.reviews.acknowledge(pid,all[0].id,all[0].updated_at);
  assert.equal(again.review.state,'acknowledged');assert.equal(again.claims_verified,false);
  const reopened=new SqliteMemoryStore(f.path);t.after(()=>reopened.close());assert.equal(reopened.reviews.status(pid,all[0].id,all[0].updated_at).state,'acknowledged');
  assert.throws(()=>store.reviews.acknowledge(pid,all[0].id,'2020-01-01T00:00:00Z'),/바뀌었습니다/);
  const other=await project(f.call,'other');assert.throws(()=>store.reviews.acknowledge(other,all[0].id,all[0].updated_at),/찾지 못/);
  const active=await run(f.call,pid,{idempotency_key:'active'});assert.throws(()=>store.reviews.acknowledge(pid,active,all[0].updated_at),/바뀌었습니다/);
});
test('acknowledgements survive full backup and single-project copy',async t=>{
 const f=fixture(t),pid=await project(f.call),r=await completed(f,pid,'roundtrip');const store=new SqliteMemoryStore(f.path);t.after(()=>store.close());store.reviews.acknowledge(pid,r.id,r.updated_at);
 const parent=realpathSync(f.directory),dbPath=realpathSync(f.path); const backup=join(parent,'backup'), restored=join(parent,'restored'), bundle=join(parent,'bundle'), copied=join(parent,'copied');
 await backupDatabase(dbPath,backup); const restoredResult=await restoreDatabase(backup,restored);
 exportProject(dbPath,pid,bundle); const imported=await importProject(bundle,copied);
 for(const path of [restoredResult.db,imported.db]) {const reader=new SqliteViewer(path);assert.equal(reader.runs(pid,{state:'completed',unreviewed:true}).items.length,0);assert.equal(reader.runs(pid,{state:'completed'}).items.length,1);reader.close();}
});
test('acknowledgement POST requires token, same origin and current completed snapshot',async t=>{
 const f=fixture(t),pid=await project(f.call),r=await completed(f,pid,'http');const server=await startViewer({db:f.path});t.after(()=>server.close());
 const token=new URL(server.url).hash.slice('#token='.length), body=JSON.stringify({project_id:pid,run_id:r.id,expected_updated_at:r.updated_at});
 const post=headers=>fetch(server.origin+'/api/runs/acknowledge',{method:'POST',headers:{'Content-Type':'application/json',...headers},body});
 assert.equal((await post({Origin:server.origin})).status,401);
 assert.equal((await post({Authorization:'Bearer '+token})).status,403);
 assert.equal((await post({Authorization:'Bearer '+token,Origin:'https://example.com'})).status,403);
 const result=await post({Authorization:'Bearer '+token,Origin:server.origin});assert.equal(result.status,200);assert.equal((await result.json()).claims_verified,false);
 const again=await post({Authorization:'Bearer '+token,Origin:server.origin});assert.equal(again.status,200);
 assert.equal((await fetch(server.origin+'/api/runs?project='+pid+'&state=completed&review=unread',{headers:{Authorization:'Bearer '+token}}).then(x=>x.json())).items.length,0);
});


test('recent completion window filters before pagination, counts only unread, and expires without changing records',async t=>{
 const f=fixture(t),pid=await project(f.call),other=await project(f.call,'other');
 let now=Date.parse('2026-10-23T10:00:00.000Z');
 const raw=new DatabaseSync(f.path);t.after(()=>raw.close());
 const at=(id,time)=>raw.prepare('UPDATE runs SET updated_at=? WHERE id=?').run(typeof time==='number'?new Date(time).toISOString():time,id);
 const recent=[];for(let i=0;i<43;i++){const r=await completed(f,pid,'recent'+i);recent.push(r);at(r.id,now-1_800_000);}
 const boundary=await completed(f,pid,'boundary');at(boundary.id,now-3_600_000);
 const old=await completed(f,pid,'old');at(old.id,now-3_600_001);
 const future=await completed(f,pid,'future');at(future.id,now+1);
 const invalid=await completed(f,pid,'invalid');at(invalid.id,'invalid');
 const foreign=await completed(f,other,'foreign');at(foreign.id,now-1_800_000);
 await run(f.call,pid,{idempotency_key:'still-active'});
 const store=new SqliteMemoryStore(f.path);t.after(()=>store.close());
 store.reviews.acknowledge(pid,recent[0].id,new Date(now-1_800_000).toISOString());
 const before={runs:raw.prepare('SELECT * FROM runs ORDER BY id').all(),records:raw.prepare('SELECT * FROM records ORDER BY seq').all()};
 const reader=new SqliteViewer(f.path,()=>now);t.after(()=>reader.close());
 const options={state:'completed',unreviewed:true,completedWithinHour:true};
 const first=reader.runs(pid,options),next=reader.runs(pid,{...options,offset:first.next_offset});
 assert.equal(first.filtered_total,43);assert.equal(first.items.length,40);assert.equal(first.next_offset,40);
 assert.equal(next.filtered_total,43);assert.equal(next.items.length,3);assert.equal(next.next_offset,null);
 const ids=[...first.items,...next.items].map(r=>r.id);assert.ok(ids.includes(boundary.id));
 for(const r of [old,future,invalid,foreign,recent[0]])assert.ok(!ids.includes(r.id));
 assert.equal(reader.detail(pid,old.id).run.state,'completed','older history is still available');
 assert.throws(()=>reader.runs(pid,{completedWithinHour:true,state:'active'}),{code:'invalid_input'});
 now+=1_860_000;
 const later=reader.runs(pid,options);assert.equal(later.filtered_total,1);assert.equal(later.items[0].id,future.id);
 now+=3_600_000;assert.equal(reader.runs(pid,options).filtered_total,0);
 assert.deepEqual(raw.prepare('SELECT * FROM runs ORDER BY id').all(),before.runs);
 assert.deepEqual(raw.prepare('SELECT * FROM records ORDER BY seq').all(),before.records);
});

test('recent-completion HTTP query validates window and retains authentication',async t=>{
 const f=fixture(t),pid=await project(f.call);await completed(f,pid,'recent-http');
 const server=await startViewer({db:f.path});t.after(()=>server.close());
 const token=new URL(server.url).hash.slice('#token='.length),headers={Authorization:'Bearer '+token};
 const path=server.origin+'/api/runs?project='+pid+'&state=completed&review=unread&completed_within=1h';
 assert.equal((await fetch(path)).status,401);
 const result=await fetch(path,{headers});assert.equal(result.status,200);const page=await result.json();assert.equal(page.filtered_total,1);assert.equal(page.items.length,1);
 assert.equal((await fetch(path.replace('1h','2h'),{headers})).status,400);
 assert.equal((await fetch(path.replace('state=completed','state=active'),{headers})).status,400);
});
