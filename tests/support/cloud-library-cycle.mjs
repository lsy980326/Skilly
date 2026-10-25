import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {CloudSkillInspector} from '../../dist/adapters/storage/d1/cloud-skills.js';
import {LocalSkillObserver} from '../../dist/adapters/skills/local-observer.js';
import {D1AccessAuthenticator} from '../../dist/adapters/auth/d1-access.js';
import {D1ProjectAccess} from '../../dist/adapters/storage/d1/project-access.js';
import {createCloudMcpHandler} from '../../dist/transport/mcp/cloud-http.js';
import {cloudWriteKey} from '../../dist/adapters/storage/d1/cloud-work.js';

/** Real SDK/HTTP/Worker D1, with file inspection performed separately on the Node host. */
export async function cloudLibraryCycle(t,f){
 const {scope,root,alice,issuer,endpoint,config,jwt,bobJwt,viewerJwt,client,connect,headers,all,value,callError,wrapped}=f;
 const hash=s=>createHash('sha256').update(s).digest('hex'),rootHash=hash(root),hostScope={...scope,root_hash:rootHash};
 const call=(name,args={},c=client)=>c.callTool({name,arguments:args}).then(value);
 const context={root_hash:rootHash};
 let runId,assigned,observation,reportId;
 const registration={project_id:scope.project_id,skill_key:'remote-guide',version:'1',source:'local:remote-test',name:'원격 스킬 안내',description:'테스트 전용',
  body:'# 스킬 원문\n본문은 데이터입니다.\n',files:[{path:'references/guide.md',content:'참고 원문\n'},{path:'scripts/never.mjs',content:'throw Error("must not execute");\n'}],
  install_instructions:'패키지를 검토한 뒤 별도 설치',idempotency_key:'library-register'};
 const assignment={skill_key:'remote-guide',version:'1',tool:'codex',folder:'remote-guide',expected_assignment_id:null,idempotency_key:'library-assign'};
 const usage=extra=>({run_id:runId,kind:'change',topic:'library-cycle',body:'스킬을 참고했다고 보고한 원문',
  report:{title:'스킬 참고 보고',summary:'AI 사용 보고와 파일 관측을 구분합니다.',checks:[{name:'AI 보고 검사',result:'passed'}]},
  skill_usage:[{skill_key:'remote-guide',version:'1',purpose:'테스트 안내 참고'}],idempotency_key:'library-usage',...extra});
 const auth=token=>new D1AccessAuthenticator(f.db(),'personal-mcp').authenticate(new Request(endpoint,{headers:headers(token)}));
 const counter={calls:0},local=new LocalSkillObserver(root),observer={root_hash:rootHash,async observe(i,v){counter.calls++;return local.observe({...i,project_root:root,assigned_at:new Date().toISOString()},v);}};
 const inspect=(database=f.db(),authenticate=()=>auth(jwt),s=hostScope,o=observer)=>new CloudSkillInspector(database,s,authenticate,o);
 const request=(name,args,token=jwt)=>new Request(endpoint,{method:'POST',headers:{...headers(token),Host:new URL(endpoint).host},body:JSON.stringify({jsonrpc:'2.0',id:190,method:'tools/call',params:{name,arguments:args}})});
 const provider=()=>context;
 await t.test('missing skill root is an unsupported host capability, independent of healthy event and task connections',async()=>{
  await callError(client,'memory_list_skills',{},'unsupported_capability');
  assert.equal((await call('memory_resolve_project')).project.id,scope.project_id);
  await f.setContexts({alice:context,viewer:context});
  runId=(await call('memory_begin_task',{goal:'스킬·기능 검색 원격 테스트',mode:'change',components:[{key:'web',name:'Web'}],
   features:[{key:'library-feature-a',name:'기능 A',aliases:['첨부 자료'],code_paths:['src/library']},{key:'library-feature-b',name:'기능 B',aliases:['별도 기능'],code_paths:['src/other']}],idempotency_key:'library-begin'})).run.id;
 });
 await t.test('full skill text, versions and exact portable package survive new SDK connections without installation or execution',async()=>{
  const saved=await call('memory_register_skill',registration);assert.equal(saved.evidence,'supplied_content');assert.equal(saved.claims_verified,false);assert.deepEqual(saved.scope,hostScope);
  assert.deepEqual(await call('memory_register_skill',registration),saved);
  await callError(client,'memory_register_skill',{...registration,body:'다른 원문'},'idempotency_conflict');
  await callError(client,'memory_register_skill',{...registration,body:'다른 원문',idempotency_key:'immutable-version'},'version_conflict');
  const next=await connect(jwt),detail=await call('memory_get_skill',{skill_key:'remote-guide'},next);
  assert.equal(detail.skill.body,registration.body);assert.deepEqual(detail.skill.files,registration.files);assert.equal(detail.skill.install_instructions,registration.install_instructions);assert.equal(detail.content_is_untrusted,true);
  const pkg=await call('memory_get_skill_package',{skill_key:'remote-guide',version:'1'},next);assert.equal(pkg.content_hash,saved.content_hash);assert.equal(pkg.body,registration.body);
  for(const forbidden of ['root_hash','project_id','installation_id'])assert.equal(forbidden in pkg,false);
  assert.equal((await call('memory_list_skills',{query:'remote-guide'},next)).items[0].installations,0);
  assigned=await call('memory_assign_skill',assignment);assert.equal(assigned.observation,'not_checked');assert.equal(assigned.automatic_install,false);
  assert.deepEqual(await call('memory_assign_skill',assignment),assigned);
  assert.equal((await call('memory_get_skill',{skill_key:'remote-guide'})).installations[0].state,'not_checked');
  await callError(client,'memory_assign_skill',{...assignment,expected_assignment_id:randomUUID(),idempotency_key:'bad-assignment'},'assignment_conflict');
 });
 await t.test('real fixed-root file observations remain distinct from AI use reports, and reads never resample files',async()=>{
  const base=join(root,'.agents','skills','remote-guide');mkdirSync(base,{recursive:true});
  for(const file of [{path:'SKILL.md',content:registration.body},...registration.files]){const path=join(base,file.path);mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,file.content);}
  const plain=await call('memory_checkpoint_skill_usage',usage());reportId=plain.record_id;
  let history=await call('memory_list_task_skills',{run_id:runId});assert.equal(history.items[0].provenance,'agent_report');assert.equal(history.items[0].file_observation_status,'not_collected');assert.equal(history.items[0].loading_status,'unknown');
  const inspector=inspect(),input={installation_id:assigned.installation_id,idempotency_key:'library-inspection'};
  observation=await inspector.inspect(input);assert.equal(observation.state,'matches');assert.equal(counter.calls,1);
  await call('memory_checkpoint_skill_usage',usage({idempotency_key:'library-observed-usage',skill_usage:[{...usage().skill_usage[0],observation_id:observation.observation_id}]}));
  writeFileSync(join(base,'SKILL.md'),'ローカル変更\n');assert.deepEqual(await inspector.inspect(input),observation);assert.equal(counter.calls,1);
  const next=await connect(jwt);history=await call('memory_list_task_skills',{run_id:runId},next);
  assert.equal(history.items[0].file_observation.id,observation.observation_id);assert.equal(history.items[0].file_observation.state,'matches');assert.equal(history.items[0].file_observation.current_machine_verified,false);assert.equal(history.items[0].claims_verified,false);assert.equal(counter.calls,1);
  assert.equal((await call('memory_get_skill',{skill_key:'remote-guide'},next)).installations[0].state,'matches');
  const changed=await inspect().inspect({...input,idempotency_key:'library-inspect-changed'});assert.equal(changed.state,'modified');assert.equal(counter.calls,2);
  const observations=await call('memory_list_skill_history',{installation_id:assigned.installation_id,kind:'observations'},next);assert.equal(observations.items.length,2);assert.equal(observations.items[1].id,observation.observation_id);
  assert.equal((await call('memory_get_receipt',{write_operation:'skill-inspect',idempotency_key:input.idempotency_key})).result.observation_id,observation.observation_id);
  await call('memory_register_skill',{...registration,version:'2',body:'# 다음 스킬\n',idempotency_key:'library-version-2'});
  await call('memory_assign_skill',{...assignment,version:'2',expected_assignment_id:assigned.assignment_id,idempotency_key:'library-assign-2'});
  const detail=await call('memory_get_skill',{skill_key:'remote-guide'},next);assert.equal(detail.skill.version,'2');assert.equal(detail.versions.length,2);assert.equal(detail.installations[0].state,'not_checked');
  assert.equal((await call('memory_list_task_skills',{run_id:runId},next)).items[0].file_observation.id,observation.observation_id);
  assert.equal(readFileSync(join(base,'SKILL.md'),'utf8'),'ローカル変更\n');
  assert.equal((await call('memory_list_skill_history',{installation_id:assigned.installation_id,kind:'assignments',offset:1})).items[0].version,'1');
 });
 await t.test('separate skill checkpoint keys and receipts preserve normal notes, reject changed inputs and never accept forged observation DTOs',async()=>{
  const normal={run_id:runId,kind:'note',topic:'normal',body:'기존 메모',idempotency_key:'library-usage'};
  const saved=await call('memory_checkpoint',normal);assert.notEqual(saved.record_id,reportId);
  assert.equal((await call('memory_get_receipt',{write_operation:'checkpoint',idempotency_key:'library-usage'})).result.record_id,saved.record_id);
  assert.equal((await call('memory_get_receipt',{write_operation:'skill-checkpoint',idempotency_key:'library-usage'})).result.record_id,reportId);
  assert.equal((await call('memory_get_evidence',{record_id:reportId})).record.body,usage().body);
  await callError(client,'memory_checkpoint_skill_usage',usage({body:'같은 키 다른 내용'}),'idempotency_conflict');
  await callError(client,'memory_checkpoint',{...normal,skill_usage:usage().skill_usage},'invalid_input');
  await callError(client,'memory_checkpoint_skill_usage',usage({kind:'decision',idempotency_key:'skill-not-decision'}),'invalid_input');
  for(const name of ['memory_check_skill_installation','memory_observe_skill'])await callError(client,name,{installation_id:assigned.installation_id,files:[]},'invalid_input');
  for(const extra of [{supersedes:randomUUID()},{root_hash:hash('forged')},{project_root:'/not-read'},{claims_verified:true},{files:[]}])await callError(client,'memory_checkpoint_skill_usage',usage(extra),'invalid_input');
  await callError(client,'memory_checkpoint_skill_usage',usage({idempotency_key:'wrong-observation-version',skill_usage:[{skill_key:'remote-guide',version:'2',purpose:'잘못된 버전',observation_id:observation.observation_id}]}),'scope_mismatch');
 });
 await t.test('aliases and repository-relative path metadata explain feature and task matches without classifying unrelated history',async()=>{
  for(const [query,kind]of [['첨부 자료','feature_alias'],['src/library/file.ts','code_path']]){
   const next=await connect(jwt),features=await call('memory_list_features',{query},next);
   assert.equal(features.items.length,1);assert.equal(features.items[0].key,'library-feature-a');assert.equal(features.items[0].match_reasons.some(r=>r.kind===kind),true);
   assert.equal(features.classification,'explicit_links_only');assert.equal(features.items[0].claims_verified,false);
   const tasks=await call('memory_list_tasks',{query},next);assert.equal(tasks.items.some(task=>task.id===runId),true);
  }
  assert.equal((await call('memory_list_features',{query:'not-a-real-match'})).items.length,0);
  assert.equal((await all(f.db(),'SELECT count(*) n FROM run_features WHERE run_id=?',runId))[0].n,2);
 });
 await t.test('current-knowledge section offsets find later decisions, plans and features on fresh connections',async()=>{
  await call('memory_checkpoint',{run_id:runId,kind:'decision',topic:'library-policy',body:'조회 페이지 검사용 결정 원문',idempotency_key:'library-page-decision',
   decision:{subject:'library-page-policy',title:'스킬 테스트 정책',action:'decide',choice_key:'test',targets:[],expected_current_ids:[],source:{kind:'user_statement',reference:'synthetic test fixture',quote:'테스트 선택'}}});
  const next=await connect(jwt);let page=await call('memory_query_current_knowledge',{limit:1},next);
  assert.equal(page.claims_verified,false);assert.equal(page.agent_reports_promoted,false);
  for(const [section,cursor]of [['decisions','decisions_offset'],['plans','plans_offset'],['checks','features_offset']]){
   assert.equal(page[section].items.length,1);assert.notEqual(page[section].next_offset,null);
   const later=await call('memory_query_current_knowledge',{limit:1,[cursor]:page[section].next_offset},await connect(jwt));
   assert.equal(later[section].items.length,1);assert.notDeepEqual(later[section].items,page[section].items);
  }
  await callError(client,'memory_query_current_knowledge',{features_offset:-1},'invalid_input');
  await callError(client,'memory_list_features',{offset:100001},'invalid_input');
 });
 await t.test('all new tools enforce authentication, fixed scope, viewer writes and server-owned roots',async()=>{
  const viewer=await connect(viewerJwt),reads=[['memory_list_skills',{}],['memory_get_skill',{skill_key:'remote-guide'}],['memory_get_skill_package',{skill_key:'remote-guide',version:'1'}],
   ['memory_list_skill_history',{installation_id:assigned.installation_id,kind:'observations'}],['memory_list_task_skills',{run_id:runId}],['memory_list_features',{}],['memory_query_current_knowledge',{limit:1}]];
  for(const [name,args]of reads){await call(name,args,viewer);for(const extra of [{project_id:randomUUID()},{repository:'api'},{environment:'production'}])await callError(client,name,{...args,...extra},'access_denied');
   for(const token of ['',bobJwt]){const r=await fetch(request(name,args,token));assert.equal(r.status,token?403:401);assert.equal((await r.text()).includes(registration.body),false);}}
  for(const [name,args]of [['memory_register_skill',registration],['memory_assign_skill',assignment],['memory_checkpoint_skill_usage',usage()]])await callError(viewer,name,args,'access_denied');
  for(const token of ['',bobJwt,viewerJwt])await assert.rejects(inspect(f.db(),()=>auth(token)).inspect({installation_id:assigned.installation_id,idempotency_key:'denied-inspect'}),e=>[401,403].includes(e.status));
  let token=jwt;const pinned=inspect(f.db(),()=>auth(token));await pinned.inspect({installation_id:assigned.installation_id,idempotency_key:'pin-inspector'});token=viewerJwt;
  await assert.rejects(pinned.inspect({installation_id:assigned.installation_id,idempotency_key:'changed-inspector'}),{code:'scope_mismatch'});
  const otherRoot=()=>({root_hash:hash('other root')}),handler=createCloudMcpHandler(f.db(),config,undefined,undefined,otherRoot);
  const result=await handler(request('memory_get_receipt',{write_operation:'skill-register',idempotency_key:registration.idempotency_key}));assert.equal(value((await result.json()).result).found,false);
  const usageResponse=await handler(request('memory_list_task_skills',{run_id:runId})),items=value((await usageResponse.json()).result).items;
  assert.equal(items.find(i=>i.file_observation_status==='outside_host_root').file_observation,null);
  assert.equal((await call('memory_get_receipt',{write_operation:'skill-register',idempotency_key:registration.idempotency_key},viewer)).found,false);
 });
 await t.test('skill writes roll back on revocation and wrong-scope receipts cannot be returned or replayed',async()=>{
  const version=Number((await all(f.db(),'SELECT max(version) v FROM cloud_project_access WHERE issuer=? AND subject=? AND project_id=? AND repository=? AND environment=?',issuer,'alice',scope.project_id,scope.repository,scope.environment))[0].v);
  const access=new D1ProjectAccess(f.db()),before=(await all(f.db(),'SELECT revision FROM projects WHERE id=?',scope.project_id))[0].revision;
  const guarded=createCloudMcpHandler(wrapped(f.db(),{beforeBatch:()=>access.grant(alice,scope,'owner','revoked',version)}),config,undefined,undefined,provider);
  try{const r=await guarded(request('memory_register_skill',{...registration,skill_key:'must-roll-back',idempotency_key:'library-acl-race'}));assert.equal(r.status,403);
   assert.equal((await all(f.db(),'SELECT revision FROM projects WHERE id=?',scope.project_id))[0].revision,before);
   assert.equal((await all(f.db(),"SELECT count(*) n FROM skill_versions WHERE skill_key='must-roll-back'"))[0].n,0);
  }finally{await access.grant(alice,scope,'owner','active',version+1);}
  const input={...registration,skill_key:'receipt-scope',idempotency_key:'library-receipt-scope'};await call('memory_register_skill',input);
  const key=await cloudWriteKey(alice,hostScope,'skill-register',input.idempotency_key),[row]=await all(f.db(),'SELECT result_json FROM receipts WHERE scope=? AND idempotency_key=?',scope.project_id,key);
  const stored=JSON.parse(row.result_json);stored.scope.root_hash=hash('wrong');
  await f.db().prepare('UPDATE receipts SET result_json=? WHERE scope=? AND idempotency_key=?').bind(JSON.stringify(stored),scope.project_id,key).run();
  await callError(client,'memory_get_receipt',{write_operation:'skill-register',idempotency_key:input.idempotency_key},'scope_mismatch');await callError(client,'memory_register_skill',input,'scope_mismatch');
 });
 return {runId,observation,reportId};
}
