import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {Miniflare} from 'miniflare';
import {D1AtomicCommitStore} from '../dist/adapters/storage/d1/atomic-store.js';
import {D1ProjectAccess} from '../dist/adapters/storage/d1/project-access.js';
import {CloudflareAccessAuthenticator} from '../dist/adapters/auth/cloudflare-access.js';
import {createCloudHandler} from '../dist/transport/cloud/server.js';
import {d1WorkerModules} from './support/d1-modules.mjs';

const names=['001-atomic-memory.sql','002-work.sql','003-decisions-plans.sql','004-execution-evidence.sql','005-task-events.sql','006-skills.sql','007-feature-discovery.sql','008-project-transfer.sql','009-storage-origins.sql','010-project-access.sql'];
const issuer='https://skilly-test.cloudflareaccess.com',audience='local-cloud-test-only',hash=s=>createHash('sha256').update(s).digest('hex');
const all=async(db,q,...v)=>(await db.withSession('first-primary').prepare(q).bind(...v).all()).results;
function intercepted(db,onRead,onBatch,afterBatch){return {withSession(c){const s=db.withSession(c),native=new WeakMap();const wrap=(st,q)=>{const w={bind(...v){return wrap(st.bind(...v),q);},async all(){const r=await st.all();if(onRead)await onRead(q);return r;}};native.set(w,st);return w;};return {prepare:q=>wrap(s.prepare(q),q),async batch(statements){if(onBatch)await onBatch();const r=await s.batch(statements.map(x=>native.get(x)));if(afterBatch)await afterBatch();return r;}};}};}

test('signed local Worker requests enforce project access, ordinary records and fresh connections',{timeout:150000},async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'skilly-cloud-access-'))),pair=await generateKeyPair('RS256',{modulusLength:2048}),at=Math.floor(Date.now()/1000),publicKey={...await exportJWK(pair.publicKey),kid:'local-rsa',alg:'RS256',use:'sig'};
 const policy={issuer,audience,keys:[publicKey],fetched_at:at-10,valid_until:at+3600,max_token_age_seconds:3600};
 const options={...d1WorkerModules(fileURLToPath(new URL('./support/cloud-access-worker.mjs',import.meta.url))),compatibilityDate:'2026-07-30',d1Databases:{DB:randomUUID(),EMPTY:randomUUID()},d1Persist:join(root,'d1'),bindings:{PUBLIC_AUTH_POLICY:policy},host:'127.0.0.1',port:0,outboundService:()=>new Response('outbound disabled',{status:403})};
 let mf=new Miniflare(options);t.after(()=>mf.dispose());let db=await mf.getD1Database('DB');
 for(const name of names){const sql=readFileSync(new URL('../migrations/d1/'+name,import.meta.url),'utf8').replace(/^--[^\n]*$/gm,'').trim().split(/;\s*(?=CREATE\s|INSERT\s|$)/i).filter(Boolean);await db.batch(sql.map(s=>db.prepare(s)));}
 const pA=randomUUID(),pB=randomUUID();
 for(const [id,key] of [[pA,'alice-project'],[pB,'bob-project']])await new D1AtomicCommitStore(db,id).commit({project:{id,key,name:'시험 프로젝트 '+key,revision:0,created_at:new Date().toISOString()},expected_revision:null,receipt:{scope:id,key:'host-seed',hash:hash('host-seed'),result:{fixture:true}}});
 const scope={project_id:pA,repository:'web',environment:'test'},other={project_id:pB,repository:'web',environment:'test'},alice={issuer,subject:'alice'},bob={issuer,subject:'bob'},viewer={issuer,subject:'viewer'};
 let access=new D1ProjectAccess(db);await access.grant(alice,scope,'owner','active',0);await access.grant(bob,other,'owner','active',0);await access.grant(viewer,scope,'viewer','active',0);
 const token=subject=>new SignJWT({type:'app',iss:issuer,sub:subject,aud:[audience],iat:at,nbf:at,exp:at+1800,role:'owner',email:'same-untrusted-label@example.invalid'}).setProtectedHeader({alg:'RS256',kid:'local-rsa'}).sign(pair.privateKey);
 const jwtA=await token('alice'),jwtB=await token('bob'),jwtV=await token('viewer');
 const req=(s,jwt,command,extra={})=>new Request(`http://localhost/v1/projects/${s.project_id}/memory`,{method:'POST',headers:{'Content-Type':'application/json',...(jwt?{'Cf-Access-Jwt-Assertion':jwt}:{})},body:JSON.stringify({repository:s.repository,environment:s.environment,command,...extra})});
 const dispatch=async request=>mf.dispatchFetch(request.url,{method:request.method,headers:Object.fromEntries(request.headers),body:await request.text()});
 const send=async(s,jwt,command,status=200,extra={})=>{const r=await dispatch(req(s,jwt,command,extra));const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);return value;};
 const tasks={operation:'tasks',input:{}};let runA,recordA,runB;
 await t.test('missing/invalid assertions and cross-project or repo/env grants are denied',async()=>{
  await send(scope,null,tasks,401);await send(scope,'spoofed',tasks,401);await send(other,jwtA,tasks,403);await send({...scope,project_id:randomUUID()},jwtA,tasks,403);
  await send({...scope,repository:'api'},jwtA,tasks,403);await send({...scope,environment:'prod'},jwtA,tasks,403);
  await send(scope,jwtA,tasks,400,{authenticated:true,role:'owner'});assert.equal((await all(db,'SELECT count(*) n FROM runs'))[0].n,0);
 });
 await t.test('ordinary start/checkpoint/finish preserves AI reports without trusted observations',async()=>{
  const command={operation:'begin',input:{goal:'인증 시험 일반 작업',mode:'change',title:'로컬 시험',actor:'Codex',idempotency_key:'same-key',components:[{key:'web',name:'Web'}]}};
  const a=await send(scope,jwtA,command);runA=a.run.id;assert.equal(a.claims_verified,false);assert.deepEqual((await send(scope,jwtA,command)),a);
  await send(scope,jwtA,{...command,input:{...command.input,goal:'changed'}},409);
  runB=(await send(other,jwtB,command)).run.id;assert.notEqual(runA,runB);
  recordA=(await send(scope,jwtA,{operation:'checkpoint',input:{run_id:runA,kind:'change',topic:'access',body:'AI가 보고한 작업 결과',idempotency_key:'check',report:{title:'시험 보고',summary:'내용은 검증하지 않은 보고입니다.',checks:[{name:'AI 보고만 있는 검사',result:'passed'}]}}})).record_id;
  const detail=await send(scope,jwtA,{operation:'record',input:{record_id:recordA}});assert.equal(detail.knowledge_status,'unknown');assert.equal(detail.provenance,'agent_report');assert.equal(detail.claims_verified,false);assert.equal((await all(db,'SELECT count(*) n FROM executions'))[0].n,0);
  const finish={operation:'finish',input:{run_id:runA,summary:'완료했다고 보고',outcome:'completed',idempotency_key:'finish'}};const f=await send(scope,jwtA,finish);assert.deepEqual(await send(scope,jwtA,finish),f);
  assert.equal((await send(scope,jwtA,{operation:'receipt',input:{write_operation:'finish',idempotency_key:'finish'}})).found,true);
 });
 await t.test('viewer cannot write and foreign IDs or raw receipts cannot cross scope',async()=>{
  assert.equal((await send(scope,jwtV,tasks)).items.length,1);await send(scope,jwtV,{operation:'begin',input:{goal:'forbidden',mode:'change',idempotency_key:'viewer'}},403);
  assert.equal(await send(scope,jwtA,{operation:'task',input:{run_id:runB}}),null);
  assert.equal((await send(scope,jwtV,{operation:'receipt',input:{write_operation:'begin',idempotency_key:'same-key'}})).found,false);
  await access.grant(alice,{...scope,repository:'api'},'owner','active',0);assert.equal((await send({...scope,repository:'api'},jwtA,{operation:'receipt',input:{write_operation:'begin',idempotency_key:'same-key'}})).found,false);
  assert.equal(await send({...scope,repository:'api'},jwtA,{operation:'record',input:{record_id:recordA}}),null);
  const api=await send({...scope,repository:'api'},jwtA,{operation:'begin',input:{goal:'별도 저장소',mode:'change',idempotency_key:'same-key'}});assert.notEqual(api.run.id,runA);
 });
 await t.test('host-only operations and malformed/oversized input are not accepted',async()=>{
  for(const operation of ['commit','execution-start','event-receive','grant','import','transfer-activate','skill-check'])await send(scope,jwtA,{operation,input:{project_id:pB,authenticated:true}},400);
  const r=await dispatch(new Request(`http://localhost/v1/projects/${pA}/memory`,{method:'POST',headers:{'Content-Type':'application/json','Cf-Access-Jwt-Assertion':jwtA},body:'x'.repeat(65537)}));assert.equal(r.status,413);
  const context=await send(scope,jwtA,{operation:'context',input:{}});assert.equal(context.claims_verified,false);
 });
 await t.test('restarted workerd sees the same access policy, record and finish receipt',async()=>{
  await mf.dispose();mf=new Miniflare(options);db=await mf.getD1Database('DB');access=new D1ProjectAccess(db);
  const d=await send(scope,jwtA,{operation:'record',input:{record_id:recordA}});assert.equal(d.record.body,'AI가 보고한 작업 결과');assert.equal((await send(scope,jwtA,{operation:'receipt',input:{write_operation:'finish',idempotency_key:'finish'}})).found,true);
 });
 await t.test('revocation between authorization and batch rolls back the complete write',async()=>{
  const before=(await all(db,'SELECT revision FROM projects WHERE id=?',pA))[0].revision,records=(await all(db,'SELECT count(*) n FROM records'))[0].n;let once=false;
  const guarded=intercepted(db,null,async()=>{if(!once){once=true;await access.grant(alice,scope,'owner','revoked',1);}}),handler=createCloudHandler(guarded,new CloudflareAccessAuthenticator(policy));
  const r=await handler(req(scope,jwtA,{operation:'begin',input:{goal:'must roll back',mode:'change',idempotency_key:'race'}}));assert.equal(r.status,403);assert.equal((await all(db,'SELECT revision FROM projects WHERE id=?',pA))[0].revision,before);assert.equal((await all(db,'SELECT count(*) n FROM records'))[0].n,records);assert.equal((await all(db,'SELECT count(*) n FROM runs WHERE goal=?','must roll back'))[0].n,0);
  await send(scope,jwtA,tasks,403);await access.grant(alice,scope,'owner','active',2);assert.equal((await send(scope,jwtA,tasks)).items.length,1);
 });
 await t.test('revocation during a read suppresses its data and old versions stay denied after regrant',async()=>{
  const lease=await access.bind(alice,scope,'write',()=>{});let once=false;
  const guarded=intercepted(db,async q=>{if(!once&&q.includes('FROM runs r LEFT JOIN')){once=true;await access.grant(alice,scope,'owner','revoked',3);}},null),handler=createCloudHandler(guarded,new CloudflareAccessAuthenticator(policy));
  const r=await handler(req(scope,jwtA,tasks));assert.equal(r.status,403);const text=await r.text();assert.equal(text.includes('인증 시험'),false);assert.equal(text.includes(jwtA),false);
  await access.grant(alice,scope,'owner','active',4);await assert.rejects(lease.check(),{status:403});await assert.rejects(access.grant(alice,scope,'owner','revoked',3),{code:'access_conflict'});
  assert.equal((await all(db,'SELECT count(*) n FROM cloud_project_access WHERE issuer=? AND subject=? AND project_id=? AND repository=?',issuer,'alice',pA,'web'))[0].n,5);
 });
 await t.test('missing ACL schema fails closed without auto-provisioning',async()=>{
  const empty=await mf.getD1Database('EMPTY'),handler=createCloudHandler(empty,new CloudflareAccessAuthenticator(policy)),r=await handler(req(scope,jwtA,tasks));assert.equal(r.status,503);assert.deepEqual(await r.json(),{error:{code:'authorization_unavailable'}});assert.equal((await all(empty,"SELECT count(*) n FROM sqlite_master WHERE name='cloud_project_access'"))[0].n,0);
 });
 await t.test('revocation after commit hides its response; reauthorized retry returns the original receipt once',async()=>{
  let once=false;const command={operation:'begin',input:{goal:'commit before response revocation',mode:'change',idempotency_key:'committed-response-denied'}};
  const guarded=intercepted(db,null,null,async()=>{if(!once){once=true;await access.grant(alice,scope,'owner','revoked',5);}}),handler=createCloudHandler(guarded,new CloudflareAccessAuthenticator(policy));
  const r=await handler(req(scope,jwtA,command));assert.equal(r.status,403);assert.equal((await all(db,'SELECT count(*) n FROM runs WHERE goal=?',command.input.goal))[0].n,1);
  await access.grant(alice,scope,'owner','active',6);const replay=await send(scope,jwtA,command),receipt=await send(scope,jwtA,{operation:'receipt',input:{write_operation:'begin',idempotency_key:command.input.idempotency_key}});assert.equal(replay.run.id,receipt.result.run.id);assert.equal((await all(db,'SELECT count(*) n FROM runs WHERE goal=?',command.input.goal))[0].n,1);
 });
});
