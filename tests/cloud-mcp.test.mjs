import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtempSync,realpathSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {Miniflare} from 'miniflare';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {D1AtomicCommitStore} from '../dist/adapters/storage/d1/atomic-store.js';
import {D1AuthPolicies} from '../dist/adapters/storage/d1/auth-policies.js';
import {D1ProjectAccess} from '../dist/adapters/storage/d1/project-access.js';
import {createCloudMcpHandler} from '../dist/transport/mcp/cloud-http.js';
import {d1WorkerModules} from './support/d1-modules.mjs';

const names=['001-atomic-memory.sql','002-work.sql','003-decisions-plans.sql','004-execution-evidence.sql','005-task-events.sql','006-skills.sql','007-feature-discovery.sql','008-project-transfer.sql','009-storage-origins.sql','010-project-access.sql','011-owner-key-lifecycle.sql'];
const all=async(db,q,...v)=>(await db.withSession('first-primary').prepare(q).bind(...v).all()).results;
const value=r=>{assert.equal(r.isError,undefined,JSON.stringify(r));return JSON.parse(r.content[0].text);};
function wrapped(db,{beforeBatch,afterBatch,afterRead}={}){return {withSession(c){const s=db.withSession(c),native=new WeakMap();const wrap=(st,q)=>{const w={bind:(...v)=>wrap(st.bind(...v),q),async all(){const r=await st.all();if(afterRead)await afterRead(q);return r;}};native.set(w,st);return w;};return {prepare:q=>wrap(s.prepare(q),q),async batch(statements){if(beforeBatch)await beforeBatch();const result=await s.batch(statements.map(x=>native.get(x)));if(afterBatch)await afterBatch();return result;}};}};}
const gate=()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};};

test('authenticated MCP over real loopback HTTP and local Worker D1',{timeout:180000},async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'skilly-cloud-mcp-'))),at=Math.floor(Date.now()/1000),issuer='https://skilly-test.cloudflareaccess.com',audience='mcp-test-only';
 const [oldKey,newKey]=await Promise.all(['old','new'].map(async kid=>{const pair=await generateKeyPair('RS256',{modulusLength:2048});return {pair,jwk:{...await exportJWK(pair.publicKey),kid,alg:'RS256',use:'sig'}};}));
 const policy={issuer,audience,keys:[oldKey.jwk],fetched_at:at-10,valid_until:at+3600,max_token_age_seconds:3600};
 const project=randomUUID(),other=randomUUID(),scope={project_id:project,repository:'web',environment:'test'};let mf;const clients=[];
 const bridge=createServer(async(req,res)=>{try{
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>131072){res.writeHead(413).end();return;}chunks.push(chunk);}
  const headers=Object.fromEntries(Object.entries(req.headers).filter(([,v])=>typeof v==='string'));
  const response=await mf.dispatchFetch(new URL(req.url,origin).href,{method:req.method,headers,...(size?{body:Buffer.concat(chunks).toString('utf8')}:{})});
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(503,{'Content-Type':'application/json'}).end('{"error":"local_test_bridge"}');}});
 t.after(async()=>{for(const c of clients)await c.close();bridge.closeAllConnections();await new Promise(resolve=>bridge.close(resolve));if(mf)await mf.dispose();});
 await new Promise(resolve=>bridge.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${bridge.address().port}`,endpoint=`${origin}/v1/projects/${project}/mcp`,config={endpoint,policy_id:'personal-mcp',scope};
 // dispatchFetch restores the public URL but normally retains its internal Host.
 // An explicit upstream restores both, matching the trusted loopback front door.
 const options={...d1WorkerModules(fileURLToPath(new URL('./support/cloud-mcp-worker.mjs',import.meta.url))),compatibilityDate:'2026-07-30',d1Databases:{DB:randomUUID()},d1Persist:join(root,'d1'),bindings:{MCP_CONFIG:config},host:'127.0.0.1',port:0,upstream:origin,outboundService:()=>new Response('outbound disabled',{status:403})};
 mf=new Miniflare(options);let db=await mf.getD1Database('DB');
 for(const name of names){const sql=readFileSync(new URL('../migrations/d1/'+name,import.meta.url),'utf8').replace(/^--[^\n]*$/gm,'').trim().split(/;\s*(?=CREATE\s|INSERT\s|$)/i).filter(Boolean);await db.batch(sql.map(s=>db.prepare(s)));}
 for(const id of [project,other])await new D1AtomicCommitStore(db,id).commit({project:{id,key:'mcp-test-'+id,name:'MCP 테스트 프로젝트',revision:0,created_at:new Date().toISOString()},expected_revision:null,receipt:{scope:id,key:'seed',hash:createHash('sha256').update(id).digest('hex'),result:{test_only:true}}});
 let policies=new D1AuthPolicies(db),access=new D1ProjectAccess(db);await policies.publish('personal-mcp',policy,0);
 const alice={issuer,subject:'alice'},bob={issuer,subject:'bob'},viewer={issuer,subject:'viewer'};
 await access.grant(alice,scope,'owner','active',0);await access.grant(alice,{...scope,repository:'api'},'owner','active',0);await access.grant(bob,{...scope,project_id:other},'owner','active',0);await access.grant(viewer,scope,'viewer','active',0);
 const sign=(key,sub='alice',extra={})=>new SignJWT({type:'app',iss:issuer,sub,aud:[audience],iat:at,exp:at+1800,email:'same-label@example.invalid',role:'owner',...extra}).setProtectedHeader({alg:'RS256',kid:key.jwk.kid}).sign(key.pair.privateKey);
 const jwt=await sign(oldKey),bobJwt=await sign(oldKey,'bob'),viewerJwt=await sign(oldKey,'viewer');
 const initialize={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'local-test',version:'1'}}};
 const headers=token=>({'Content-Type':'application/json',Accept:'application/json, text/event-stream','Mcp-Protocol-Version':'2025-11-25',...(token?{'Cf-Access-Jwt-Assertion':token}:{})});
 const raw=(body=initialize,extra={})=>fetch(extra.url??endpoint,{method:extra.method??'POST',headers:{...headers(jwt),...extra.headers},...(extra.method&&extra.method!=='POST'?{}:{body:typeof body==='string'?body:JSON.stringify(body)}),redirect:'error'});
 const connect=async token=>{const c=new Client({name:'ordinary-work-test',version:'1'});clients.push(c);const transport=new StreamableHTTPClientTransport(new URL(endpoint),{requestInit:{headers:{'Cf-Access-Jwt-Assertion':token}},fetch:async(input,init)=>{const u=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);assert.equal(u.origin,origin);return fetch(input,{...init,redirect:'error'});}});await c.connect(transport);return c;};
 let client,runId,recordId,finish;
 await t.test('authentication and exact project access are required even for initialization and tools/list',async()=>{
  const unauth=await raw(initialize,{headers:{'Cf-Access-Jwt-Assertion':''}});assert.equal(unauth.status,401);assert.equal((await unauth.text()).includes('memory_'),false);
  assert.equal((await raw(initialize,{headers:{'Cf-Access-Jwt-Assertion':bobJwt}})).status,403);
  assert.equal((await raw({jsonrpc:'2.0',id:2,method:'tools/list'},{headers:{'Cf-Access-Jwt-Assertion':'spoofed'}})).status,401);
  assert.equal((await raw(initialize,{url:`${origin}/v1/projects/${other}/mcp`})).status,403);
  assert.equal((await raw(initialize,{headers:{'Cf-Access-Jwt-Assertion':await sign(oldKey,'alice',{aud:['another-app']})}})).status,401);
  assert.equal((await all(db,'SELECT count(*) n FROM runs'))[0].n,0);
 });
 await t.test('SDK initialize, list and ping work with stateless JSON and a fixed project resolver',async()=>{
  client=await connect(jwt);const tools=await client.listTools();assert.equal(tools.tools.length,9);assert.equal(tools.tools.some(x=>x.name==='memory_begin_task'),true);assert.equal(tools.tools.some(x=>x.name==='memory_register_project'),false);
  await client.ping();const resolved=value(await client.callTool({name:'memory_resolve_project',arguments:{}}));assert.equal(resolved.project.id,project);assert.deepEqual(resolved.scope,scope);assert.equal(resolved.claims_verified,false);
  const r=await raw();assert.equal(r.status,200);assert.equal(r.headers.get('mcp-session-id'),null);assert.equal(r.headers.get('Content-Type'),'application/json');assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);
 });
 await t.test('ordinary start/change/finish records use the same idempotent D1 boundary and never invent execution evidence',async()=>{
  const begin={name:'memory_begin_task',arguments:{project_id:project,goal:'MCP 일반 작업 테스트',mode:'change',actor:'Codex',components:[{key:'web',name:'Web'}],idempotency_key:'normal-start'}};
  const started=value(await client.callTool(begin));runId=started.run.id;assert.deepEqual(value(await client.callTool(begin)),started);
  const conflict=await client.callTool({...begin,arguments:{...begin.arguments,goal:'different'}});assert.equal(conflict.isError,true);assert.equal(JSON.parse(conflict.content[0].text).error.code,'idempotency_conflict');
  const note=value(await client.callTool({name:'memory_checkpoint',arguments:{project_id:project,run_id:runId,topic:'ordinary',kind:'change',body:'사람이 읽을 수 있는 테스트 변경 기록입니다.',report:{title:'로컬 테스트 변경',summary:'실제 실행 근거와 구분한 AI 보고입니다.',checks:[{name:'AI가 보고한 검사',result:'passed'}]},idempotency_key:'normal-change'}}));recordId=note.record_id;
  const finishCall={name:'memory_finish_task',arguments:{run_id:runId,summary:'테스트 작업 종료 보고입니다.',outcome:'completed',idempotency_key:'normal-finish'}};finish=value(await client.callTool(finishCall));assert.deepEqual(value(await client.callTool(finishCall)),finish);
  const evidence=value(await client.callTool({name:'memory_get_evidence',arguments:{record_id:recordId}}));assert.equal(evidence.record.body,'사람이 읽을 수 있는 테스트 변경 기록입니다.');assert.equal(evidence.knowledge_status,'unknown');assert.equal(evidence.provenance,'agent_report');assert.equal(evidence.claims_verified,false);assert.equal((await all(db,'SELECT count(*) n FROM executions'))[0].n,0);
 });
 await t.test('another SDK connection recalls the same task, original change and write receipt',async()=>{
  const next=await connect(jwt),tasks=value(await next.callTool({name:'memory_list_tasks',arguments:{query:'MCP 일반 작업'}}));assert.equal(tasks.items[0].id,runId);assert.equal(tasks.items[0].state,'completed');
  const detail=value(await next.callTool({name:'memory_get_task',arguments:{run_id:runId}}));assert.equal(detail.task.id,runId);
  const record=value(await next.callTool({name:'memory_get_evidence',arguments:{record_id:recordId}}));assert.equal(record.record.id,recordId);
  const receipt=value(await next.callTool({name:'memory_get_receipt',arguments:{write_operation:'finish',idempotency_key:'normal-finish'}}));assert.equal(receipt.found,true);assert.equal(receipt.result.record_id,finish.record_id);
  const knowledge=value(await next.callTool({name:'memory_query_current_knowledge',arguments:{}}));assert.equal(knowledge.claims_verified,false);
 });
 await t.test('scope overrides, viewer writes and host-only tools cannot cross the fixed boundary',async()=>{
  for(const args of [{project_id:other},{repository:'api'},{environment:'prod'}]){const r=await client.callTool({name:'memory_list_tasks',arguments:args});assert.equal(r.isError,true);assert.equal(JSON.parse(r.content[0].text).error.code,'access_denied');}
  const v=await connect(viewerJwt);value(await v.callTool({name:'memory_list_tasks',arguments:{}}));const denied=await v.callTool({name:'memory_begin_task',arguments:{goal:'viewer-must-not-write',mode:'change',idempotency_key:'viewer'}});assert.equal(denied.isError,true);
  const missing=value(await v.callTool({name:'memory_get_receipt',arguments:{write_operation:'begin',idempotency_key:'normal-start'}}));assert.equal(missing.found,false);
  for(const name of ['memory_register_project','memory_grant','memory_observe_execution','memory_save_plan','memory_link_task_events']){const r=await client.callTool({name,arguments:{authenticated:true}});assert.equal(r.isError,true);}
  assert.equal((await all(db,"SELECT count(*) n FROM runs WHERE goal='viewer-must-not-write'"))[0].n,0);
 });
 await t.test('an oversized original is preserved when bounded evidence lookup refuses it, and the next small call still works',async()=>{
  const r=value(await client.callTool({name:'memory_begin_task',arguments:{goal:'large-original',mode:'change',idempotency_key:'large-start'}})),body='가'.repeat(16000);
  const note=value(await client.callTool({name:'memory_checkpoint',arguments:{run_id:r.run.id,kind:'note',topic:'large',body,idempotency_key:'large-note'}}));
  assert.equal(value(await client.callTool({name:'memory_get_evidence',arguments:{record_id:note.record_id}})).record.body,body);
  // A retained legacy/host fixture can exceed this transport's 64KiB response budget.
  const oversizedId=randomUUID(),oversized='가'.repeat(30000);
  await db.prepare(`INSERT INTO records(id,project_id,run_id,topic,kind,body,repository,environment,source_fingerprint,observed_at,recorded_at,supersedes,superseded_by,report_origin)
   SELECT ?,project_id,run_id,topic,kind,?,repository,environment,source_fingerprint,observed_at,recorded_at,supersedes,superseded_by,report_origin FROM records WHERE id=?`).bind(oversizedId,oversized,note.record_id).run();
  await assert.rejects(client.callTool({name:'memory_get_evidence',arguments:{record_id:oversizedId}}),{code:413});
  assert.equal((await all(db,'SELECT body FROM records WHERE id=?',oversizedId))[0].body,oversized);assert.equal(value(await client.callTool({name:'memory_resolve_project',arguments:{}})).project.id,project);
  value(await client.callTool({name:'memory_finish_task',arguments:{run_id:r.run.id,summary:'큰 원문 보존 시험 종료',outcome:'completed',idempotency_key:'large-finish'}}));
 });
 await t.test('Origin, Host, method, batch, notification and byte limits are enforced without reflecting headers',async()=>{
  const originResponse=await raw(initialize,{headers:{Origin:'https://attacker.invalid'}});assert.equal(originResponse.status,403);assert.equal((await originResponse.text()).includes('attacker'),false);
  for(const method of ['GET','DELETE'])assert.equal((await raw(initialize,{method})).status,405);
  for(const body of [[initialize,initialize],{jsonrpc:'2.0',method:'notifications/cancelled',params:{requestId:1}},{jsonrpc:'2.0',id:4,method:'resources/list'},{jsonrpc:'2.0',id:5,result:{}}])assert.equal((await raw(body)).status,400);
  for(const h of [{'Mcp-Session-Id':'arbitrary'},{'Last-Event-ID':'arbitrary'}])assert.equal((await raw(initialize,{headers:h})).status,400);
  assert.equal((await raw('x'.repeat(65537))).status,413);
  const r=await createCloudMcpHandler(db,config)(new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:'wrong.invalid'},body:JSON.stringify(initialize)}));assert.equal(r.status,403);assert.equal((await r.text()).includes('wrong.invalid'),false);
 });
 await t.test('revocation during tool reads or just before a write denies data and rolls back the write',async()=>{
  const before=(await all(db,'SELECT revision FROM projects WHERE id=?',project))[0].revision;let once=false;
  const w=wrapped(db,{beforeBatch:async()=>{if(!once){once=true;await access.grant(alice,scope,'owner','revoked',1);}}});
  const call={jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'memory_begin_task',arguments:{goal:'revocation-must-roll-back',mode:'change',idempotency_key:'race'}}};
  const response=await createCloudMcpHandler(w,config)(new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},body:JSON.stringify(call)}));assert.equal(response.status,403);assert.equal((await all(db,'SELECT revision FROM projects WHERE id=?',project))[0].revision,before);assert.equal((await all(db,"SELECT count(*) n FROM runs WHERE goal='revocation-must-roll-back'"))[0].n,0);
  await access.grant(alice,scope,'owner','active',2);once=false;
  const read=wrapped(db,{afterRead:async q=>{if(!once&&q.includes('FROM runs r LEFT JOIN')){once=true;await access.grant(alice,scope,'owner','revoked',3);}}});
  const readResponse=await createCloudMcpHandler(read,config)(new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},body:JSON.stringify({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'memory_list_tasks',arguments:{}}})}));assert.equal(readResponse.status,403);assert.equal((await readResponse.text()).includes('MCP 일반 작업'),false);await access.grant(alice,scope,'owner','active',4);
 });
 await t.test('in-flight requests are bounded and resources are released after completion',async()=>{
  let entered=0,release,ready;const gate=new Promise(r=>release=r),arrived=new Promise(r=>ready=r);
  const blocked={withSession(c){const s=db.withSession(c);const wrap=st=>({bind:(...v)=>wrap(st.bind(...v)),async all(){entered++;if(entered<=16){if(entered===16)ready();await gate;}return st.all();}});return {prepare:q=>wrap(s.prepare(q)),batch:statements=>s.batch(statements)};}};
  const handler=createCloudMcpHandler(blocked,config),make=id=>new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},body:JSON.stringify({...initialize,id})});
  const pending=Array.from({length:16},(_,i)=>handler(make(i)));await arrived;assert.equal((await handler(make(17))).status,429);release();const results=await Promise.all(pending);assert.equal(results.every(r=>r.status===200),true);assert.equal((await handler(make(18))).status,200);
 });
 await t.test('a progressing slow body reaches the absolute deadline even when source cancellation never settles',async()=>{
  let cancelled=false,interval;
  const stream=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));interval=setInterval(()=>c.enqueue(new TextEncoder().encode(' ')),40);},cancel(){cancelled=true;clearInterval(interval);return new Promise(()=>{});}});
  const handler=createCloudMcpHandler(db,{...config,timeout_ms:1000,storage_timeout_ms:800});
  try{
   const r=await handler(new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},body:stream,duplex:'half'}));
   assert.equal(r.status,504);const body=await r.json();assert.equal(body.error.code,'request_timeout');assert.equal(body.delivery.write_dispatch,'not_dispatched');assert.equal(body.delivery.persistence,'not_checked');assert.equal(cancelled,true);
   assert.equal((await raw()).status,200);
  }finally{clearInterval(interval);}
 });
 await t.test('client abort stops body reads, and a previously aborted request starts no D1 call',async()=>{
  const read=gate(),abort=new AbortController();let cancelled=false,reads=0;
  const stream=new ReadableStream({pull(c){c.enqueue(new TextEncoder().encode(' '));read.release();},cancel(){cancelled=true;}},{highWaterMark:0});
  const handler=createCloudMcpHandler(wrapped(db,{afterRead:async()=>{reads++;}}),{...config,timeout_ms:3000,storage_timeout_ms:1000});
  const pending=handler(new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},body:stream,signal:abort.signal,duplex:'half'}));
  await read.promise;abort.abort();const r=await pending;assert.equal(r.status,408);assert.equal((await r.json()).error.code,'request_aborted');assert.equal(cancelled,true);
  const count=reads;const again=await handler(new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},body:JSON.stringify(initialize),signal:abort.signal}));assert.equal(again.status,408);assert.equal(reads,count);
  const next=await connect(jwt);await next.ping();
 });
 await t.test('a stalled D1 read times out without follow-up SQL and reconnects after it settles',async()=>{
  const blocked=gate();let calls=0;
  const handler=createCloudMcpHandler(wrapped(db,{afterRead:async()=>{if(++calls===1)await blocked.promise;}}),{...config,timeout_ms:3000,storage_timeout_ms:300});
  const make=()=>new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},body:JSON.stringify(initialize)});
  try{
   const response=await handler(make());assert.equal(response.status,504);const body=await response.json();assert.equal(body.error.code,'storage_timeout');assert.equal(body.delivery.write_dispatch,'not_dispatched');assert.equal(body.delivery.persistence,'not_checked');assert.equal(calls,1);
  }finally{blocked.release();}
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);assert.equal((await handler(make())).status,200);
 });
 await t.test('timeout before batch submission never writes, including a delayed lookup for an older saved key',async()=>{
  const blocked=gate();let calls=0,batches=0;
  const handler=createCloudMcpHandler(wrapped(db,{afterRead:async q=>{calls++;if(q==='SELECT * FROM projects WHERE id=?')await blocked.promise;},beforeBatch:async()=>{batches++;}}),{...config,timeout_ms:3000,storage_timeout_ms:300});
  const call={jsonrpc:'2.0',id:60,method:'tools/call',params:{name:'memory_begin_task',arguments:{goal:'must-not-write-after-timeout',mode:'change',idempotency_key:'before-batch-timeout'}}};
  let count;
  try{const r=await handler(new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},body:JSON.stringify(call)}));assert.equal(r.status,504);const body=await r.json();assert.equal(body.delivery.write_dispatch,'not_dispatched');assert.equal(body.delivery.persistence,'not_checked');count=calls;}
  finally{blocked.release();}
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,count);assert.equal(batches,0);assert.equal((await all(db,"SELECT count(*) n FROM runs WHERE goal='must-not-write-after-timeout'"))[0].n,0);
  const previous=gate();const reader=createCloudMcpHandler(wrapped(db,{afterRead:async q=>{if(q.includes('FROM receipts'))await previous.promise;}}),{...config,timeout_ms:3000,storage_timeout_ms:300});
  call.params.arguments={goal:'MCP 일반 작업 테스트',mode:'change',actor:'Codex',components:[{key:'web',name:'Web'}],idempotency_key:'normal-start'};
  try{const r=await reader(new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},body:JSON.stringify(call)}));assert.equal(r.status,504);const body=await r.json();assert.equal(body.delivery.persistence,'not_checked');assert.equal(body.delivery.dispatch_scope,'current_request_only');}
  finally{previous.release();}
  const next=await connect(jwt);assert.equal(value(await next.callTool({name:'memory_get_receipt',arguments:{write_operation:'begin',idempotency_key:'normal-start'}})).result.run.id,runId);
 });
 await t.test('a committed batch with a stalled response stays unknown until a new authenticated connection reads its receipt',async()=>{
  const blocked=gate();let calls=0;
  const handler=createCloudMcpHandler(wrapped(db,{afterRead:async()=>{calls++;},afterBatch:async()=>{await blocked.promise;}}),{...config,timeout_ms:3000,storage_timeout_ms:300});
  const args={goal:'stored-before-timeout',mode:'change',idempotency_key:'late-batch-receipt'},call={name:'memory_begin_task',arguments:args};let count;
  try{
   const r=await handler(new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},body:JSON.stringify({jsonrpc:'2.0',id:61,method:'tools/call',params:call})}));assert.equal(r.status,504);const body=await r.json();assert.equal(body.error.code,'storage_timeout');assert.equal(body.delivery.write_dispatch,'dispatched');assert.equal(body.delivery.persistence,'unknown');assert.equal(body.delivery.automatic_replay,false);assert.equal(JSON.stringify(body).includes('stored-before-timeout'),false);count=calls;
   const next=await connect(jwt),receipt=value(await next.callTool({name:'memory_get_receipt',arguments:{write_operation:'begin',idempotency_key:args.idempotency_key}}));assert.equal(receipt.found,true);
   const saved=value(await next.callTool(call));assert.equal(saved.run.id,receipt.result.run.id);assert.equal((await all(db,"SELECT count(*) n FROM runs WHERE goal='stored-before-timeout'"))[0].n,1);
   value(await next.callTool({name:'memory_finish_task',arguments:{run_id:saved.run.id,summary:'응답 지연 시험 종료',outcome:'completed',idempotency_key:'late-batch-finish'}}));
  }finally{blocked.release();}
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,count);
 });
 await t.test('client abort after batch dispatch reports unknown without undoing or repeating a real write',async()=>{
  const blocked=gate(),submitted=gate(),abort=new AbortController();
  const handler=createCloudMcpHandler(wrapped(db,{afterBatch:async()=>{submitted.release();await blocked.promise;}}),{...config,timeout_ms:5000,storage_timeout_ms:3000});
  const call={name:'memory_begin_task',arguments:{goal:'abort-after-dispatch',mode:'change',idempotency_key:'abort-after-dispatch'}};
  const pending=handler(new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},signal:abort.signal,body:JSON.stringify({jsonrpc:'2.0',id:62,method:'tools/call',params:call})}));
  try{
   await submitted.promise;abort.abort();const r=await pending;assert.equal(r.status,408);const body=await r.json();assert.equal(body.error.code,'request_aborted');assert.equal(body.delivery.persistence,'unknown');assert.equal(body.delivery.write_dispatch,'dispatched');
   const next=await connect(jwt),receipt=value(await next.callTool({name:'memory_get_receipt',arguments:{write_operation:'begin',idempotency_key:'abort-after-dispatch'}}));assert.equal(receipt.found,true);assert.equal((await all(db,"SELECT count(*) n FROM runs WHERE goal='abort-after-dispatch'"))[0].n,1);
   value(await next.callTool({name:'memory_finish_task',arguments:{run_id:receipt.result.run.id,summary:'중단 뒤 영수증 확인 시험 종료',outcome:'completed',idempotency_key:'abort-after-finish'}}));
  }finally{blocked.release();}
 });
 await t.test('a late native rejection after timeout is contained and its slot becomes reusable',async()=>{
  const blocked=gate();let calls=0;
  const handler=createCloudMcpHandler(wrapped(db,{afterRead:async()=>{if(++calls===1){await blocked.promise;throw new Error('private-storage-diagnostic');}}}),{...config,timeout_ms:3000,storage_timeout_ms:300});
  const make=()=>new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},body:JSON.stringify(initialize)});
  try{const r=await handler(make());assert.equal(r.status,504);assert.equal((await r.text()).includes('private-storage-diagnostic'),false);}finally{blocked.release();}
  await new Promise(resolve=>setImmediate(resolve));assert.equal((await handler(make())).status,200);
 });
 await t.test('timed-out native calls remain bounded until settlement, without accumulating retries',async()=>{
  const blocked=gate();let calls=0;
  const handler=createCloudMcpHandler(wrapped(db,{afterRead:async()=>{if(++calls<=16)await blocked.promise;}}),{...config,timeout_ms:5000,storage_timeout_ms:600});
  const make=id=>new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},body:JSON.stringify({...initialize,id})});
  try{
   const responses=await Promise.all(Array.from({length:16},(_,id)=>handler(make(id))));assert.equal(responses.every(r=>r.status===504),true);assert.equal(calls,16);
   for(let i=0;i<3;i++){const r=await handler(make(90+i));assert.equal(r.status,503);assert.equal(r.headers.get('Retry-After'),'1');assert.equal((await r.json()).error.code,'storage_busy');}assert.equal(calls,16);
  }finally{blocked.release();}
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,16);assert.equal((await handler(make(100))).status,200);
 });
 await t.test('real SDK HTTP timeout after a Worker D1 commit is recovered by receipt on a new connection',async()=>{
  await mf.dispose();mf=new Miniflare({...options,bindings:{...options.bindings,MCP_CONFIG:{...config,timeout_ms:5000,storage_timeout_ms:250},MCP_TEST_BATCH_DELAY_MS:700}});
  db=await mf.getD1Database('DB');policies=new D1AuthPolicies(db);access=new D1ProjectAccess(db);
  const first=await connect(jwt),call={name:'memory_begin_task',arguments:{goal:'worker-stored-response-timeout',mode:'change',idempotency_key:'worker-late-start'}};
  await assert.rejects(first.callTool(call),{code:504});
  const next=await connect(jwt),receipt=value(await next.callTool({name:'memory_get_receipt',arguments:{write_operation:'begin',idempotency_key:'worker-late-start'}}));assert.equal(receipt.found,true);assert.equal(receipt.result.status,'persisted');assert.equal(receipt.result.claims_verified,false);
  const saved=value(await next.callTool(call));assert.equal(saved.run.id,receipt.result.run.id);assert.equal((await all(db,"SELECT count(*) n FROM runs WHERE goal='worker-stored-response-timeout'"))[0].n,1);
  value(await next.callTool({name:'memory_finish_task',arguments:{run_id:saved.run.id,summary:'Worker 응답 지연 시험 종료',outcome:'completed',idempotency_key:'worker-late-finish'}}));
 });
 await t.test('key retirement blocks existing and new connections; a new valid key and restarted Worker retain the original record',async()=>{
  await policies.revokeKey('personal-mcp','old',1);assert.equal((await raw()).status,503);await assert.rejects(client.listTools());
  await policies.publish('personal-mcp',{...policy,keys:[newKey.jwk]},2);assert.equal((await raw()).status,401);
  const nextJwt=await sign(newKey);await mf.dispose();mf=new Miniflare(options);db=await mf.getD1Database('DB');policies=new D1AuthPolicies(db);access=new D1ProjectAccess(db);
  const next=await connect(nextJwt),record=value(await next.callTool({name:'memory_get_evidence',arguments:{record_id:recordId}}));assert.equal(record.record.id,recordId);assert.equal(record.record.body,'사람이 읽을 수 있는 테스트 변경 기록입니다.');assert.equal(record.claims_verified,false);
 });
});
