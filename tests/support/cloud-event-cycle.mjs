import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {CloudEventReceiver} from '../../dist/adapters/storage/d1/cloud-task-events.js';
import {D1AccessAuthenticator} from '../../dist/adapters/auth/d1-access.js';
import {D1ProjectAccess} from '../../dist/adapters/storage/d1/project-access.js';
import {cloudWriteKey} from '../../dist/adapters/storage/d1/cloud-work.js';
import {createCloudMcpHandler} from '../../dist/transport/mcp/cloud-http.js';
import {MemoryError} from '../../dist/core/memory/model.js';
import {createCloudHandler} from '../../dist/transport/cloud/server.js';

/** Received host-event fixtures through real local D1 and SDK HTTP; NOT a physical Codex interrupt. */
export async function cloudEventCycle(t,f){
 const {scope,alice,issuer,endpoint,config,jwt,bobJwt,viewerJwt,client,connect,headers,all,value,callError,wrapped}=f;
 const hash=x=>createHash('sha256').update(x).digest('hex'),root=hash('remote-host-root'),sessionA=hash('remote-session-a'),sessionB=hash('remote-session-b');
 let context={root_hash:root,session_hash:sessionA,observation_id:null},runId,anchor,linkRequest,linked,before,after,interruption;
 const db=()=>f.db(),eventScope=()=>({...scope,root_hash:context.root_hash,session_hash:context.session_hash});
 const authenticate=(token=jwt)=>new D1AccessAuthenticator(db(),'personal-mcp').authenticate(new Request(endpoint,{headers:headers(token)}));
 const receiver=(database=db(),auth=()=>authenticate(),s=eventScope())=>new CloudEventReceiver(database,s,auth);
 const event=(name='PostToolUse',extra={})=>({observation_id:randomUUID(),event:name,observed_at:new Date().toISOString(),idempotency_key:randomUUID(),...extra});
 const deliver=async(name='PostToolUse',extra={})=>{const input=event(name,extra),receipt=await receiver().receive(input);return {input,receipt};};
 const setContext=async next=>{context=next;await f.setContexts({alice:context,viewer:context});};
 const state=async(c=client)=>value(await c.callTool({name:'memory_get_status',arguments:{run_id:runId}})).task_recording;
 const checkpoint=async key=>value(await client.callTool({name:'memory_checkpoint',arguments:{run_id:runId,kind:'change',topic:'event-cycle',body:'테스트용 저장 지점 '+key,idempotency_key:'event-point-'+key}}));
 const request=(name,args)=>new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},body:JSON.stringify({jsonrpc:'2.0',id:99,method:'tools/call',params:{name,arguments:args}})});
 const grantVersion=async()=>Number((await all(db(),'SELECT max(version) v FROM cloud_project_access WHERE issuer=? AND subject=? AND project_id=? AND repository=? AND environment=?',issuer,'alice',scope.project_id,scope.repository,scope.environment))[0].v);

 await t.test('missing host event context is unsupported capability, while ordinary MCP work stays connected',async()=>{
  runId=value(await client.callTool({name:'memory_begin_task',arguments:{goal:'호스트 이벤트 연결 테스트',mode:'change',idempotency_key:'event-task-start'}})).run.id;
  assert.equal(value(await client.callTool({name:'memory_resolve_project',arguments:{}})).lifecycle_context.status,'not_configured');
  for(const [name,args] of [['memory_get_status',{run_id:runId}],['memory_list_task_events',{}],['memory_link_task_events',{run_id:runId,observation_id:randomUUID(),idempotency_key:'missing-context'}]])await callError(client,name,args,'unsupported_capability');
  assert.equal(value(await client.callTool({name:'memory_get_task',arguments:{run_id:runId}})).task.id,runId);
  const http=createCloudHandler(db(),new D1AccessAuthenticator(db(),'personal-mcp'));
  const response=await http(new Request(endpoint.replace(/\/mcp$/,'/memory'),{method:'POST',headers:headers(jwt),body:JSON.stringify({repository:scope.repository,environment:scope.environment,command:{operation:'event-status',input:{run_id:runId}}})}));
  assert.equal(response.status,501);assert.equal((await response.json()).error.code,'unsupported_capability');
 });
 await t.test('received event metadata is separate from work receipts and only future events link to the exact task',async()=>{
  const old=await deliver('Interrupt'),fresh=await deliver('SessionStart',{source:'startup'});anchor=fresh.input.observation_id;
  assert.equal(fresh.receipt.delivery_status,'saved');assert.equal(fresh.receipt.work_record_saved,false);assert.equal(fresh.receipt.claims_verified,false);
  await setContext({...context,observation_id:anchor});
  const resolved=value(await (await connect(jwt)).callTool({name:'memory_resolve_project',arguments:{}}));assert.equal(resolved.lifecycle_context.current_observation_id,anchor);
  linkRequest={run_id:runId,observation_id:anchor,idempotency_key:'explicit-event-link'};
  linked=value(await client.callTool({name:'memory_link_task_events',arguments:linkRequest}));assert.equal(linked.status,'persisted');
  assert.equal((await state()).events.length,0);assert.equal((await state()).current_session_binding,true);
  before=await checkpoint('before-interrupt');
  const stop=await deliver('Interrupt',{observed_at:'2026-10-20T00:00:00.000Z'});assert.equal(stop.receipt.work_record_saved,false);
  const read=await state();interruption=read.interruption;
  assert.equal(interruption.observation_id,stop.input.observation_id);assert.equal(interruption.saved_during_event.record_id,before.record_id);assert.equal(interruption.saved_during_event.receipt_confirmed,true);
  assert.equal(read.task_state,'active');assert.equal(read.completeness,'unknown');assert.equal(read.missing_record_count,null);assert.equal(read.live_execution,'unknown');assert.equal(read.authenticity,'not_attested');
  assert.equal(read.events.some(x=>x.observation_id===old.input.observation_id),false);
  await setContext({...context,observation_id:null});
 });
 await t.test('a fresh MCP connection distinguishes the frozen interruption snapshot from a later saved checkpoint',async()=>{
  after=await checkpoint('after-reconnect');const next=await connect(jwt),read=await state(next);
  assert.equal(read.last_saved.record_id,after.record_id);assert.deepEqual(read.interruption,interruption);
  assert.equal(read.interruption.saved_during_event.record_id,before.record_id);assert.equal(read.last_saved.receipt_confirmed,true);
  assert.deepEqual(value(await next.callTool({name:'memory_link_task_events',arguments:linkRequest})),linked);
  await callError(next,'memory_link_task_events',{...linkRequest,idempotency_key:'not-a-saved-replay'},'stale_anchor');
  const receipt=value(await next.callTool({name:'memory_get_receipt',arguments:{write_operation:'event-link',idempotency_key:linkRequest.idempotency_key}}));assert.equal(receipt.result.link_id,linked.link_id);
 });
 await t.test('a new host session sees same-root task history, but its event list and link receipts stay session-bound',async()=>{
  context={root_hash:root,session_hash:sessionB,observation_id:null};const resume=await deliver('SessionStart',{source:'resume'});await setContext({...context,observation_id:resume.input.observation_id});
  const next=await connect(jwt),read=await state(next);assert.equal(read.current_session_binding,false);assert.deepEqual(read.interruption,interruption);
  const list=value(await next.callTool({name:'memory_list_task_events',arguments:{}}));assert.equal(list.items.length,1);assert.equal(list.items[0].observation_id,resume.input.observation_id);assert.equal(list.work_record_saved,false);
  assert.equal(value(await next.callTool({name:'memory_get_receipt',arguments:{write_operation:'event-link',idempotency_key:linkRequest.idempotency_key}})).found,false);
  await callError(next,'memory_link_task_events',{...linkRequest,idempotency_key:'wrong-session-anchor'},'stale_anchor');
  const bound=value(await next.callTool({name:'memory_link_task_events',arguments:{...linkRequest,observation_id:resume.input.observation_id}}));assert.notEqual(bound.link_id,linked.link_id);
  await deliver('PostToolUse',{tool_group:'shell'});await deliver('Interrupt');const resumed=await state(next);
  assert.equal(resumed.interruption.saved_during_event.record_id,after.record_id);assert.equal(resumed.current_session_binding,true);
  assert.ok(resumed.events.some(x=>x.observation_id===interruption.observation_id));interruption=resumed.interruption;
 });
 await t.test('clients cannot create lifecycle observations or choose host session, root, anchor and another active task',async()=>{
  for(const name of ['memory_receive_task_event','memory_receive_event'])await callError(client,name,{event:'Interrupt'},'invalid_input');
  for(const extra of [{root_hash:hash('forged')},{session_hash:sessionA},{event:'Interrupt'},{observed_at:new Date().toISOString()}])await callError(client,'memory_list_task_events',extra,'invalid_input');
  await callError(client,'memory_checkpoint',{run_id:runId,topic:'events',kind:'note',body:'위조',idempotency_key:'forged-event',lifecycle:{event:'Interrupt'}},'invalid_input');
  const current=await deliver();await setContext({...context,observation_id:current.input.observation_id});
  const otherRun=value(await client.callTool({name:'memory_begin_task',arguments:{goal:'링크 탈취 거절 테스트',mode:'change',idempotency_key:'event-takeover-task'}})).run.id;
  await callError(client,'memory_link_task_events',{run_id:otherRun,observation_id:current.input.observation_id,idempotency_key:'takeover-link'},'link_conflict');
  value(await client.callTool({name:'memory_finish_task',arguments:{run_id:otherRun,summary:'링크 탈취 거절 확인',outcome:'completed',idempotency_key:'event-takeover-finish'}}));
  await callError(client,'memory_link_task_events',{run_id:runId,observation_id:randomUUID(),idempotency_key:'invented-anchor'},'stale_anchor');
  await callError(client,'memory_get_status',{run_id:randomUUID()},'not_found');
 });
 await t.test('event reads, links and host receives enforce authentication, exact project and viewer permissions',async()=>{
  for(const token of ['',bobJwt]){
   const response=await fetch(endpoint,{method:'POST',headers:headers(token),body:JSON.stringify({jsonrpc:'2.0',id:90,method:'tools/call',params:{name:'memory_get_status',arguments:{run_id:runId}}})});assert.equal(response.status,token?403:401);assert.equal((await response.text()).includes(after.record_id),false);
   await assert.rejects(receiver(db(),()=>authenticate(token)).receive(event()),e=>[401,403].includes(e.status));
  }
  const viewer=await connect(viewerJwt);assert.equal((await state(viewer)).last_saved.record_id,after.record_id);
  assert.equal(value(await viewer.callTool({name:'memory_list_task_events',arguments:{}})).status,'observations_available');
  await callError(viewer,'memory_link_task_events',{run_id:runId,observation_id:context.observation_id,idempotency_key:'viewer-link'},'access_denied');
  await assert.rejects(receiver(db(),()=>authenticate(viewerJwt)).receive(event()),{status:403});
  assert.equal(value(await viewer.callTool({name:'memory_get_receipt',arguments:{write_operation:'event-link',idempotency_key:linkRequest.idempotency_key}})).found,false);
  for(const extra of [{project_id:randomUUID()},{repository:'api'},{environment:'production'}])await callError(client,'memory_get_status',{run_id:runId,...extra},'access_denied');
  const stable=receiver();await stable.receive(event());
  let token=jwt;const changed=receiver(db(),()=>authenticate(token));await changed.receive(event());token=viewerJwt;await assert.rejects(changed.receive(event()),{code:'scope_mismatch'});
 });
 await t.test('event/link receipts deduplicate without backfill and remain isolated by full root/session scope',async()=>{
  const receiverA=receiver(),input=event('PostToolUse'),first=await receiverA.receive(input);assert.deepEqual(await receiverA.receive(input),first);
  await assert.rejects(receiverA.receive({...input,event:'Stop'}),{code:'idempotency_conflict'});
  await assert.rejects(receiverA.receive({...input,event:'Stop',idempotency_key:randomUUID()}),{code:'event_conflict'});
  const receipt=value(await (await connect(jwt)).callTool({name:'memory_get_receipt',arguments:{write_operation:'event-receive',idempotency_key:input.idempotency_key}}));assert.equal(receipt.result.observation_id,input.observation_id);
  const original=context;await setContext({...context,root_hash:hash('different-host-root')});assert.equal((await state()).interruption,null);
  assert.equal(value(await client.callTool({name:'memory_get_receipt',arguments:{write_operation:'event-receive',idempotency_key:input.idempotency_key}})).found,false);await setContext(original);
  for(const extra of [{prompt:'not accepted'},{root_hash:hash('arbitrary')},{session_hash:sessionA},{project_id:randomUUID()}])await assert.rejects(receiver().receive({...event(),...extra}));
 });
 await t.test('permission revocation at event receive/link commit and during status read exposes no partial state',async()=>{
  let access=new D1ProjectAccess(db()),version=await grantVersion(),count=(await all(db(),'SELECT count(*) n FROM lifecycle_events'))[0].n;
  const blocked=wrapped(db(),{beforeBatch:()=>access.grant(alice,scope,'owner','revoked',version)});
  try{await assert.rejects(receiver(blocked).receive(event('Interrupt')),{status:403});assert.equal((await all(db(),'SELECT count(*) n FROM lifecycle_events'))[0].n,count);}
  finally{await access.grant(alice,scope,'owner','active',version+1);}
  version=await grantVersion();const rows=(await all(db(),'SELECT count(*) n FROM receipts'))[0].n;
  const handler=createCloudMcpHandler(wrapped(db(),{beforeBatch:()=>access.grant(alice,scope,'owner','revoked',version)}),config,undefined,()=>context);
  try{assert.equal((await handler(request('memory_link_task_events',{run_id:runId,observation_id:context.observation_id,idempotency_key:'guarded-link'}))).status,403);assert.equal((await all(db(),'SELECT count(*) n FROM receipts'))[0].n,rows);}
  finally{await access.grant(alice,scope,'owner','active',version+1);}
  version=await grantVersion();let once=false;
  const reader=createCloudMcpHandler(wrapped(db(),{afterRead:async sql=>{if(!once&&sql.includes('FROM runs r CROSS JOIN')){once=true;await access.grant(alice,scope,'owner','revoked',version);}}}),config,undefined,()=>context);
  try{const response=await reader(request('memory_get_status',{run_id:runId}));assert.equal(response.status,403);assert.equal((await response.text()).includes(after.record_id),false);}
  finally{await access.grant(alice,scope,'owner','active',version+1);}
 });
 await t.test('lost committed event and link responses recover their original receipts, never a guessed work save',async()=>{
  const input=event('PostToolUse'),lost=wrapped(db(),{afterBatch:()=>{throw new MemoryError('persistence_unknown','test response lost');}});
  await assert.rejects(receiver(lost).receive(input),{code:'persistence_unknown'});
  const saved=await receiver().receipt(input.idempotency_key);assert.equal(saved.found,true);assert.equal(saved.result.work_record_saved,false);assert.deepEqual(await receiver().receive(input),saved.result);
  await setContext({...context,observation_id:input.observation_id});
  // setContexts restarts the Worker; build a fault binding from its CURRENT D1 proxy.
  const lostLink=wrapped(db(),{afterBatch:()=>{throw new MemoryError('persistence_unknown','test response lost');}});
  const args={run_id:runId,observation_id:input.observation_id,idempotency_key:'lost-link-response'},handler=createCloudMcpHandler(lostLink,config,undefined,()=>context);
  const response=await handler(request('memory_link_task_events',args)),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(JSON.parse(body.result.content[0].text).error.code,'persistence_unknown');
  const next=await connect(jwt),receipt=value(await next.callTool({name:'memory_get_receipt',arguments:{write_operation:'event-link',idempotency_key:args.idempotency_key}}));assert.equal(receipt.found,true);
  assert.deepEqual(value(await next.callTool({name:'memory_link_task_events',arguments:args})),receipt.result);assert.equal((await state(next)).task_state,'active');
 });
 await t.test('a stored event receipt with a wrong session is refused by lookup and identical link replay',async()=>{
  const args={run_id:runId,observation_id:context.observation_id,idempotency_key:'event-scope-check'};
  value(await client.callTool({name:'memory_link_task_events',arguments:args}));
  const key=await cloudWriteKey(alice,eventScope(),'event-link',args.idempotency_key);
  const [saved]=await all(db(),'SELECT result_json FROM receipts WHERE scope=? AND idempotency_key=?',scope.project_id,key);
  const result=JSON.parse(saved.result_json);result.scope.session_hash=sessionA;
  await db().prepare('UPDATE receipts SET result_json=? WHERE scope=? AND idempotency_key=?').bind(JSON.stringify(result),scope.project_id,key).run();
  await callError(client,'memory_get_receipt',{write_operation:'event-link',idempotency_key:args.idempotency_key},'scope_mismatch');
  await callError(client,'memory_link_task_events',args,'scope_mismatch');
 });
 return {runId,lastRecordId:after.record_id,interruption};
}
