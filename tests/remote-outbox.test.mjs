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
import {DatabaseSync} from 'node:sqlite';
import {D1AtomicCommitStore} from '../dist/adapters/storage/d1/atomic-store.js';
import {D1AuthPolicies} from '../dist/adapters/storage/d1/auth-policies.js';
import {D1ProjectAccess} from '../dist/adapters/storage/d1/project-access.js';
import {SqliteRemoteOutbox} from '../dist/adapters/storage/sqlite/remote-outbox.js';
import {CloudMcpConnection} from '../dist/adapters/remote/cloud-mcp-connection.js';
import {RemoteWriteRecovery} from '../dist/core/access/remote-recovery.js';
import {remoteWriteTools} from '../dist/core/access/remote-outbox.js';
import {d1WorkerModules} from './support/d1-modules.mjs';

test('durable remote outbox against actual local HTTP Worker D1',{timeout:120000},async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'skilly-outbox-'))),project=randomUUID(),other=randomUUID(),scope={project_id:project,repository:'web',environment:'test'};
 const epoch=Math.floor(Date.now()/1000),issuer='https://outbox-test.cloudflareaccess.com',pair=await generateKeyPair('RS256'),jwk={...await exportJWK(pair.publicKey),kid:'test',alg:'RS256',use:'sig'};
 let mf,db,token,enabled=true,clock=Date.now(),offline=false,loseWrite=false,stopAfterReceipt=false,requests=0;
 const bridge=createServer(async(req,res)=>{try{const chunks=[];for await(const c of req)chunks.push(c);
  const result=await mf.dispatchFetch(new URL(req.url,origin).href,{method:req.method,headers:req.headers,body:Buffer.concat(chunks)});
  res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
 }catch{res.writeHead(503).end();}});
 await new Promise(r=>bridge.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${bridge.address().port}`,endpoint=`${origin}/v1/projects/${project}/mcp`,destination={endpoint,scope};
 const config={endpoint,policy_id:'outbox-test',scope,storage_identity:'test-store'};
 const hash=s=>createHash('sha256').update(s).digest('hex'),context={root_hash:hash(root),session_hash:hash('session')};
 const options={...d1WorkerModules(fileURLToPath(new URL('./support/cloud-mcp-worker.mjs',import.meta.url))),compatibilityDate:'2026-07-30',d1Databases:{DB:randomUUID()},d1Persist:join(root,'d1'),
  bindings:{MCP_CONFIG:config,MCP_TEST_EVENT_CONTEXTS:{alice:context},MCP_TEST_SKILL_CONTEXTS:{alice:{root_hash:context.root_hash}}},host:'127.0.0.1',port:0,upstream:origin,outboundService:()=>new Response('outbound forbidden',{status:403})};
 mf=new Miniflare(options);db=await mf.getD1Database('DB');const queues=[];
 t.after(async()=>{for(const q of queues)q.close();bridge.closeAllConnections();await new Promise(r=>bridge.close(r));await mf.dispose();});
 const all=async(q,...v)=>(await db.withSession('first-primary').prepare(q).bind(...v).all()).results;
 for(const name of ['001-atomic-memory.sql','002-work.sql','003-decisions-plans.sql','004-execution-evidence.sql','005-task-events.sql','006-skills.sql','007-feature-discovery.sql','008-project-transfer.sql','009-storage-origins.sql','010-project-access.sql','011-owner-key-lifecycle.sql']){
  const sql=readFileSync(new URL('../migrations/d1/'+name,import.meta.url),'utf8').replace(/^--[^\n]*$/gm,'').trim().split(/;\s*(?=CREATE\s|INSERT\s|$)/i).filter(Boolean);await db.batch(sql.map(s=>db.prepare(s)));
 }
 for(const id of [project,other])await new D1AtomicCommitStore(db,id).commit({project:{id,key:'outbox-'+id,name:'테스트 프로젝트',revision:0,created_at:new Date().toISOString()},expected_revision:null,receipt:{scope:id,key:'seed',hash:hash(id),result:{test_only:true}}});
 await new D1AuthPolicies(db).publish('outbox-test',{issuer,audience:'outbox',keys:[jwk],fetched_at:epoch-10,valid_until:epoch+3600,max_token_age_seconds:3600},0);
 const access=new D1ProjectAccess(db);for(const [subject,role,p]of [['alice','owner',project],['second','editor',project],['viewer','viewer',project],['foreign','owner',other]])await access.grant({issuer,subject},{...scope,project_id:p},role,'active',0);
 const sign=(subject='alice',expired=false)=>new SignJWT({type:'app',iss:issuer,sub:subject,aud:['outbox'],iat:epoch-10,exp:expired?epoch-1:epoch+1800}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(pair.privateKey);
 token=await sign();const valid=token;
 const fetcher=async(url,init)=>{assert.equal(new URL(url).origin,origin);assert.equal(init.redirect,'error');requests++;if(offline)throw Error('synthetic disconnect');
  const message=JSON.parse(init.body),name=message.params?.name,result=await fetch(url,init);
  if(stopAfterReceipt&&name==='memory_get_receipt'){stopAfterReceipt=false;enabled=false;}
  if(loseWrite&&Object.values(remoteWriteTools).includes(name)){loseWrite=false;await result.arrayBuffer();throw Error('response lost after actual D1 save');}return result;
 };
 const connection=()=>new CloudMcpConnection(destination,async()=>token,fetcher,3000);
 const queue=()=>{const q=new SqliteRemoteOutbox(join(root,randomUUID()+'.sqlite'),destination);queues.push(q);return q;};
 const recovery=q=>new RemoteWriteRecovery(q,connection(),()=>enabled,()=>clock);
 const begin=(key=randomUUID())=>({operation:'begin',input:{goal:'원격 대기 테스트 '+key,mode:'change',idempotency_key:key}});
 const status=(q,id)=>q.list().items.find(i=>i.request_id===id);
 const change=(run_id,key=randomUUID())=>({operation:'checkpoint',input:{run_id,kind:'change',topic:'outbox',body:'사람이 읽는 원본 변경 기록',report:{title:'변경 보고',summary:'실제 실행 관측은 없는 AI 보고입니다.'},idempotency_key:key}});
 const resetWorker=async()=>{await mf.setOptions(options);db=await mf.getD1Database('DB');};
 let normalRun;
 await t.test('no explicit storage identity means unsupported retry tickets while legacy calls remain connected',async()=>{
  delete config.storage_identity;await resetWorker();
  await assert.rejects(recovery(queue()).prepare('begin'),{code:'unsupported_capability'});
  assert.equal((await connection().call('memory_resolve_project',{})).project.id,project);
  config.storage_identity='test-store';await resetWorker();
 });
 await t.test('offline retention is durable, bounded and separate from remote saves; new connections recover exactly once',async()=>{
  const q=queue(),r=recovery(q),ticket=await r.prepare('begin'),command=begin('offline'),retained=r.enqueue(command,ticket),id=retained.request_id;
  assert.equal(retained.state,'recovery_pending');assert.equal(retained.remote_saved,false);assert.equal(retained.local_retained,true);
  assert.equal((await all('SELECT count(*) n FROM runs'))[0].n,0);
  offline=true;await r.recover();assert.equal(status(q,id).state,'recovery_pending');assert.equal(status(q,id).original_input_retained,true);
  offline=false;clock+=2000;await recovery(q).recover();const saved=status(q,id);normalRun=saved.receipt.run_id;
  assert.equal(saved.state,'saved');assert.equal(saved.original_input_retained,false);assert.equal(saved.remote_persistence,'persisted');assert.equal(saved.claims_verified,false);
  assert.equal(r.enqueue(command,ticket).request_id,id);await r.recover([id]);assert.equal((await all('SELECT count(*) n FROM runs'))[0].n,1);
  assert.throws(()=>r.enqueue({...command,input:{...command.input,goal:'다른 원문'}},ticket),{code:'idempotency_conflict'});
 });
 await t.test('lost committed replies remain unknown across local reopen, expired auth blocks, renewed auth reuses the same report',async()=>{
  const path=join(root,'reopen.sqlite');let q=new SqliteRemoteOutbox(path,destination),r=recovery(q);const ticket=await r.prepare('checkpoint'),command=change(normalRun,'lost-change'),id=r.enqueue(command,ticket).request_id;
  loseWrite=true;await r.recover([id]);assert.equal(status(q,id).state,'persistence_unknown');assert.equal((await all('SELECT count(*) n FROM records WHERE run_id=?',normalRun))[0].n,1);
  q.close();q=new SqliteRemoteOutbox(path,destination);queues.push(q);r=recovery(q);token=await sign('alice',true);clock+=2000;
  await r.recover([id]);assert.equal(status(q,id).state,'auth_required');assert.equal(status(q,id).remote_persistence,'unknown');assert.equal(status(q,id).original_input_retained,true);
  token=valid;await recovery(q).recover([id]);assert.equal(status(q,id).state,'saved');assert.equal((await all('SELECT count(*) n FROM records WHERE run_id=?',normalRun))[0].n,1);
  assert.equal((await connection().call('memory_get_evidence',{record_id:status(q,id).receipt.record_id})).record.body,command.input.body);
 });
 await t.test('begin, plan, skill and finish requests use the same durable path without inventing execution observations',async()=>{
  const q=queue(),r=recovery(q);
  const commands=[{operation:'save-plan',input:{run_id:normalRun,plan_key:'outbox-plan',expected_version:0,title:'재연결 계획',source_kind:'markdown',source_ref:'selected.md',source_body:'- [ ] 남은 항목\n',idempotency_key:'outbox-plan'}},
   {operation:'skill-register',input:{project_id:project,skill_key:'outbox-skill',version:'1',source:'local:test',name:'테스트 스킬',body:'# 테스트\n',install_instructions:'자동 실행하지 않음',idempotency_key:'outbox-skill'}},
   {operation:'skill-assign',input:{skill_key:'outbox-skill',version:'1',tool:'codex',folder:'outbox-skill',expected_assignment_id:null,idempotency_key:'outbox-assign'}},
   {operation:'skill-checkpoint',input:{run_id:normalRun,kind:'note',topic:'skills',body:'사용했다고 보고',skill_usage:[{skill_key:'outbox-skill',version:'1',purpose:'안내 참고'}],idempotency_key:'outbox-use'}},
   {operation:'finish',input:{run_id:normalRun,summary:'시험 종료',outcome:'completed',idempotency_key:'outbox-finish'}}];
  for(const command of commands){const ticket=await r.prepare(command.operation),result=await r.submit(command,ticket);assert.equal(result.results[0].state,'saved');}
  assert.equal((await connection().call('memory_query_plans',{plan_key:'outbox-plan'})).progress.remaining,1);
  assert.equal((await connection().call('memory_list_task_skills',{run_id:normalRun})).items[0].file_observation_status,'not_collected');
  assert.equal((await all('SELECT count(*) n FROM executions'))[0].n,0);
 });
 await t.test('a receipt for the same key but different payload never confirms this request or overwrites originals',async()=>{
  const q=queue(),r=recovery(q),command=begin('collision'),ticket=await r.prepare('begin');
  const first=await connection().call('memory_begin_task',{...command.input,...scope});
  const id=r.enqueue({...command,input:{...command.input,goal:'같은 키의 다른 요청'}},ticket).request_id;await r.recover([id]);
  assert.equal(status(q,id).state,'blocked');assert.equal(status(q,id).receipt_seen,true);assert.equal(status(q,id).remote_saved,false);assert.equal(status(q,id).last_error,'idempotency_conflict');
  assert.equal((await connection().call('memory_get_task',{run_id:first.run.id})).task.goal,command.input.goal);
 });
 await t.test('principal, project, viewer and revoked access cannot deliver retained writes; original requests stay intact',async()=>{
  for(const subject of ['second','foreign','viewer']){
   const q=queue(),r=recovery(q),ticket=await r.prepare('begin'),command=begin(subject),id=r.enqueue(command,ticket).request_id;
   token=await sign(subject);await r.recover([id]);const blocked=status(q,id);assert.equal(blocked.state,subject==='foreign'?'access_denied':'blocked');assert.equal(blocked.original_input_retained,true);
   assert.equal((await all('SELECT count(*) n FROM runs WHERE goal=?',command.input.goal))[0].n,0);token=valid;
  }
 });
 await t.test('viewer-owned tickets and revoked grants still cannot write, while restored access can recover originals',async()=>{
  token=await sign('viewer');const q=queue(),r=recovery(q),ticket=await r.prepare('begin'),command=begin('viewer-owned'),id=r.enqueue(command,ticket).request_id;
  await r.recover([id]);assert.equal(status(q,id).state,'access_denied');assert.equal(status(q,id).original_input_retained,true);token=valid;
  const own=queue(),rr=recovery(own),tt=await rr.prepare('begin'),cmd=begin('revoked'),rid=rr.enqueue(cmd,tt).request_id;
  await new D1ProjectAccess(db).grant({issuer,subject:'alice'},scope,'owner','revoked',1);
  await rr.recover([rid]);assert.equal(status(own,rid).state,'access_denied');assert.equal((await all('SELECT count(*) n FROM runs WHERE goal=?',cmd.input.goal))[0].n,0);
  await new D1ProjectAccess(db).grant({issuer,subject:'alice'},scope,'owner','active',2);
  await recovery(own).recover([rid]);assert.equal(status(own,rid).state,'saved');
 });
 await t.test('storage identity, actual D1 identity and host roots/sessions cannot silently redirect queued requests',async()=>{
  for(const kind of ['storage','native-store','root','session']){
   const q=queue(),r=recovery(q),operation=kind==='root'?'skill-register':kind==='session'?'event-link':'begin',ticket=await r.prepare(operation);
   const command=operation==='begin'?begin(kind):operation==='event-link'?{operation,input:{run_id:normalRun,observation_id:randomUUID(),idempotency_key:kind}}
    :{operation,input:{project_id:project,skill_key:'never-root',version:'1',source:'local:test',name:'차단',body:'not saved',install_instructions:'no',idempotency_key:kind}};
   const id=r.enqueue(command,ticket).request_id;let oldIdentity;
   if(kind==='storage')config.storage_identity='another-store';
   if(kind==='native-store'){oldIdentity=(await all('SELECT id FROM d1_store_identity'))[0].id;await db.prepare('UPDATE d1_store_identity SET id=?').bind('a'.repeat(32)).run();}
   if(kind==='root')options.bindings.MCP_TEST_SKILL_CONTEXTS.alice={root_hash:hash('another-root')};
   if(kind==='session')options.bindings.MCP_TEST_EVENT_CONTEXTS.alice={...context,session_hash:hash('another-session')};
   await resetWorker();await r.recover([id]);assert.equal(status(q,id).last_error,'write_context_changed');assert.equal(status(q,id).original_input_retained,true);
   config.storage_identity='test-store';options.bindings.MCP_TEST_SKILL_CONTEXTS.alice={root_hash:context.root_hash};options.bindings.MCP_TEST_EVENT_CONTEXTS.alice=context;
   if(kind==='native-store')await db.prepare('UPDATE d1_store_identity SET id=?').bind(oldIdentity).run();await resetWorker();
  }
 });
 await t.test('concurrent recoveries and a crash between dispatch and acknowledgement preserve one original remote write',async()=>{
  const q=queue(),r=recovery(q),ticket=await r.prepare('begin'),command=begin('concurrent'),id=r.enqueue(command,ticket).request_id;
  await Promise.all([r.recover([id]),recovery(q).recover([id])]);assert.equal(status(q,id).state,'saved');assert.equal((await all('SELECT count(*) n FROM runs WHERE goal=?',command.input.goal))[0].n,1);
  const crashed=begin('crashed'),crashId=r.enqueue(crashed,ticket).request_id;
  assert.equal(q.claim(crashId,'dead-process',clock),true);q.dispatch(crashId,'dead-process');clock+=120001;
  await recovery(q).recover([crashId]);assert.equal(status(q,crashId).state,'saved');assert.equal(q.settle(crashId,'dead-process','blocked','old-failure',0,false),false);
 });
 await t.test('local acknowledgement failure stays unknown and is recovered without another record',async()=>{
  const q=queue(),r=recovery(q),ticket=await r.prepare('begin'),command=begin('ack-fail'),id=r.enqueue(command,ticket).request_id,settle=q.settle.bind(q);
  q.settle=(...args)=>{if(args[2]==='saved')throw Error('synthetic local ack disk failure');return settle(...args);};
  await r.recover([id]);assert.equal(status(q,id).state,'persistence_unknown');q.settle=settle;clock+=2000;
  await recovery(q).recover([id]);assert.equal(status(q,id).state,'saved');assert.equal((await all('SELECT count(*) n FROM runs WHERE goal=?',command.input.goal))[0].n,1);
 });
 await t.test('opt-out before recovery and between receipt lookup and write sends no write and preserves pending payload',async()=>{
  const q=queue(),r=recovery(q),ticket=await r.prepare('begin'),command=begin('disabled'),id=r.enqueue(command,ticket).request_id,before=requests;
  enabled=false;await assert.rejects(r.recover([id]),{code:'recording_disabled'});assert.equal(requests,before);enabled=true;
  stopAfterReceipt=true;await r.recover([id]);assert.equal(status(q,id).state,'recovery_pending');assert.equal(status(q,id).attempts,0);assert.equal((await all('SELECT count(*) n FROM runs WHERE goal=?',command.input.goal))[0].n,0);enabled=true;
 });
 await t.test('incomplete or wrong-scope business receipts preserve original input until a valid replay confirms it',async()=>{
  for(const shape of ['missing','wrong-scope','bad-id']){
   const q=queue(),r=recovery(q),ticket=await r.prepare('begin'),command=begin('receipt-'+shape),id=r.enqueue(command,ticket).request_id;
   const corrupt=new CloudMcpConnection(destination,async()=>valid,async(url,init)=>{
    const response=await fetcher(url,init);if(JSON.parse(init.body).params?.name!=='memory_begin_task')return response;
    const raw=await response.json(),value=JSON.parse(raw.result.content[0].text);
    if(shape==='missing')raw.result.content[0].text=JSON.stringify({status:'persisted'});
    if(shape==='wrong-scope'){value.scope.project_id=other;raw.result.content[0].text=JSON.stringify(value);}
    if(shape==='bad-id'){value.run.id='invalid';raw.result.content[0].text=JSON.stringify(value);}
    return Response.json(raw);
   });
   await new RemoteWriteRecovery(q,corrupt,()=>true,()=>clock).recover([id]);
   assert.equal(status(q,id).state,'persistence_unknown');assert.equal(status(q,id).original_input_retained,true);clock+=2000;
   await r.recover([id]);assert.equal(status(q,id).state,'saved');assert.equal((await all('SELECT count(*) n FROM runs WHERE goal=?',command.input.goal))[0].n,1);
  }
 });
 await t.test('expired leases reject late writers and immutable public destination objects reject whole-property replacement',async()=>{
  const q=queue(),r=recovery(q),ticket=await r.prepare('begin'),command=begin('lease-cas'),id=r.enqueue(command,ticket).request_id;
  assert.equal(q.claim(id,'old',clock),true);q.dispatch(id,'old');clock+=120001;assert.equal(q.claim(id,'new',clock),true);
  assert.equal(q.settle(id,'new','auth_required','authentication_required',0,false),true);
  assert.equal(q.settle(id,'old','blocked','late-error',0,false),false);assert.equal(status(q,id).state,'auth_required');assert.equal(status(q,id).remote_persistence,'unknown');
  const c=connection();assert.throws(()=>{c.destination={...destination,endpoint:'https://outside.invalid/'};},TypeError);
  assert.throws(()=>{c.destination.endpoint='https://outside.invalid/';},TypeError);assert.throws(()=>{q.destination.scope.project_id=other;},TypeError);
  assert.throws(()=>{q.destination={...destination};},TypeError);
 });
 await t.test('recovery cycle deadline also bounds credential acquisition and prevents a late credential from dispatching',async()=>{
  const q=queue(),r=recovery(q),ticket=await r.prepare('begin'),id=r.enqueue(begin('cycle-deadline'),ticket).request_id,before=requests;
  let release;const delayed=new CloudMcpConnection(destination,()=>new Promise(resolve=>{release=resolve;}),fetcher,30000);
  const started=performance.now();await new RemoteWriteRecovery(q,delayed,()=>true,()=>clock,25).recover([id]);
  assert.ok(performance.now()-started<1000);assert.equal(status(q,id).state,'recovery_pending');assert.equal(requests,before);
  release(valid);await new Promise(resolve=>setTimeout(resolve,20));assert.equal(requests,before);
 });
 await t.test('changed writer generation blocks old queue contexts while newly bound generation remains explicit',async()=>{
  const q=queue(),r=recovery(q),ticket=await r.prepare('begin'),id=r.enqueue(begin('generation'),ticket).request_id;
  await db.prepare("INSERT INTO d1_project_authority VALUES(?,?,?,?,?,?,?,?,?)").bind(project,'outbox-'+project,randomUUID(),1,'target','writable',1,null,new Date().toISOString()).run();
  await r.recover([id]);assert.equal(status(q,id).last_error,'project_write_blocked');
  options.bindings.MCP_TEST_WRITE_GENERATION=1;await resetWorker();const next=await recovery(queue()).prepare('begin');assert.notEqual(next.context_id,ticket.context_id);
  const pending=queue(),retry=recovery(pending),rid=retry.enqueue(begin('old-generation-ticket'),ticket).request_id;
  await retry.recover([rid]);assert.equal(status(pending,rid).last_error,'write_context_changed');assert.equal(status(pending,rid).original_input_retained,true);
 });
 await t.test('queue capacity, changed inputs and foreign databases refuse retention without deletion or remote calls',async()=>{
  const q=queue(),r=recovery(q),ticket=await r.prepare('begin'),before=requests;
  for(let n=0;n<100;n++)r.enqueue(begin('capacity-'+n),ticket);
  assert.throws(()=>r.enqueue(begin('over-capacity'),ticket),{code:'outbox_full'});assert.equal(requests,before);assert.equal(q.list().items.length,20);assert.equal(q.list().next_offset,20);
  assert.throws(()=>new SqliteRemoteOutbox(join(root,'d1'),destination));
  const path=join(root,'foreign.sqlite'),database=new DatabaseSync(path);database.exec('CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES(\'keep\');');database.close();
  assert.throws(()=>new SqliteRemoteOutbox(path,destination));const read=new DatabaseSync(path,{readOnly:true});assert.equal(read.prepare('SELECT value FROM preserved').get().value,'keep');read.close();
 });
});

test('fixed MCP connection bounds credential hangs, response bytes, deadlines and unresolved calls without leaking tokens',async()=>{
 const destination={endpoint:'http://127.0.0.1:65530/v1/projects/11111111-1111-4111-8111-111111111111/mcp',scope:{project_id:'11111111-1111-4111-8111-111111111111',repository:'web',environment:'test'}};
 let calls=0;const stuck=new CloudMcpConnection(destination,()=>new Promise(()=>{}),async()=>{calls++;throw Error('never');},25);
 for(let n=0;n<4;n++)await assert.rejects(stuck.initialize(),{code:'connection_timeout'});
 await assert.rejects(stuck.initialize(),{code:'connection_busy'});assert.equal(calls,0);
 const huge=new CloudMcpConnection(destination,async()=> 'test-token',async()=>new Response('x'.repeat(65537),{headers:{'Content-Type':'application/json'}}),25);
 await assert.rejects(huge.initialize(),{code:'resource_limit'});
 const stream=new CloudMcpConnection(destination,async()=> 'test-token',async()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}}),{headers:{'Content-Type':'application/json'}}),25);
 await assert.rejects(stream.initialize(),{code:'connection_timeout'});
 assert.throws(()=>new CloudMcpConnection({...destination,endpoint:'http://example.invalid/v1/projects/'+destination.scope.project_id+'/mcp'},async()=>undefined),/endpoint/);
});
