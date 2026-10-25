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
import {D1AuthPolicies} from '../dist/adapters/storage/d1/auth-policies.js';
import {D1OwnerEnrollment} from '../dist/adapters/storage/d1/owner-enrollment.js';
import {D1AccessAuthenticator} from '../dist/adapters/auth/d1-access.js';
import {createManagedCloudHandler} from '../dist/transport/cloud/managed-server.js';
import {d1WorkerModules} from './support/d1-modules.mjs';

const names=['001-atomic-memory.sql','002-work.sql','003-decisions-plans.sql','004-execution-evidence.sql','005-task-events.sql','006-skills.sql','007-feature-discovery.sql','008-project-transfer.sql','009-storage-origins.sql','010-project-access.sql','011-owner-key-lifecycle.sql'];
const all=async(db,q,...v)=>(await db.withSession('first-primary').prepare(q).bind(...v).all()).results;
function intercept(db,{beforeBatch,afterBatch,afterRead}={}){return {withSession(c){const s=db.withSession(c),native=new WeakMap();const wrap=(st,q)=>{const w={bind:(...v)=>wrap(st.bind(...v),q),async all(){const result=await st.all();if(afterRead)await afterRead(q);return result;}};native.set(w,st);return w;};return {prepare:q=>wrap(s.prepare(q),q),async batch(statements){if(beforeBatch)await beforeBatch();const result=await s.batch(statements.map(x=>native.get(x)));if(afterBatch)await afterBatch();return result;}};}};}

test('managed owner enrollment and public-key lifecycle on real local D1',{timeout:150000},async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'skilly-owner-keys-'))),issuer='https://skilly-test.cloudflareaccess.com',audience='owner-test-only',policyId='personal-test',at=Math.floor(Date.now()/1000);
 const keys=await Promise.all(['old','new','recovery'].map(async kid=>{const pair=await generateKeyPair('RS256',{modulusLength:2048});return {pair,jwk:{...await exportJWK(pair.publicKey),kid,alg:'RS256',use:'sig'}};}));
 const [oldKey,newKey,recoveryKey]=keys,policy={issuer,audience,keys:[oldKey.jwk],fetched_at:at-10,valid_until:at+3600,max_token_age_seconds:3600};
 const options={...d1WorkerModules(fileURLToPath(new URL('./support/cloud-managed-worker.mjs',import.meta.url))),compatibilityDate:'2026-07-30',d1Databases:{DB:randomUUID(),EMPTY:randomUUID()},d1Persist:join(root,'d1'),host:'127.0.0.1',port:0,outboundService:()=>new Response('outbound disabled',{status:403})};
 let mf=new Miniflare(options);t.after(()=>mf.dispose());let db=await mf.getD1Database('DB');
 for(const name of names){const sql=readFileSync(new URL('../migrations/d1/'+name,import.meta.url),'utf8').replace(/^--[^\n]*$/gm,'').trim().split(/;\s*(?=CREATE\s|INSERT\s|$)/i).filter(Boolean);await db.batch(sql.map(s=>db.prepare(s)));}
 let policies=new D1AuthPolicies(db),enroll=new D1OwnerEnrollment(db),access=new D1ProjectAccess(db);await policies.publish(policyId,policy,0);
 const alice={issuer,subject:'alice'},bob={issuer,subject:'bob'};
 const makeScope=async()=>{const id=randomUUID();await new D1AtomicCommitStore(db,id).commit({project:{id,key:'test-'+id,name:'테스트용 프로젝트',revision:0,created_at:new Date().toISOString()},expected_revision:null,receipt:{scope:id,key:'seed',hash:createHash('sha256').update(id).digest('hex'),result:{test_only:true}}});return {project_id:id,repository:'web',environment:'test'};};
 const token=(key,sub='alice',extra={})=>new SignJWT({type:'app',iss:issuer,sub,aud:[audience],iat:at,exp:at+1800,email:'same-label@example.invalid',role:'owner',...extra}).setProtectedHeader({alg:'RS256',kid:key.jwk.kid}).sign(key.pair.privateKey);
 const oldJwt=await token(oldKey),newJwt=await token(newKey),bobJwt=await token(oldKey,'bob');
 const tasks={operation:'tasks',input:{}},req=(scope,jwt,body,owner=false)=>new Request(`http://localhost/v1/projects/${scope.project_id}/${owner?'owner':'memory'}`,{method:'POST',headers:{'Content-Type':'application/json',...(jwt?{'Cf-Access-Jwt-Assertion':jwt}:{})},body:JSON.stringify({repository:scope.repository,environment:scope.environment,...(owner?body:{command:body})})});
 const dispatch=async r=>mf.dispatchFetch(r.url,{method:r.method,headers:Object.fromEntries(r.headers),body:await r.text()});
 const send=async(scope,jwt,body,status=200,owner=false)=>{const r=await dispatch(req(scope,jwt,body,owner)),data=await r.json();assert.equal(r.status,status,JSON.stringify(data));assert.equal(r.headers.get('Cache-Control'),'no-store');return data;};
 const scope=await makeScope();let registration,receipt,activeScope;
 await t.test('only the host-pinned signed principal can enroll; body roles and scope changes cannot steal ownership',async()=>{
  registration=await enroll.prepare(scope,alice,policyId,at+600);
  await send(scope,null,{registration_id:registration.registration_id},401,true);await send(scope,bobJwt,{registration_id:registration.registration_id},403,true);
  await send({...scope,repository:'api'},oldJwt,{registration_id:registration.registration_id},403,true);
  await send(scope,oldJwt,{registration_id:registration.registration_id,subject:'bob',role:'owner'},400,true);
  await send(scope,oldJwt,{registration_id:randomUUID()},403,true);await send(scope,oldJwt,tasks,403);
  assert.equal((await all(db,'SELECT count(*) n FROM cloud_project_access'))[0].n,0);
 });
 await t.test('concurrent enrollment and lost-response retry grant once and preserve the same receipt',async()=>{
  const body={registration_id:registration.registration_id},results=await Promise.all([send(scope,oldJwt,body,200,true),send(scope,oldJwt,body,200,true)]);
  receipt=results[0];assert.deepEqual(results[1],receipt);assert.deepEqual(await send(scope,oldJwt,body,200,true),receipt);
  assert.equal((await all(db,'SELECT count(*) n FROM cloud_project_access WHERE project_id=?',scope.project_id))[0].n,1);
  assert.equal((await all(db,'SELECT count(*) n FROM cloud_owner_claims'))[0].n,1);await assert.rejects(enroll.prepare(scope,bob,policyId,at+600),{code:'owner_conflict'});
  await send(scope,bobJwt,body,403,true);await send(scope,oldJwt,tasks);
 });
 await t.test('receipt replay after owner revocation never regrants access or permits bootstrap takeover',async()=>{
  await access.grant(alice,scope,'owner','revoked',1);assert.deepEqual(await send(scope,oldJwt,{registration_id:registration.registration_id},200,true),receipt);
  await send(scope,oldJwt,tasks,403);await assert.rejects(enroll.prepare(scope,bob,policyId,at+600),{code:'owner_conflict'});
  assert.equal((await all(db,'SELECT count(*) n FROM cloud_project_access WHERE project_id=?',scope.project_id))[0].n,2);
 });
 await t.test('preexisting grants, expiry and a grant racing enrollment cannot be overwritten',async()=>{
  const existing=await makeScope();await access.grant(bob,existing,'viewer','active',0);await assert.rejects(enroll.prepare(existing,alice,policyId,at+600),{code:'owner_conflict'});
  const racing=await makeScope(),i=await enroll.prepare(racing,alice,policyId,at+600);await access.grant(bob,racing,'viewer','active',0);await send(racing,oldJwt,{registration_id:i.registration_id},409,true);
  assert.equal((await all(db,'SELECT count(*) n FROM cloud_owner_claims WHERE intent_id=?',i.registration_id))[0].n,0);
  const expired=await makeScope(),i2=await enroll.prepare(expired,alice,policyId,at+600),auth=await new D1AccessAuthenticator(db,policyId).authenticate(req(expired,oldJwt,tasks));
  await assert.rejects(new D1OwnerEnrollment(db,()=> (at+601)*1000).claim(auth,expired,i2.registration_id),{code:'owner_conflict'});
  assert.equal((await all(db,'SELECT count(*) n FROM cloud_project_access WHERE project_id=?',expired.project_id))[0].n,0);
 });
 await t.test('unknown commit, lost response and incomplete adapter results never fabricate a saved enrollment',async()=>{
  for(const mode of ['before','after','empty']){
   const target=await makeScope(),i=await enroll.prepare(target,alice,policyId,at+600),body={registration_id:i.registration_id};let once=false;
   const fail=async()=>{if(!once){once=true;throw Error('simulated transport loss');}};
   const wrapped=mode==='empty'?{withSession(c){const s=db.withSession(c);return {prepare:q=>s.prepare(q),batch:async()=>[]};}}:intercept(db,mode==='before'?{beforeBatch:fail}:{afterBatch:fail});
   const r=await createManagedCloudHandler(wrapped,policyId)(req(target,oldJwt,body,true));assert.equal(r.status,mode==='after'?200:503);
   const expected=mode==='after'?1:0;assert.equal((await all(db,'SELECT count(*) n FROM cloud_project_access WHERE project_id=?',target.project_id))[0].n,expected);
   const recovered=await send(target,oldJwt,body,200,true);if(mode==='after')assert.deepEqual(await r.json(),recovered);
   assert.equal((await all(db,'SELECT count(*) n FROM cloud_project_access WHERE project_id=?',target.project_id))[0].n,1);
  }
 });
 await t.test('retiring a key just before enrollment rolls back both owner and receipt',async()=>{
  const target=await makeScope(),otherId='claim-race';await policies.publish(otherId,policy,0);const i=await enroll.prepare(target,alice,otherId,at+600);let once=false;
  const wrapped=intercept(db,{beforeBatch:async()=>{if(!once){once=true;await policies.revoke(otherId,1);}}});
  const r=await createManagedCloudHandler(wrapped,otherId)(req(target,oldJwt,{registration_id:i.registration_id},true));assert.equal(r.status,401);
  assert.equal((await all(db,'SELECT count(*) n FROM cloud_project_access WHERE project_id=?',target.project_id))[0].n,0);assert.equal((await all(db,'SELECT count(*) n FROM cloud_owner_claims WHERE intent_id=?',i.registration_id))[0].n,0);
 });
 await t.test('a publication race has one winner; rotation overlap works in an already-created handler',async()=>{
  activeScope=await makeScope();const i=await enroll.prepare(activeScope,alice,policyId,at+600);await send(activeScope,oldJwt,{registration_id:i.registration_id},200,true);
  const lease=await new D1AccessAuthenticator(db,policyId).authenticate(req(activeScope,oldJwt,tasks));
  const next={...policy,keys:[oldKey.jwk,newKey.jwk]},race=await Promise.allSettled([policies.publish(policyId,next,1),new D1AuthPolicies(db).publish(policyId,next,1)]);
  assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal((await policies.read(policyId)).version,2);
  await assert.rejects(lease.assertFresh(),{status:401});await send(activeScope,oldJwt,tasks);await send(activeScope,newJwt,tasks);
 });
 await t.test('revoked key, renamed key material, reused kid and stale policy cannot restore access',async()=>{
  await policies.revokeKey(policyId,'old',2);await send(activeScope,oldJwt,tasks,401);await send(activeScope,newJwt,tasks);
  for(const next of [{...policy,keys:[oldKey.jwk]},{...policy,keys:[{...oldKey.jwk,kid:'renamed'}]},{...policy,keys:[{...recoveryKey.jwk,kid:'old'}]},{...policy,issuer:'https://other.cloudflareaccess.com',keys:[newKey.jwk]},{...policy,audience:'other',keys:[newKey.jwk]},{...policy,fetched_at:at-11,keys:[newKey.jwk]}])await assert.rejects(policies.publish(policyId,next,3),{code:'authentication_conflict'});
  await assert.rejects(policies.publish(policyId,{...policy,keys:[newKey.jwk]},1),{code:'authentication_conflict'});
  assert.equal((await policies.read(policyId)).version,3);
 });
 await t.test('key retirement between validation and write rolls back project revision, task and receipt',async()=>{
  const before=(await all(db,'SELECT revision FROM projects WHERE id=?',activeScope.project_id))[0].revision;let once=false;
  const wrapped=intercept(db,{beforeBatch:async()=>{if(!once){once=true;await policies.revokeKey(policyId,'new',3);}}}),handler=createManagedCloudHandler(wrapped,policyId);
  const r=await handler(req(activeScope,newJwt,{operation:'begin',input:{goal:'must-not-save',mode:'change',idempotency_key:'retire-race'}}));assert.equal(r.status,401);
  assert.equal((await all(db,'SELECT revision FROM projects WHERE id=?',activeScope.project_id))[0].revision,before);assert.equal((await all(db,"SELECT count(*) n FROM runs WHERE goal='must-not-save'"))[0].n,0);
  assert.equal((await all(db,'SELECT count(*) n FROM receipts WHERE scope=? AND idempotency_key LIKE ?',activeScope.project_id,'cloud:%'))[0].n,0);
  await send(activeScope,newJwt,tasks,503);assert.equal((await policies.read(policyId)).state,'revoked');
 });
 await t.test('fresh replacement key works but the last revoked key never returns, even after workerd restart',async()=>{
  await policies.publish(policyId,{...policy,keys:[recoveryKey.jwk]},4);await assert.rejects(policies.publish(policyId,{...policy,keys:[newKey.jwk]},5),{code:'authentication_conflict'});
  const jwt=await token(recoveryKey);await send(activeScope,jwt,tasks);await mf.dispose();mf=new Miniflare(options);db=await mf.getD1Database('DB');policies=new D1AuthPolicies(db);enroll=new D1OwnerEnrollment(db);access=new D1ProjectAccess(db);
  await send(activeScope,oldJwt,tasks,401);await send(activeScope,newJwt,tasks,401);await send(activeScope,jwt,tasks);
  assert.deepEqual(await send(scope,jwt,{registration_id:registration.registration_id},200,true),receipt);
  const result=await send(activeScope,jwt,{operation:'begin',input:{goal:'normal-after-rotation',mode:'change',idempotency_key:'normal'}});assert.equal(result.claims_verified,false);
 });
 await t.test('revocation during a read hides data and old leases stay blocked',async()=>{
  const jwt=await token(recoveryKey),lease=await new D1AccessAuthenticator(db,policyId).authenticate(req(activeScope,jwt,tasks));let once=false;
  const wrapped=intercept(db,{afterRead:async q=>{if(!once&&q.includes('FROM runs r LEFT JOIN')){once=true;await policies.revoke(policyId,5);}}});
  const response=await createManagedCloudHandler(wrapped,policyId)(req(activeScope,jwt,tasks));assert.equal(response.status,503);assert.equal((await response.text()).includes('normal-after-rotation'),false);await assert.rejects(lease.assertFresh(),{status:503});
 });
 await t.test('missing or corrupt managed policy fails closed without modifying business data',async()=>{
  const empty=await mf.getD1Database('EMPTY'),r=await createManagedCloudHandler(empty,policyId)(req(activeScope,oldJwt,tasks));assert.equal(r.status,503);assert.equal((await all(empty,"SELECT count(*) n FROM sqlite_master WHERE name='cloud_auth_versions'"))[0].n,0);
  await db.prepare('INSERT INTO cloud_auth_versions VALUES(?,?,?,?,?,?)').bind('corrupt',1,'active',at+3600,'{}',new Date().toISOString()).run();
  await assert.rejects(new D1AuthPolicies(db).current('corrupt'),{status:503});
  await policies.publish('aging',policy,0);await assert.rejects(new D1AuthPolicies(db,()=> (at+3601)*1000).current('aging'),{status:503});
 });
});
