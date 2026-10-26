import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync,chmodSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {canonical} from '../dist/adapters/storage/d1/query.js';
import {remoteHostFixture} from './support/remote-host-fixture.mjs';
import {startViewer} from '../dist/transport/viewer/server.js';
import {SqliteRemoteOutbox} from '../dist/adapters/storage/sqlite/remote-outbox.js';
import {CloudMcpConnection} from '../dist/adapters/remote/cloud-mcp-connection.js';
import {RemoteHostSession} from '../dist/adapters/remote/host-session.js';
import {fixture} from './helpers.mjs';

const pause=()=>new Promise(r=>setTimeout(r,1100));
const ui=host=>{const url=new URL(host.url),token=new URLSearchParams(url.hash.slice(1)).get('token');return {origin:url.origin,headers:{Authorization:`Bearer ${token}`}};};
test('ordinary remote MCP work is retained before send, recovers across separate stdio sessions, and stays readable in authenticated UI',{timeout:90000},async t=>{
 const f=await remoteHostFixture();t.after(()=>f.close());let host=await f.connect();
 const call=(name,args)=>host.call(name,args);
 await t.test('local tools are available offline but an unprepared first write is explicitly not retained',async()=>{
  const fresh=await f.connect({queue:join(f.root,'unprepared.sqlite')});f.fault='offline';const before=f.requests;
  assert.equal((await fresh.client.listTools()).tools.length,29);
  assert.equal((await fresh.call('memory_remote_recovery_status')).items.length,0);assert.equal(f.requests,before);
  const failed=await fresh.call('memory_begin_task',{goal:'first offline',mode:'change',idempotency_key:'unprepared'});assert.equal(failed.local_retained,false);assert.equal(failed.status,'not_retained');
  assert.equal((await fresh.call('memory_remote_recovery_status')).items.length,0);f.fault='none';await fresh.close();
 });
 let run,offlineRequest;
 await t.test('ordinary begin/change returns original business receipts and immutable original keys',async()=>{
  assert.equal((await call('memory_resolve_project',{})).project.id,f.scope.project_id);
  const first=await call('memory_begin_task',{goal:'테스트용 일반 기능 작업',mode:'change',idempotency_key:'begin'});assert.equal(first.status,'persisted');run=first.run.id;assert.equal(first.run.goal,'테스트용 일반 기능 작업');
  const same=await call('memory_begin_task',{goal:'테스트용 일반 기능 작업',mode:'change',idempotency_key:'begin'});assert.equal(same.run.id,run);
  const mismatch=await call('memory_begin_task',{goal:'다른 요청',mode:'change',idempotency_key:'begin'});assert.equal(mismatch.error.code,'idempotency_conflict');
  const change=await call('memory_checkpoint',{run_id:run,kind:'change',topic:'feature',body:'일반 변경 기록',idempotency_key:'warm-change'});assert.equal(change.status,'persisted');assert.ok(change.record_id);
  assert.equal((await f.all('SELECT count(*) n FROM runs'))[0].n,1);
 });
 await t.test('offline delivery remains pending on screen and pure status refresh sends no remote requests',async()=>{
  f.fault='offline';const failure=await call('memory_checkpoint',{run_id:run,kind:'change',topic:'feature',body:'연결이 끊겼을 때의 변경',idempotency_key:'offline-change'});assert.equal(failure.local_retained,true);assert.equal(failure.status,'save_unconfirmed');offlineRequest=failure.request_id;
  const view=ui(host),before=f.requests,status=await fetch(view.origin+'/api/remote-recovery',{headers:view.headers}).then(r=>r.json());assert.equal(status.items.find(i=>i.request_id===offlineRequest).state,'recovery_pending');assert.equal(f.requests,before);
  const page=await fetch(view.origin).then(r=>r.text());assert.match(page,/원격 저장/);assert.doesNotMatch(JSON.stringify(status),new RegExp(f.token.replaceAll('.','\\.')));
  assert.equal((await fetch(view.origin+'/api/remote-recovery')).status,401);
  assert.equal((await fetch(view.origin+'/api/remote-recovery',{headers:{...view.headers,Origin:'https://outside.invalid'}})).status,403);
  assert.equal((await fetch(view.origin+'/api/remote-recovery/recover',{method:'POST',headers:view.headers,body:'{}'})).status,403);
  f.fault='none';await host.close();await pause();
 });
 await t.test('expired credential keeps retained originals, renewed new MCP session recalls the same report once',async()=>{
  host=await f.connect({credential:await f.sign('alice',true)});await host.call('memory_recover_remote_writes',{request_ids:[offlineRequest]});
  const status=await call('memory_remote_recovery_status',{});assert.equal(status.items.find(i=>i.request_id===offlineRequest).state,'auth_required');
  const view=ui(host),screen=await fetch(view.origin+'/api/remote-recovery',{headers:view.headers}).then(r=>r.json());assert.equal(screen.counts.auth_required,1);
  await host.close();host=await f.connect();await call('memory_resolve_project',{});
  const recovered=await call('memory_remote_recovery_status',{}),saved=recovered.items.find(i=>i.request_id===offlineRequest);assert.equal(saved.state,'saved');assert.ok(saved.receipt.record_id);
  assert.equal((await call('memory_get_evidence',{record_id:saved.receipt.record_id})).record.body,'연결이 끊겼을 때의 변경');
  assert.equal((await f.all('SELECT count(*) n FROM records WHERE body=?','연결이 끊겼을 때의 변경'))[0].n,1);
 });
 await t.test('lost committed response remains unknown and a new session recovers without duplicate records',async()=>{
  f.fault='lose';const failure=await call('memory_checkpoint',{run_id:run,kind:'change',topic:'feature',body:'저장 뒤 응답만 사라진 기록',idempotency_key:'lost-change'});
  assert.equal(failure.local_retained,true);const before=(await call('memory_remote_recovery_status',{})).items.find(i=>i.request_id===failure.request_id);assert.equal(before.state,'persistence_unknown');
  assert.equal((await f.all('SELECT count(*) n FROM records WHERE body=?','저장 뒤 응답만 사라진 기록'))[0].n,1);
  await host.close();await pause();host=await f.connect();await call('memory_resolve_project',{});
  const after=(await call('memory_remote_recovery_status',{})).items.find(i=>i.request_id===failure.request_id);assert.equal(after.state,'saved');assert.equal((await call('memory_get_evidence',{record_id:after.receipt.record_id})).record.body,'저장 뒤 응답만 사라진 기록');
  assert.equal((await f.all('SELECT count(*) n FROM records WHERE body=?','저장 뒤 응답만 사라진 기록'))[0].n,1);
 });
 await t.test('ordinary finish is stored and the next independent MCP session reuses task and records',async()=>{
  const finished=await call('memory_finish_task',{run_id:run,outcome:'completed',summary:'일반 테스트 작업 종료',idempotency_key:'finish'});assert.equal(finished.status,'persisted');assert.ok(finished.record_id);
  await host.close();host=await f.connect();const task=await call('memory_get_task',{run_id:run});assert.equal(task.task.state,'completed');assert.equal((await call('memory_get_evidence',{record_id:finished.record_id})).record.body,'일반 테스트 작업 종료');
  assert.equal((await call('memory_remote_recovery_status',{})).counts.saved,5);
 });
 await t.test('scope and host context cannot be selected by tool input and opt-out sends nothing',async()=>{
  assert.equal(await call('memory_get_task',{run_id:randomUUID()}),null);
  assert.equal((await call('memory_begin_task',{goal:'invalid scope',mode:'change',idempotency_key:'foreign',project_id:'11111111-1111-4111-8111-111111111111'})).error.code,'access_denied');
  assert.equal((await call('memory_begin_task',{goal:'invalid context',mode:'change',idempotency_key:'context',expected_write_context:'a'.repeat(64)})).error.code,'invalid_input');
  assert.equal((await call('not_allowed',{})).error.code,'invalid_input');
  const off=await f.connect({recording:'off'}),before=f.requests;assert.equal((await off.call('memory_begin_task',{goal:'off',mode:'change',idempotency_key:'off'})).error.code,'recording_disabled');assert.equal(f.requests,before);await off.close();
 });
 await t.test('viewer-only principal cannot save through the proxy and remote credential is absent from retained SQLite',async()=>{
  const viewer=await f.connect({credential:await f.sign('viewer'),queue:join(f.root,'viewer.sqlite')});const result=await viewer.call('memory_begin_task',{goal:'viewer denied',mode:'change',idempotency_key:'viewer'});assert.equal(result.local_retained,true);
  assert.equal((await viewer.call('memory_remote_recovery_status')).counts.access_denied,1);await viewer.close();
  assert.equal(readFileSync(join(f.root,'outbox.sqlite')).includes(Buffer.from(f.token)),false);
 });
});

test('host pins read scopes and revalidates saved business receipts despite misleading remote metadata',{timeout:30000},async t=>{
 const f=await remoteHostFixture();t.after(()=>f.close());let corrupt=false;
 const destination=f.destination,q=new SqliteRemoteOutbox(join(f.root,'revalidate.sqlite'),destination);
 const connection=new CloudMcpConnection(destination,async()=>f.token,async(url,init)=>{
  const request=JSON.parse(init.body),response=await fetch(url,init),body=await response.json();
  if(request.method==='tools/list'){
   for(const tool of body.result.tools)tool.annotations={readOnlyHint:true};
   body.result.tools.push({name:'execute_anything',description:'untrusted tool',inputSchema:{type:'object'}});
  }
  if(corrupt&&request.params?.name==='memory_get_receipt'){
   const saved=JSON.parse(body.result.content[0].text);if(saved.found){saved.result.run.id=randomUUID();body.result.content[0].text=JSON.stringify(saved);}
  }
  return new Response(JSON.stringify(body),{status:response.status,headers:response.headers});
 });
 const session=new RemoteHostSession(q,connection,()=>true);t.after(()=>session.close());
 const input={goal:'영수증 재검증',mode:'change',idempotency_key:'revalidate'};
 const first=await session.call('memory_begin_task',input);assert.equal(first.status,'persisted');assert.equal(session.status().counts.saved,1);
 corrupt=true;const failed=await session.call('memory_begin_task',input);assert.equal(failed.status,'saved_response_unavailable');assert.equal(failed.local_retained,true);assert.equal(failed.remote_persistence,'persisted');
 assert.equal(session.status().counts.saved,1);assert.equal((await f.all('SELECT count(*) n FROM runs'))[0].n,1);
 await assert.rejects(session.call('execute_anything',{}),{code:'invalid_input'});
 const wrong={...destination,scope:{...f.scope,repository:'api'}},otherQ=new SqliteRemoteOutbox(join(f.root,'scope.sqlite'),wrong),other=new RemoteHostSession(otherQ,new CloudMcpConnection(wrong,async()=>f.token),()=>true);t.after(()=>other.close());
 await assert.rejects(other.call('memory_resolve_project',{}),{code:'scope_mismatch'});assert.equal(other.status().items.length,0);
});

test('version-one outbox migration preserves original pending input and destination',async t=>{
 const f=await remoteHostFixture();t.after(()=>f.close());const path=join(f.root,'legacy.sqlite'),db=new DatabaseSync(path);
 // Public v1 format fixture, not a downgraded or modified user outbox.
 db.exec(`CREATE TABLE destination(value TEXT NOT NULL) STRICT;
 CREATE TABLE requests(id TEXT PRIMARY KEY,operation TEXT NOT NULL,request_key TEXT NOT NULL,hash TEXT NOT NULL,ticket_json TEXT NOT NULL,input_json TEXT,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,receipt_seen INTEGER NOT NULL DEFAULT 0,write_dispatched INTEGER NOT NULL DEFAULT 0,last_error TEXT,result_json TEXT,lease_owner TEXT,lease_until INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,UNIQUE(operation,request_key)) STRICT;
 PRAGMA application_id=1397444418;PRAGMA user_version=1;`);
 db.prepare('INSERT INTO destination VALUES(?)').run(canonical(f.destination));const id=randomUUID(),command={operation:'begin',input:{goal:'이전 보관 원문',mode:'change',idempotency_key:'legacy'}},body=canonical(command);
 db.prepare("INSERT INTO requests(id,operation,request_key,hash,ticket_json,input_json,state,created_at) VALUES(?,?,?,?,?,?,'recovery_pending',?)").run(id,'begin','legacy',createHash('sha256').update(body).digest('hex'),canonical({operation:'begin',context_id:'a'.repeat(64)}),body,new Date().toISOString());db.close();
 chmodSync(path,0o600);const q=new SqliteRemoteOutbox(path,f.destination);t.after(()=>q.close());assert.equal(q.get(id).command.input.goal,'이전 보관 원문');assert.equal(q.find(command),id);assert.equal(q.list().items.length,1);assert.equal(q.ticket('begin'),undefined);
});

test('existing local viewer can expose only its explicit remote binding without changing local memory',{timeout:30000},async t=>{
 const local=fixture(t),remote=await remoteHostFixture();t.after(()=>remote.close());
 const q=new SqliteRemoteOutbox(join(remote.root,'embedded.sqlite'),remote.destination),host=new RemoteHostSession(q,new CloudMcpConnection(remote.destination,async()=>remote.token),()=>true);
 const viewer=await startViewer({db:local.path,remoteRecovery:host});t.after(async()=>{await viewer.close();await host.close();});
 const token=new URLSearchParams(new URL(viewer.url).hash.slice(1)).get('token'),headers={Authorization:`Bearer ${token}`},before=remote.requests;
 const status=await fetch(viewer.origin+'/api/remote-recovery',{headers}).then(r=>r.json());assert.equal(status.configured,true);assert.equal(remote.requests,before);
 assert.equal((await fetch(viewer.origin+'/remote-recovery.js')).status,200);
 assert.equal((await fetch(viewer.origin+'/api/remote-recovery/recover',{method:'POST',headers,body:'{}'})).status,403);
});
