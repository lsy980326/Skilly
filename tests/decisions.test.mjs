import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {realpathSync} from 'node:fs';
import {validateDecisionData} from '../dist/adapters/storage/sqlite/decisions.js';
import {fixture,project,run,checkpoint} from './helpers.mjs';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
import {startViewer} from '../dist/transport/viewer/server.js';
import {openLocal} from '../dist/runtime/local/app.js';
import {initialize,validateDatabase} from '../dist/adapters/storage/transfer/database.js';
import {backupDatabase,restoreDatabase} from '../dist/adapters/storage/transfer/snapshot.js';
import {exportProject,importProject} from '../dist/adapters/storage/transfer/project.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const metadata=(extra={})=>({subject:'storage-policy',title:'기록 보관 방식',action:'decide',choice_key:'db-only',targets:[],expected_current_ids:[],
 source:{kind:'user_statement',reference:'현재 대화의 사용자 요청',quote:'작업일지는 DB에만 남겨줘.'},...extra});
async function setup(t){const f=fixture(t),pid=await project(f.call),rid=await run(f.call,pid,{components:[{key:'web',name:'Web'}],features:[{key:'storage',name:'보관'}]});
 const save=(key,d=metadata(),extra={})=>f.call('memory_checkpoint',checkpoint(pid,rid,{kind:'decision',topic:'storage-policy',body:key,report_origin:'contemporaneous',idempotency_key:key,decision:d,...extra}));
 const query=(extra={})=>f.call('memory_query_decisions',{project_id:pid,subject:'storage-policy',...extra});return {...f,path:realpathSync(f.path),directory:realpathSync(f.directory),pid,rid,save,query};}

test('replacement and withdrawal append originals, preserve retries and never restore an ancestor',async t=>{
 const f=await setup(t);const a=await f.save('DB에만 보관');
 const bInput=metadata({action:'replace',choice_key:'db-and-export',targets:[a.record_id],expected_current_ids:[a.record_id]});
 const b=await f.save('DB와 요청한 내보내기 허용',bInput);assert.equal((await f.save('DB와 요청한 내보내기 허용',bInput)).record_id,b.record_id);
 let state=(await f.query()).items[0];assert.equal(state.status,'current');assert.deepEqual(state.active_record_ids,[b.record_id]);
 assert.equal(state.history.find(e=>e.record_id===a.record_id).state,'previous');
 await f.save('내보내기 결정을 철회',metadata({action:'withdraw',choice_key:undefined,targets:[b.record_id],expected_current_ids:[b.record_id]}));
 state=(await f.query()).items[0];assert.equal(state.status,'withdrawn');assert.deepEqual(state.active_record_ids,[]);
 for(const id of [a.record_id,b.record_id]){const e=await f.call('memory_get_evidence',{project_id:f.pid,record_id:id});assert.equal(e.verified,false);assert.equal(e.record.superseded_by,null);assert.equal(e.record.supersedes,null);}
 assert.equal((await f.call('memory_get_evidence',{project_id:f.pid,record_id:a.record_id})).record.body,'DB에만 보관');
 assert.equal(state.claims_verified,false);
});

test('explicit competing choices conflict; AI proposals and retrospective statements never override them',async t=>{
 const f=await setup(t),a=await f.save('DB 사용'),b=await f.save('MD 사용',metadata({choice_key:'markdown',expected_current_ids:[a.record_id]}));
 const ids=[a.record_id,b.record_id];assert.equal((await f.query()).items[0].status,'conflict');
 await f.save('AI는 다른 방식을 제안',metadata({action:'propose',choice_key:'other',expected_current_ids:ids,source:{kind:'agent_proposal',reference:'AI 제안',quote:'다른 방식은 어떨까요?'}}));
 await f.save('옛 결정을 소급 등록',metadata({choice_key:'old',expected_current_ids:ids}),{report_origin:'retrospective'});
 let item=(await f.query()).items[0];assert.equal(item.status,'conflict');assert.deepEqual(item.active_record_ids,ids);
 assert.equal(item.history[0].state,'historical');assert.equal(item.history[1].state,'proposal');
 await f.save('두 선택을 DB로 정정',metadata({action:'replace',targets:ids,expected_current_ids:ids}));
 item=(await f.query()).items[0];assert.equal(item.status,'current');assert.equal(item.active_choices[0].choice_key,'db-only');
 await assert.rejects(f.save('stale',metadata()),{code:'conflict'});
 const bad=metadata({action:'replace',targets:[a.record_id],expected_current_ids:item.active_record_ids});
 await assert.rejects(f.save('old-target',bad),{code:'scope_mismatch'});
 await assert.rejects(f.save('not-a-decision',metadata(),{kind:'note'}),{code:'invalid_input'});
 await assert.rejects(f.call('memory_checkpoint',checkpoint(f.pid,f.rid,{topic:'storage-policy',kind:'decision',supersedes:a.record_id,idempotency_key:'bypass'})),{code:'invalid_input'});
});

test('scope and optimistic concurrency reject foreign targets; failed metadata insert rolls back original and receipt',async t=>{
 const f=await setup(t),a=await f.save('common'),d=metadata({component_key:'web',feature_key:'storage'}),web=await f.save('web',d);
 await assert.rejects(f.save('foreign',metadata({...d,action:'replace',targets:[a.record_id],expected_current_ids:[web.record_id]})),{code:'scope_mismatch'});
 await assert.rejects(f.save('undeclared',metadata({component_key:'mobile'})),{code:'scope_mismatch'});
 const selected=(await f.query({component:'web'})).items;assert.equal(selected.length,1);assert.deepEqual(selected[0].active_record_ids,[web.record_id]);
 const raw=new DatabaseSync(f.path);t.after(()=>raw.close());const count=()=>raw.prepare('SELECT count(*) n FROM records').get().n,before=count();
 raw.exec("CREATE TRIGGER fail_decision BEFORE INSERT ON decision_events BEGIN SELECT RAISE(ABORT,'fixture'); END;");
 const changed=metadata({action:'replace',choice_key:'changed',targets:[a.record_id],expected_current_ids:[a.record_id]});
 let error;try{await f.save('atomic',changed);}catch(e){error=e;}
 assert.equal(error.code,'storage_error');assert.equal(count(),before);assert.equal(raw.prepare("SELECT count(*) n FROM receipts WHERE idempotency_key='atomic'").get().n,0);
 raw.exec('DROP TRIGGER fail_decision');
 const retry=await f.call('memory_retry_write',{project_id:f.pid,request_id:error.recovery.request_id});assert.equal(retry.status,'persisted');
 assert.deepEqual((await f.query({component:'',feature:''})).items[0].active_record_ids,[retry.record_id]);
});

test('fresh MCP and authenticated HTTP share decision state; reads and old DBs are not migrated',async t=>{
 const f=await setup(t),a=await f.save('DB 사용');
 const view=await startViewer({db:f.path});t.after(()=>view.close());const origin=new URL(view.url).origin,token=new URLSearchParams(new URL(view.url).hash.slice(1)).get('token');
 assert.equal((await fetch(origin+'/api/decisions?project='+f.pid)).status,401);
 assert.equal((await fetch(origin+'/api/decisions?project='+f.pid,{headers:{Authorization:'Bearer '+token,Origin:'https://untrusted.invalid'}})).status,403);
 const transport=new StdioClientTransport({command:process.execPath,args:[new URL('../dist/runtime/local/main.js',import.meta.url).pathname,'serve','--db',f.path],stderr:'pipe'}),c=new Client({name:'decision-fixture',version:'1'});transport.stderr.resume();t.after(()=>c.close());await c.connect(transport);
 const result=await c.callTool({name:'memory_query_decisions',arguments:{project_id:f.pid,subject:'storage-policy'}}),mcp=JSON.parse(result.content[0].text);
 const http=await fetch(origin+'/api/decisions?project='+f.pid+'&subject=storage-policy',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());
 assert.deepEqual(http,mcp);assert.deepEqual(http.items[0].active_record_ids,[a.record_id]);
 const before=(await f.call('memory_get_evidence',{project_id:f.pid,record_id:a.record_id})).record;
 assert.deepEqual((await f.call('memory_get_evidence',{project_id:f.pid,record_id:a.record_id})).record,before);
 const legacy=join(f.directory,'legacy.sqlite'),db=new DatabaseSync(legacy);initialize(db,false,12);db.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(f.pid,'old','Old',0,new Date().toISOString());db.close();
 const reader=new SqliteViewer(legacy);assert.equal(reader.decisions(f.pid,{query:'',offset:0,limit:12}).schema_supported,false);reader.close();
 const check=new DatabaseSync(legacy,{readOnly:true});assert.equal(check.prepare('PRAGMA user_version').get().user_version,12);check.close();
});

test('backup/restore and one-project transfer preserve full decision graph and reject corrupted targets',async t=>{
 const f=await setup(t),a=await f.save('first');await f.save('second',metadata({action:'replace',choice_key:'second',targets:[a.record_id],expected_current_ids:[a.record_id]}));
 const before=await f.query(),backup=join(f.directory,'backup'),restored=join(f.directory,'restored'),bundle=join(f.directory,'bundle'),imported=join(f.directory,'imported');
 await backupDatabase(f.path,backup);await restoreDatabase(backup,restored);exportProject(f.path,f.pid,bundle);await importProject(bundle,imported);
 for(const folder of [restored,imported]){const app=openLocal(join(folder,'memory.sqlite'));try{const after=await app.dispatcher.call('memory_query_decisions',{project_id:f.pid,subject:'storage-policy'});assert.equal(after.items[0].status,'current');assert.deepEqual(after.items[0].active_record_ids,before.items[0].active_record_ids);assert.deepEqual(after.items[0].history.map(e=>[e.record_id,e.body,e.decision]),before.items[0].history.map(e=>[e.record_id,e.body,e.decision]));}finally{await app.close();}}
 const bad=new DatabaseSync(join(imported,'memory.sqlite'));try{const row=bad.prepare('SELECT * FROM decision_events WHERE record_id<>?').get(a.record_id),d=JSON.parse(row.metadata_json);d.targets=[row.record_id];assert.throws(()=>bad.prepare('UPDATE decision_events SET metadata_json=? WHERE record_id=?').run(JSON.stringify(d),row.record_id));bad.exec('DROP TRIGGER decision_metadata_update');bad.prepare('UPDATE decision_events SET metadata_json=? WHERE record_id=?').run(JSON.stringify(d),row.record_id);assert.throws(()=>validateDecisionData(bad));}finally{bad.close();}
});

test('complete scope lookup includes a thirteenth task link and unclassified is a valid subject/feature',async t=>{
 const f=await setup(t);
 for(let batch=0;batch<2;batch++)await f.call('memory_checkpoint',checkpoint(f.pid,f.rid,{idempotency_key:'links-'+batch,
   components:Array.from({length:7},(_,i)=>({key:'c'+(batch*7+i),name:'C'+(batch*7+i)})),features:Array.from({length:7},(_,i)=>({key:'f'+(batch*7+i),name:'F'+(batch*7+i)}))}));
 await f.save('thirteenth',metadata({component_key:'c13',feature_key:'f13'}));
 assert.equal((await f.query({component:'c13',feature:'f13'})).items[0].status,'current');
 await f.call('memory_checkpoint',checkpoint(f.pid,f.rid,{features:[{key:'unclassified',name:'실제 기능 키'}],idempotency_key:'feature-name'}));
 const d=metadata({subject:'unclassified',feature_key:'unclassified'});await f.save('literal-subject',d);
 assert.equal((await f.query({subject:'unclassified',feature:'unclassified'})).items.length,1);
 assert.equal((await f.query({subject:'unclassified',feature:''})).items.length,0);
});

test('large Korean histories page forward while keeping complete active IDs and bounded responses',async t=>{
 const f=await setup(t),a=await f.save('active');
 for(let i=0;i<25;i++)await f.save('long-'+i,metadata({action:'propose',title:'제'.repeat(160),expected_current_ids:[a.record_id],
 source:{kind:'agent_proposal',reference:'참'.repeat(300),quote:'가'.repeat(800)}}),{body:'나'.repeat(16000)});
 const ids=new Set();let offset=0;
 do{const response=await f.query({history_offset:offset});assert(Buffer.byteLength(JSON.stringify(response))<85*1024);const item=response.items[0];
   assert.equal(item.active_ids_complete,true);assert.deepEqual(item.active_record_ids,[a.record_id]);for(const e of item.history)ids.add(e.record_id);
   const next=item.history_next_offset;if(next!==null)assert(next>offset);offset=next;
 }while(offset!==null);
 assert.equal(ids.size,26);
});

test('storage guard blocks generic old-writer updates and leaves legacy records mutable by explicit correction',async t=>{
 const f=await setup(t),a=await f.save('immutable');const db=new DatabaseSync(f.path);t.after(()=>db.close());
 assert.throws(()=>db.prepare('UPDATE records SET superseded_by=? WHERE project_id=? AND id=?').run(a.record_id,f.pid,a.record_id));
 assert.throws(()=>db.prepare('UPDATE records SET body=? WHERE project_id=? AND id=?').run('changed',f.pid,a.record_id));
 assert.throws(()=>db.prepare('DELETE FROM records WHERE id=?').run(a.record_id));
 assert.equal(db.prepare('SELECT body FROM records WHERE id=?').get(a.record_id).body,'immutable');validateDatabase(db);
 const legacy=await f.call('memory_checkpoint',checkpoint(f.pid,f.rid,{kind:'decision',topic:'legacy',idempotency_key:'legacy'}));
 await f.call('memory_checkpoint',checkpoint(f.pid,f.rid,{kind:'decision',topic:'legacy',supersedes:legacy.record_id,idempotency_key:'legacy-corrected'}));
});
