import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {fixture,project,run,checkpoint} from './helpers.mjs';
import {assessFeatureKnowledge} from '../dist/core/work/knowledge.js';
import {SqliteWorkReader} from '../dist/adapters/storage/sqlite/work.js';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
import {startViewer} from '../dist/transport/viewer/server.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const before={version:1,root_hash:'a'.repeat(64),project_key:'example',repository:'default',environment:'development',observed_at:'2026-10-22T00:00:00Z',status:'clean',commit:'b'.repeat(40),reason:null};
const details=failed=>({status:'collected',framework:'node_test',counts:{tests:1,passed:failed?0:1,failed:failed?1:0,cancelled:0,skipped:0,todo:0,suites:0},suite_success:!failed,failures:failed?['synthetic failure']:[],failures_truncated:false});
const observation=(extra={})=>({id:randomUUID(),run_id:randomUUID(),record_id:null,repository:'default',environment:'development',command_hash:'c'.repeat(64),outcome:'exited',exit_code:0,output_complete:1,before,after:before,current:before,test_details:details(false),...extra});
test('current, stale, conflict and unknown refer only to comparable direct test observations',()=>{
 const good=observation(),bad=observation({exit_code:1,test_details:details(true)});
 const current=assessFeatureKnowledge([good]);assert.equal(current.status,'current');assert.equal(current.evidence[0].current_commit,before.commit);assert.equal(current.claims_verified,false);assert.equal(current.agent_reports_promoted,false);assert.equal(current.dependencies_and_runtime_verified,false);
 assert.equal(assessFeatureKnowledge([observation({current:{...before,commit:'d'.repeat(40)}})]).status,'stale');
 assert.equal(assessFeatureKnowledge([observation({current:{...before,status:'dirty',reason:'working_tree_changed'}})]).status,'unknown');
 assert.equal(assessFeatureKnowledge([observation({current:undefined})]).status,'unknown');
 assert.equal(assessFeatureKnowledge([]).status,'unknown');
 assert.equal(assessFeatureKnowledge([observation({test_details:{status:'not_collected',reason:'legacy'},current:{...before,commit:'d'.repeat(40)}})]).status,'unknown');
 assert.equal(assessFeatureKnowledge([observation({current:{...before,commit:'d'.repeat(40),status:'dirty',reason:'working_tree_changed'}})]).status,'unknown');
 assert.equal(assessFeatureKnowledge([observation({after:{...before,commit:'d'.repeat(40),status:'dirty',reason:'working_tree_changed'}})]).status,'unknown');
 const conflict=assessFeatureKnowledge([good,bad]);assert.equal(conflict.status,'conflict');assert.deepEqual(conflict.conflicts[0].execution_ids,[good.id,bad.id]);
 const sampled={...before,worktree:{policy:'public_source_v1',status:'collected',sha256:'e'.repeat(64),files:1,bytes:1,excluded:0}};
 assert.equal(assessFeatureKnowledge([bad,observation({before:sampled,after:sampled,current:sampled})]).status,'conflict');
 const separate=assessFeatureKnowledge([good,{...bad,command_hash:'d'.repeat(64)}]);assert.equal(separate.status,'current');assert.equal(separate.counts.failed,1);assert.equal(separate.conflicts.length,0);
 for(const other of [{repository:'other'},{environment:'stage'},{before:{...before,root_hash:'d'.repeat(64)},after:{...before,root_hash:'d'.repeat(64)},current:{...before,root_hash:'d'.repeat(64)}}])assert.equal(assessFeatureKnowledge([good,{...bad,...other}]).conflicts.length,0);
 assert.equal(assessFeatureKnowledge([good],true).status,'unknown');assert.equal(assessFeatureKnowledge([good],true).reason,'observation_limit_exceeded');
 assert.equal(assessFeatureKnowledge([good,bad],true).status,'conflict');
 const mixed=assessFeatureKnowledge([good,observation({before:{...before,commit:'d'.repeat(40)},after:{...before,commit:'d'.repeat(40)}})]);assert.equal(mixed.status,'current');assert.equal(mixed.counts.stale,1);
});
test('exit zero, AI prose, incomplete or cancelled checks never establish current test evidence',()=>{
 for(const extra of [{test_details:{status:'not_collected',reason:'unsupported_command'}},{outcome:'unconfirmed'},{outcome:'timed_out'},{output_complete:0},{test_details:{...details(false),counts:{...details(false).counts,passed:0,skipped:1}}},{test_details:{...details(false),counts:{...details(false).counts,passed:0,cancelled:1}}},{test_details:{...details(false),counts:{...details(false).counts,passed:0,todo:1}}},{exit_code:1},{test_details:details(true)}])assert.equal(assessFeatureKnowledge([observation(extra)]).status,'unknown');
});
function saveExecution(f,pid,rid,extra={}){
 const id=f.app.executions.start({project_id:pid,run_id:rid,executable:'node',command_hash:'c'.repeat(64),source_observation:before});
 f.app.executions.finish(id,{outcome:'exited',exit_code:0,signal:null,error_code:null,duration_ms:1,stdout_bytes:0,stderr_bytes:0,stdout_hash:null,stderr_hash:null,stdout_hashed_bytes:0,stderr_hashed_bytes:0,output_complete:1,...extra},details(Boolean(extra.exit_code)),before);return id;
}
test('feature projection preserves originals, scopes and source lookup bounds; AI-only stays unknown',async t=>{
 const f=fixture(t),pid=await project(f.call),feature={key:'sample',name:'샘플'};
 const rid=await run(f.call,pid,{features:[feature]});const report=await f.call('memory_checkpoint',checkpoint(pid,rid,{report_origin:"contemporaneous",report:{title:'완료 주장',summary:'AI 보고',feature_updates:[{key:'sample',state:'implemented',summary:'구현했다고 보고'}]}}));
 let ai=await f.call('memory_query_overview',{project_id:pid,view:'features'});assert.equal(ai.items[0].current_knowledge.status,'unknown');
 saveExecution(f,pid,rid);const raw=new DatabaseSync(f.path,{readOnly:true});t.after(()=>raw.close());let lookups=0;
 const reader=new SqliteWorkReader(raw,Date.now,()=>{lookups++;return before;});
 const query={project_id:pid,view:'features',offset:0,limit:40};const current=reader.overview(query).items[0];assert.equal(current.current_knowledge.status,'current');assert.equal(current.latest_report.verified,false);assert.equal(lookups,1);
 saveExecution(f,pid,rid,{exit_code:1});assert.equal(reader.overview(query).items[0].current_knowledge.status,'conflict');
 const other=await run(f.call,pid,{repository:'other',features:[feature],idempotency_key:'other'});
 const noScope=reader.overview({...query,repository:'other'});assert.equal(noScope.items[0].current_knowledge.status,'unknown');assert.equal(noScope.items[0].current_knowledge.evidence.length,0);
 assert.equal(reader.overview({...query,component:'unclassified'}).items[0].current_knowledge.status,'conflict');
 const p2=await project(f.call,'second');assert.equal(reader.overview({...query,project_id:p2}).items.length,0);
 assert.equal((await f.call('memory_get_evidence',{project_id:pid,record_id:report.record_id})).record.body,'댓글 해결 상태 저장 처리 추가');
 const snapshot=readFileSync(f.path);reader.overview(query);assert.deepEqual(readFileSync(f.path),snapshot);
});
test('bounded projection discloses omitted observations and does not promote a partial window',async t=>{
 const f=fixture(t),pid=await project(f.call),rid=await run(f.call,pid,{features:[{key:'many',name:'Many'}]});
 for(let i=0;i<41;i++)saveExecution(f,pid,rid);
 const raw=new DatabaseSync(f.path,{readOnly:true});t.after(()=>raw.close());const reader=new SqliteWorkReader(raw,Date.now,()=>before);
 const row=reader.overview({project_id:pid,view:'features',offset:0,limit:40}).items[0];assert.equal(row.current_knowledge.status,'unknown');assert.equal(row.current_knowledge.truncated,true);assert.equal(row.current_knowledge.evidence.length,8);assert.equal(row.current_knowledge.evidence_truncated,true);assert.equal(row.current_knowledge.scanned,40);
 assert.ok(Buffer.byteLength(JSON.stringify(row))<30*1024);
});
test('fresh MCP and authenticated HTTP share the same unknown reason without configured roots',async t=>{
 const f=fixture(t),pid=await project(f.call),rid=await run(f.call,pid,{features:[{key:'sample',name:'Sample'}]});saveExecution(f,pid,rid);
 const client=new Client({name:'knowledge-check',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['dist/runtime/local/main.js','serve','--db',f.path],stderr:'pipe'});transport.stderr.on('data',()=>{});await client.connect(transport);t.after(()=>client.close());
 const result=await client.callTool({name:'memory_query_overview',arguments:{project_id:pid,view:'features'}});const ai=JSON.parse(result.content[0].text);
 const server=await startViewer({db:f.path});t.after(()=>server.close());const token=new URLSearchParams(new URL(server.url).hash.slice(1)).get('token');
 assert.equal((await fetch(server.origin+'/api/overview?project='+pid+'&view=features')).status,401);
 const http=await fetch(server.origin+'/api/overview?project='+pid+'&view=features',{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());
 assert.deepEqual(http.items[0].current_knowledge,ai.items[0].current_knowledge);assert.equal(ai.items[0].current_knowledge.status,'unknown');assert.equal(ai.items[0].current_knowledge.evidence[0].reason,'comparison_root_not_configured');
 const viewer=new SqliteViewer(f.path);t.after(()=>viewer.close());assert.deepEqual(viewer.overview(pid,'features').items[0].current_knowledge,ai.items[0].current_knowledge);
});
