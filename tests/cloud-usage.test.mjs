import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Miniflare } from 'miniflare';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { D1UsageBudget } from '../dist/adapters/storage/d1/usage-budget.js';
import { D1AtomicCommitStore } from '../dist/adapters/storage/d1/atomic-store.js';
import { D1AuthPolicies } from '../dist/adapters/storage/d1/auth-policies.js';
import { D1ProjectAccess } from '../dist/adapters/storage/d1/project-access.js';
import { createCloudMcpHandler } from '../dist/transport/mcp/cloud-http.js';
import { CloudMcpConnection } from '../dist/adapters/remote/cloud-mcp-connection.js';
import { SqliteRemoteOutbox } from '../dist/adapters/storage/sqlite/remote-outbox.js';
import { RemoteWriteRecovery } from '../dist/core/access/remote-recovery.js';

test('metered MCP and durable recovery on local Worker D1 across new connections',{timeout:120000},async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'skilly-cloud-usage-')));
 const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("local only")}}',compatibilityDate:'2026-07-30',
  d1Databases:{DB:randomUUID()},d1Persist:join(root,'d1'),host:'127.0.0.1',port:0,outboundService:()=>new Response('outbound disabled',{status:403})});
 t.after(()=>mf.dispose());const db=await mf.getD1Database('DB');
 for(const name of ['001-atomic-memory.sql','002-work.sql','003-decisions-plans.sql','004-execution-evidence.sql','005-task-events.sql','006-skills.sql','007-feature-discovery.sql',
  '008-project-transfer.sql','009-storage-origins.sql','010-project-access.sql','011-owner-key-lifecycle.sql','012-usage-budget.sql','013-usage-operations.sql']){
  const sql=readFileSync(new URL('../migrations/d1/'+name,import.meta.url),'utf8').replace(/^--[^\n]*$/gm,'').trim().split(/;\s*(?=CREATE\s|INSERT\s|$)/i).filter(Boolean);
  await db.batch(sql.map(q=>db.prepare(q)));
 }
 const project=randomUUID(),scope={project_id:project,repository:'web',environment:'test'},endpoint=`http://127.0.0.1:49999/v1/projects/${project}/mcp`;
 const epoch=Math.floor(Date.now()/1000),issuer='https://usage-test.cloudflareaccess.com',pair=await generateKeyPair('RS256'),jwk={...await exportJWK(pair.publicKey),kid:'local',alg:'RS256',use:'sig'};
 await new D1AtomicCommitStore(db,project).commit({project:{id:project,key:'usage-test',name:'사용량 시험',revision:0,created_at:new Date().toISOString()},expected_revision:null,
  receipt:{scope:project,key:'seed',hash:createHash('sha256').update(project).digest('hex'),result:{test_only:true}}});
 await new D1AuthPolicies(db).publish('usage-test',{issuer,audience:'usage',keys:[jwk],fetched_at:epoch-10,valid_until:epoch+3600,max_token_age_seconds:3600},0);
 await new D1ProjectAccess(db).grant({issuer,subject:'alice'},scope,'owner','active',0);
 await new D1ProjectAccess(db).grant({issuer,subject:'viewer'},scope,'viewer','active',0);
 const sign=sub=>new SignJWT({type:'app',iss:issuer,sub,aud:['usage'],iat:epoch,exp:epoch+1800}).setProtectedHeader({alg:'RS256',kid:'local'}).sign(pair.privateKey);
 const token=await sign('alice'),foreign=await sign('foreign'),config={endpoint,scope,policy_id:'usage-test',storage_identity:'usage-test-d1',usage_protection:true};
 let handler=createCloudMcpHandler(db,config),requests=0;
 const fetcher=async(url,init)=>{assert.equal(String(url),endpoint);requests++;const headers=new Headers(init.headers);headers.set('Host',new URL(endpoint).host);return handler(new Request(url,{...init,headers}));};
 // Parallel workerd fixtures share CPU; this is a correctness flow, not a latency limit test.
 // The delayed-commit case below still enforces its explicit storage deadline.
 const connection=(credential=token)=>new CloudMcpConnection({endpoint,scope},async()=>credential,fetcher,15000);
 await assert.rejects(connection().initialize(),{code:'remote_unavailable'});
 const budget=new D1UsageBudget(db),policy={daily:{requests:200,batches:1000,rows_read:300000,rows_written:3000},
  user_daily:{requests:100,batches:1000,rows_read:300000,rows_written:3000},request:{batches:8,statements:256,rows_read:100000,rows_written:1000},accepted_write_bytes:2000000};
 await budget.install(policy);
 await assert.rejects(connection('').initialize(),{code:'authentication_required'});
 await assert.rejects(connection(foreign).initialize(),{code:'access_denied'});
 const c=connection();await c.initialize();assert.equal((await c.listTools()).length,27);
 const viewer=connection(await sign('viewer')),beforeViewer=(await budget.snapshot()).storage[0].accepted_write_bytes;
 await viewer.initialize();await assert.rejects(viewer.call('memory_begin_task',{goal:'viewer must not consume write budget',mode:'change',idempotency_key:'viewer-denied'}),{code:'access_denied'});
 assert.equal((await budget.snapshot()).storage[0].accepted_write_bytes,beforeViewer);
 const start=await c.call('memory_begin_task',{goal:'일반 작업 수집 시험',mode:'change',idempotency_key:'normal-start'}),run=start.run.id;
 const change=await c.call('memory_checkpoint',{run_id:run,kind:'change',topic:'usage',body:'원본 작업 변경 보고',report:{title:'일반 변경',summary:'AI 보고이며 직접 검사가 아닙니다.'},idempotency_key:'normal-change'});
 await c.call('memory_finish_task',{run_id:run,summary:'일반 작업 종료',outcome:'completed',idempotency_key:'normal-finish'});
 handler=createCloudMcpHandler(db,config);assert.equal((await connection().call('memory_get_evidence',{record_id:change.record_id})).record.body,'원본 작업 변경 보고');
 // This fault happens after a real business commit, not during quota accounting.
 let release,reach;const gate=new Promise(r=>release=r),reached=new Promise(r=>reach=r);
 t.after(()=>release());
 const delayed={withSession(constraint){const s=db.withSession(constraint),native=new WeakMap(),sql=new WeakMap();
  const wrap=(st,q)=>{const item={bind:(...v)=>wrap(st.bind(...v),q),all:()=>st.all()};native.set(item,st);sql.set(item,q);return item;};
  return {prepare:q=>wrap(s.prepare(q),q),async batch(statements){const business=statements.some(st=>sql.get(st)?.startsWith('UPDATE projects SET revision'));
   const result=await s.batch(statements.map(st=>native.get(st)));if(business){reach();await gate;}return result;}};}};
 handler=createCloudMcpHandler(delayed,{...config,timeout_ms:10000,storage_timeout_ms:250});
 const late=fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','Cf-Access-Jwt-Assertion':token},
  body:JSON.stringify({jsonrpc:'2.0',id:900,method:'tools/call',params:{name:'memory_begin_task',arguments:{goal:'지연 응답 보존',mode:'change',idempotency_key:'late-original'}}})});
 await Promise.race([reached,late.then(async response=>{throw new Error(`Request ended before delayed business commit: ${response.status} ${await response.clone().text()}`);})]);
 const timeout=await late;assert.equal(timeout.status,504);assert.equal((await timeout.json()).delivery.persistence,'unknown');
 const heldLate=(await budget.snapshot()).reservations.find(r=>r.state==='held');assert.ok(heldLate);release();
 let settled=false;for(let n=0;n<100;n++){if((await budget.snapshot()).reservations.find(r=>r.id===heldLate.id)?.state==='settled'){settled=true;break;}await new Promise(r=>setTimeout(r,10));}
 assert.equal(settled,true);handler=createCloudMcpHandler(db,config);
 const lateReceipt=await connection().call('memory_get_receipt',{write_operation:'begin',idempotency_key:'late-original'});assert.equal(lateReceipt.found,true);
 assert.equal((await db.prepare("SELECT count(*) n FROM runs WHERE goal='지연 응답 보존'").all()).results[0].n,1);
 const q=new SqliteRemoteOutbox(join(root,'outbox.sqlite'),{endpoint,scope});t.after(()=>q.close());let clock=Date.now();
 const recovery=()=>new RemoteWriteRecovery(q,connection(),()=>true,()=>clock),command={operation:'begin',input:{goal:'한도 복구 원본 작업',mode:'change',idempotency_key:'recover-original'}};
 const ticket=await recovery().prepare('begin'),id=recovery().enqueue(command,ticket).request_id;
 const held=[];for(let i=0;i<5;i++){try{held.push(await budget.reserve());}catch(e){assert.equal(e.code,'usage_limit');break;}}
 assert.ok(held.length>=1);assert.ok(held.length<5);
 const before=await db.prepare('SELECT count(*) n FROM runs').all();
 await recovery().recover([id]);let item=q.list().items.find(x=>x.request_id===id);
 assert.equal(item.state,'recovery_pending');assert.equal(item.last_error,'rate_limited');assert.ok(item.next_attempt_at-clock>60000);
 assert.equal((await db.prepare('SELECT count(*) n FROM runs').all()).results[0].n,before.results[0].n);
 const previous=requests;await recovery().recover([id]);assert.equal(requests,previous);
 await Promise.all(held.map(r=>r.finish()));clock=item.next_attempt_at+1;
 handler=createCloudMcpHandler(db,config);await recovery().recover([id]);item=q.list().items.find(x=>x.request_id===id);
 assert.equal(item.state,'saved');const savedRun=item.receipt.run_id;
 const next=connection();assert.equal((await next.call('memory_get_task',{run_id:savedRun})).task.goal,command.input.goal);
 assert.equal((await next.call('memory_begin_task',command.input)).run.id,savedRun);
 assert.equal((await db.prepare('SELECT count(*) n FROM runs WHERE goal=?').bind(command.input.goal).all()).results[0].n,1);
 assert.equal((await next.call('memory_get_evidence',{record_id:change.record_id})).claims_verified,false);
 const state=await budget.snapshot();assert.ok(state.reservations.some(r=>r.state==='settled'));assert.equal(state.reservations.some(r=>r.state==='uncertain'),false);
 const noMeta={withSession(c){const s=db.withSession(c),native=new WeakMap();const wrap=(st,q)=>{const item={bind:(...v)=>wrap(st.bind(...v),q),async all(){const r=await st.all();
  return q.startsWith('SELECT version,state,valid_until,entry_json FROM cloud_auth_versions')?{...r,meta:{changes:r.meta.changes}}:r;}};native.set(item,st);return item;};
  return {prepare:q=>wrap(s.prepare(q),q),batch:st=>s.batch(st.map(x=>native.get(x)))};}};
 handler=createCloudMcpHandler(noMeta,config);
 const missing=await fetcher(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','Cf-Access-Jwt-Assertion':token},body:JSON.stringify({jsonrpc:'2.0',id:901,method:'ping'})});
 assert.equal(missing.status,503);assert.equal((await missing.json()).error.code,'usage_measurement_unknown');assert.ok(missing.headers.get('Retry-After'));
});
