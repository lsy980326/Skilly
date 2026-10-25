import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {CloudExecutionCollector} from '../../dist/adapters/storage/d1/cloud-executions.js';
import {D1AccessAuthenticator} from '../../dist/adapters/auth/d1-access.js';
import {D1ProjectAccess} from '../../dist/adapters/storage/d1/project-access.js';
import {D1CloudWork} from '../../dist/adapters/storage/d1/cloud-work.js';
import {cloudWriteKey} from '../../dist/adapters/storage/d1/cloud-work.js';
import {createCloudMcpHandler} from '../../dist/transport/mcp/cloud-http.js';
import {observeCommand} from '../../dist/runtime/local/process-observer.js';
import {observeSource} from '../../dist/adapters/project/source-version.js';

function lostResponse(database,nth){
 let batches=0,blocked=false;
 return {release(){blocked=false;},binding:{withSession(c){const s=database.withSession(c),native=new WeakMap();
  const wrap=(statement,q)=>{const value={bind:(...v)=>wrap(statement.bind(...v),q),async all(){if(blocked&&q.includes('FROM receipts'))throw Error('test receipt response unavailable');return statement.all();}};native.set(value,statement);return value;};
  return {prepare:q=>wrap(s.prepare(q),q),async batch(statements){const result=await s.batch(statements.map(x=>native.get(x)));if(++batches===nth){blocked=true;throw Error('test committed response unavailable');}return result;}};
 }}};
}

/** Real local processes and SDK/HTTP reads; no credential files or external service. */
export async function cloudExecutionCycle(t,f){
 const {scope,endpoint,config,jwt,client,connect,headers,root,all,value,callError}=f;
 const db=()=>f.db(),repo=join(root,'evidence-source');mkdirSync(repo);
 const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:repo,stdio:'pipe'});
 git('init');writeFileSync(join(repo,'value.mjs'),'export const value=4;\n');git('add','value.mjs');
 git('-c','user.name=Skilly Test','-c','user.email=local@example.invalid','commit','-m','test fixture');
 const binding={version:1,key:'mcp-test-'+scope.project_id,name:'MCP 테스트 프로젝트',repository:scope.repository,environment:scope.environment};
 const source=()=>observeSource(repo,binding);
 const authenticate=(token=jwt,database=db())=>new D1AccessAuthenticator(database,'personal-mcp').authenticate(new Request(endpoint,{headers:headers(token)}));
 const collector=(key,auth=()=>authenticate(),database=db())=>new CloudExecutionCollector(database,scope,auth,key);
 const run=async(sink,file,start)=>{
  const context=process.env.NODE_TEST_CONTEXT;
  try{delete process.env.NODE_TEST_CONTEXT;return await observeCommand({command:process.execPath,args:['--test',file],root:repo,timeout:10000,testFormat:'auto',start,sink,source});}
  finally{if(context!==undefined)process.env.NODE_TEST_CONTEXT=context;}
 };
 const pass=join(root,'remote-pass.test.mjs'),fail=join(root,'remote-fail.test.mjs');
 writeFileSync(pass,"import test from 'node:test';import assert from 'node:assert/strict';test('actual remote passing case',()=>assert.equal(2+2,4));\n");
 writeFileSync(fail,"import test from 'node:test';test('intentional actual remote failing case',()=>{throw Error('expected fixture failure');});\n");
 let runId,recordId,good,bad,progress;
 const start=()=>({project_id:scope.project_id,run_id:runId,record_id:recordId});
 const query=async(handler,name,args)=>{
  const response=await handler(new Request(endpoint,{method:'POST',headers:{...headers(jwt),Host:new URL(endpoint).host},body:JSON.stringify({jsonrpc:'2.0',id:88,method:'tools/call',params:{name,arguments:args}})}));
  assert.equal(response.status,200);return value((await response.json()).result);
 };
 const update=ids=>({run_id:runId,plan_key:'remote-checks',version:1,item_key:'item-1',record_id:recordId,state:'completed',note:'테스트용 완료 보고',expected_update_id:progress?.update_id??null,
  criteria_results:[{key:'acceptance',met:true,detail:'보고된 완료와 수집 결과를 별도로 판정'}],execution_ids:ids,idempotency_key:randomUUID()});
 await t.test('real host collector saves pass/fail details and code versions for fresh MCP and plan reads',async()=>{
  runId=value(await client.callTool({name:'memory_begin_task',arguments:{goal:'실제 원격 검사 수집 테스트',mode:'change',idempotency_key:'observed-task'}})).run.id;
  recordId=value(await client.callTool({name:'memory_checkpoint',arguments:{run_id:runId,topic:'checks',kind:'change',body:'AI 검사 성공 보고는 직접 관측이 아닙니다.',idempotency_key:'observed-report',report:{title:'AI 보고',summary:'AI가 보고한 성공',checks:[{name:'AI reported check',result:'passed'}]}}})).record_id;
  value(await client.callTool({name:'memory_save_plan',arguments:{run_id:runId,plan_key:'remote-checks',expected_version:0,title:'원격 검사 계획',source_kind:'markdown',source_ref:'selected-test-plan.md',source_body:'- [ ] 검사 연결\n- [ ] 다음 작업\n',idempotency_key:'observed-plan'}}));
  assert.deepEqual(value(await client.callTool({name:'memory_list_executions',arguments:{run_id:runId}})).items,[]);
  const goodSink=collector('actual-pass'),badSink=collector('actual-fail');good=await run(goodSink,pass,start());bad=await run(badSink,fail,start());
  assert.equal(good.code,0);assert.equal(bad.code,1);
  const next=await connect(jwt),read=value(await next.callTool({name:'memory_list_executions',arguments:{run_id:runId}}));
  const a=read.items.find(x=>x.id===good.execution_id),b=read.items.find(x=>x.id===bad.execution_id);
  assert.equal(a.test_details.counts.passed,1);assert.equal(b.test_details.counts.failed,1);assert.deepEqual(b.test_details.failures,['intentional actual remote failing case']);
  assert.equal(a.source,'local_runner');assert.equal(a.provenance,'local_runner');assert.equal(a.authenticity,'local_observation_not_attestation');assert.equal(a.claims_verified,false);
  assert.ok(a.code_version.before.commit);assert.ok(a.code_version.after.commit);assert.equal(a.code_version.comparison.status,'unknown');
  progress=value(await next.callTool({name:'memory_update_plan_item',arguments:update([good.execution_id,bad.execution_id])}));
  const plan=value(await (await connect(jwt)).callTool({name:'memory_query_plans',arguments:{plan_key:'remote-checks'}}));
  assert.equal(plan.progress.percent,50);assert.equal(plan.progress.remaining,1);assert.equal(plan.claims_verified,false);
  assert.deepEqual(new Set(plan.items[0].evidence.observations.map(x=>x.execution_id)),new Set([good.execution_id,bad.execution_id]));
  assert.equal(plan.execution_details.items.find(x=>x.id===bad.execution_id).test_details.counts.failed,1);
  assert.equal((await goodSink.receipt('execution-start')).result.execution_id,good.execution_id);
  const receipt=value(await next.callTool({name:'memory_get_receipt',arguments:{write_operation:'execution-finish',idempotency_key:'actual-fail'}}));assert.equal(receipt.result.execution_id,bad.execution_id);
 });
 await t.test('only host source providers compare current code; reports and request fields cannot supply observations',async()=>{
  const live=createCloudMcpHandler(db(),config,()=>source());
  let list=await query(live,'memory_list_executions',{run_id:runId});assert.equal(list.items.find(x=>x.id===good.execution_id).code_version.comparison.status,'same_version');
  let plan=await query(live,'memory_query_plans',{plan_key:'remote-checks'});assert.equal(plan.items[0].evidence.status,'current');assert.equal(plan.items[0].evidence.counts.failed,1);assert.equal(plan.claims_verified,false);
  writeFileSync(join(repo,'value.mjs'),'export const value=5;\n');
  list=await query(live,'memory_list_executions',{run_id:runId});assert.equal(list.items.find(x=>x.id===good.execution_id).code_version.comparison.status,'changed');
  plan=await query(live,'memory_query_plans',{plan_key:'remote-checks'});assert.equal(plan.items[0].evidence.status,'stale');
  writeFileSync(join(repo,'value.mjs'),'export const value=4;\n');
  for(const input of [{run_id:runId,source_observation:source()},{run_id:runId,verified:true},{run_id:runId,result:{exit_code:0}},{run_id:runId,offset:100001}])await callError(client,'memory_list_executions',input,'invalid_input');
  const before=(await all(db(),'SELECT count(*) n FROM executions'))[0].n;
  for(const name of ['memory_start_execution','memory_finish_execution','memory_observe_execution'])await callError(client,name,{run_id:runId,result:{exit_code:0}},'invalid_input');
  await callError(client,'memory_checkpoint',{run_id:runId,kind:'note',topic:'checks',body:'위조',idempotency_key:'forged-execution',execution:{exit_code:0}},'invalid_input');
  assert.equal((await all(db(),'SELECT count(*) n FROM executions'))[0].n,before);
 });
 await t.test('execution reads and host writes enforce authentication, fixed scope and role permissions',async()=>{
  for(const token of ['',f.bobJwt]){
   const response=await fetch(endpoint,{method:'POST',headers:headers(token),body:JSON.stringify({jsonrpc:'2.0',id:89,method:'tools/call',params:{name:'memory_list_executions',arguments:{run_id:runId}}})});
   assert.equal(response.status,token?403:401);assert.equal((await response.text()).includes(good.execution_id),false);
  }
  const viewer=await connect(f.viewerJwt);assert.equal(value(await viewer.callTool({name:'memory_list_executions',arguments:{run_id:runId}})).items.length,2);
  for(const op of ['execution-start','execution-finish'])assert.equal(value(await viewer.callTool({name:'memory_get_receipt',arguments:{write_operation:op,idempotency_key:'actual-pass'}})).found,false);
  for(const extra of [{project_id:f.other},{repository:'api'},{environment:'production'}])await callError(client,'memory_list_executions',{run_id:runId,...extra},'access_denied');
  const foreignScope={...scope,project_id:f.other},foreign=await new D1CloudWork(db(),foreignScope,{issuer:f.issuer,subject:'bob'}).write({operation:'begin',input:{goal:'다른 프로젝트 테스트',mode:'change',idempotency_key:'foreign-observed-run'}});
  assert.deepEqual(value(await client.callTool({name:'memory_list_executions',arguments:{run_id:foreign.run.id}})).items,[]);
  const marker=join(root,'forbidden-must-not-run.test.mjs');
  writeFileSync(marker,"import{writeFileSync}from'node:fs';writeFileSync("+JSON.stringify(join(root,'forbidden-marker'))+",'x');\n");
  for(const [index,token] of ['',f.bobJwt,f.viewerJwt].entries())await assert.rejects(run(collector('denied-'+index,()=>authenticate(token)),marker,start()),e=>[401,403].includes(e.status));
  await assert.rejects(run(collector('foreign-task'),marker,{...start(),run_id:foreign.run.id}),{code:'scope_mismatch'});
  assert.equal(existsSync(join(root,'forbidden-marker')),false);
  await new D1CloudWork(db(),foreignScope,{issuer:f.issuer,subject:'bob'}).write({operation:'finish',input:{run_id:foreign.run.id,summary:'테스트 종료',outcome:'completed',idempotency_key:'foreign-observed-finish'}});
 });
 await t.test('a reused host key or competing collector never grants a second process launch',async()=>{
  const marker=join(root,'spawn-count'),file=join(root,'once.test.mjs');
  writeFileSync(file,"import{appendFileSync}from'node:fs';appendFileSync("+JSON.stringify(marker)+",'x');\n");
  const first=collector('once-only');await run(first,file,start());
  await assert.rejects(run(first,file,start()),{code:'execution_already_started'});
  // A newly sampled source has a new observed_at, so a new invocation can be an input conflict too.
  await assert.rejects(run(collector('once-only'),file,start()),e=>['execution_already_started','idempotency_conflict'].includes(e.code));assert.equal(readFileSync(marker,'utf8'),'x');
  const hash=createHash('sha256').update(JSON.stringify([process.execPath,'--test',file])).digest('hex');
  const input={...start(),executable:'node',command_hash:hash,source_observation:source()};
  const racers=await Promise.allSettled([collector('competing').start(input),collector('competing').start(input)]);
  assert.equal(racers.filter(x=>x.status==='fulfilled').length,1);assert.equal(racers.find(x=>x.status==='rejected').reason.code,'execution_already_started');
  const pending=value(await client.callTool({name:'memory_list_executions',arguments:{run_id:runId}})).items.find(x=>x.id===racers.find(x=>x.status==='fulfilled').value);assert.equal(pending.outcome,'unconfirmed');
 });
 await t.test('finish authentication is renewed, a changed principal is refused and the retained DTO retries without executing again',async()=>{
  const marker=join(root,'retry-count'),file=join(root,'retry.test.mjs');
  writeFileSync(file,"import{appendFileSync}from'node:fs';appendFileSync("+JSON.stringify(marker)+",'x');\n");
  let phase=0,allow=false;
  const sink=collector('renewed-auth',()=>authenticate(phase++===0||allow?jwt:f.viewerJwt));
  await assert.rejects(run(sink,file,start()),{code:'execution_save_failed'});assert.equal(readFileSync(marker,'utf8'),'x');
  await assert.rejects(sink.retryFinish(),{code:'scope_mismatch'});
  allow=true;await sink.retryFinish();await sink.retryFinish();assert.equal(readFileSync(marker,'utf8'),'x');
  const saved=await sink.receipt('execution-finish');assert.equal(saved.found,true);
  const list=value(await (await connect(jwt)).callTool({name:'memory_list_executions',arguments:{run_id:runId}}));assert.equal(list.items.find(x=>x.id===saved.result.execution_id).outcome,'exited');
 });
 await t.test('revocation at the collector batch guard leaves no start observation or launch permission',async()=>{
  const access=new D1ProjectAccess(db()),version=(await all(db(),'SELECT max(version) v FROM cloud_project_access WHERE issuer=? AND subject=? AND project_id=? AND repository=? AND environment=?',f.issuer,'alice',scope.project_id,scope.repository,scope.environment))[0].v;
  const before=(await all(db(),'SELECT count(*) n FROM executions'))[0].n;let once=false;
  const guarded={withSession(c){const session=db().withSession(c);return {prepare:q=>session.prepare(q),async batch(st){if(!once){once=true;await access.grant(f.alice,scope,'owner','revoked',version);}return session.batch(st);}};}};
  try{await assert.rejects(run(collector('collector-revocation',()=>authenticate(),guarded),pass,start()),{status:403});assert.equal((await all(db(),'SELECT count(*) n FROM executions'))[0].n,before);}
  finally{await access.grant(f.alice,scope,'owner','active',version+1);}
  assert.equal(value(await client.callTool({name:'memory_get_receipt',arguments:{write_operation:'execution-start',idempotency_key:'collector-revocation'}})).found,false);
 });
 await t.test('lost start and finish responses recover storage receipts without granting another process launch',async()=>{
  const marker=join(root,'lost-response-count'),file=join(root,'lost-response.test.mjs');
  writeFileSync(file,"import{appendFileSync}from'node:fs';appendFileSync("+JSON.stringify(marker)+",'x');\n");
  const first=lostResponse(db(),1),startSink=collector('lost-observation-start',()=>authenticate(),first.binding);let original;
  const capture={start(input){original=structuredClone(input);return startSink.start(input);},finish:(...args)=>startSink.finish(...args)};
  await assert.rejects(run(capture,file,start()),{code:'persistence_unknown'});assert.equal(existsSync(marker),false);first.release();
  assert.equal((await startSink.receipt('execution-start')).found,true);
  await assert.rejects(collector('lost-observation-start').start(original),{code:'execution_already_started'});assert.equal(existsSync(marker),false);
  const last=lostResponse(db(),2),finishSink=collector('lost-observation-finish',()=>authenticate(),last.binding);
  await assert.rejects(run(finishSink,file,start()),{code:'execution_save_failed'});assert.equal(readFileSync(marker,'utf8'),'x');last.release();
  const receipt=value(await (await connect(jwt)).callTool({name:'memory_get_receipt',arguments:{write_operation:'execution-finish',idempotency_key:'lost-observation-finish'}}));assert.equal(receipt.found,true);
  await finishSink.retryFinish();assert.equal(readFileSync(marker,'utf8'),'x');
 });
 await t.test('a malformed receipt scope is refused before a host replay can return an execution identifier',async()=>{
  const input={...start(),executable:'node',command_hash:createHash('sha256').update('receipt test').digest('hex'),source_observation:source()};
  await collector('bad-execution-scope').start(input);
  const key=await cloudWriteKey(f.alice,scope,'execution-start','bad-execution-scope');
  const [row]=await all(db(),'SELECT result_json FROM receipts WHERE scope=? AND idempotency_key=?',scope.project_id,key);
  const result=JSON.parse(row.result_json);result.scope.repository='api';
  await db().prepare('UPDATE receipts SET result_json=? WHERE scope=? AND idempotency_key=?').bind(JSON.stringify(result),scope.project_id,key).run();
  await assert.rejects(collector('bad-execution-scope').start(input),{code:'scope_mismatch'});
  await callError(client,'memory_get_receipt',{write_operation:'execution-start',idempotency_key:'bad-execution-scope'},'scope_mismatch');
 });
 // Return IDs to re-read after the actual Worker restart in the surrounding fixture.
 return {runId,good,bad};
}
