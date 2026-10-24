import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,mkdirSync,writeFileSync,readFileSync,renameSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openLocal} from '../dist/runtime/local/app.js';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
import {validateTaskSkillData} from '../dist/adapters/storage/sqlite/task-skills.js';
import {initialize,validateDatabase} from '../dist/adapters/storage/transfer/database.js';
import {backupDatabase,restoreDatabase} from '../dist/adapters/storage/transfer/snapshot.js';
import {exportProject,importProject} from '../dist/adapters/storage/transfer/project.js';
import {startViewer} from '../dist/transport/viewer/server.js';

async function setup(t) {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'skilly-task-skills-'))),db=join(root,'memory.sqlite');
  const binding={version:1,key:'task-skills-test',name:'스킬 버전 테스트',repository:'web',environment:'test'};
  writeFileSync(join(root,'skilly.project.json'),JSON.stringify(binding));
  const app=openLocal(db,binding,root);t.after(()=>app.close());
  const call=(name,input)=>app.dispatcher.call(name,input),pid=(await call('memory_resolve_project',{})).project.id;
  const rid=(await call('memory_begin_task',{project_id:pid,goal:'테스트용 일반 작업',mode:'change',actor:'Codex',idempotency_key:'begin'})).run.id;
  const register={project_id:pid,skill_key:'use-sample',version:'1',name:'검사 안내',source:'local:test',body:'# Sample\n원문 보존',install_instructions:'선택한 루트에 설치',idempotency_key:'register'};
  const version=await call('memory_register_skill',register),folder=join(root,'.agents/skills/use-sample');mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'SKILL.md'),register.body);
  const assigned=await call('memory_assign_skill',{project_id:pid,skill_key:'use-sample',version:'1',tool:'codex',folder:'use-sample',idempotency_key:'assign'});
  const inspect=key=>call('memory_check_skill_installation',{project_id:pid,installation_id:assigned.installation_id,idempotency_key:key});
  const usage=(extra={})=>({skill_key:'use-sample',version:'1',purpose:'작업 검사에 사용했다고 보고',...extra});
  const save=(key,rows=[usage()],extra={})=>call('memory_checkpoint',{project_id:pid,run_id:rid,topic:'sample',kind:'change',body:'보존할 원문 '+key,report_origin:'contemporaneous',idempotency_key:key,skill_usage:rows,...extra});
  const list=offset=>call('memory_list_task_skills',{project_id:pid,run_id:rid,...(offset===undefined?{}:{offset})});
  return {root,db,binding,app,call,pid,rid,register,version,folder,assigned,inspect,usage,save,list};
}

test('AI use report pins a catalog version without observing files; original, retry and correction remain distinct',async t=>{
  const f=await setup(t),a=await f.save('reported');
  assert.equal((await f.save('reported')).record_id,a.record_id);
  let rows=(await f.list()).items;assert.equal(rows.length,1);assert.equal(rows[0].content_hash,f.version.content_hash);
  assert.equal(rows[0].file_observation,null);assert.equal(rows[0].provenance,'agent_report');assert.equal(rows[0].claims_verified,false);assert.equal(rows[0].loading_status,'unknown');
  const evidence=await f.call('memory_get_evidence',{project_id:f.pid,record_id:a.record_id});
  assert.equal(evidence.record.body,'보존할 원문 reported');assert.equal(evidence.verified,false);assert.deepEqual(evidence.skill_usage.items,rows);
  await f.save('corrected',[f.usage({purpose:'정정 보고'})],{supersedes:a.record_id});
  rows=(await f.list()).items;assert.equal(rows.length,2);assert.equal(rows[1].report_state,'superseded');assert.equal(rows[0].report_state,'reported');
  await assert.rejects(f.save('reported',[f.usage({purpose:'다른 입력'})]),{code:'idempotency_conflict'});
  const raw=new DatabaseSync(f.db,{readOnly:true});assert.equal(raw.prepare('SELECT count(*) n FROM skill_observations').get().n,0);raw.close();
  await f.call('memory_register_skill',{...f.register,version:'literal ',idempotency_key:'literal-version'});
  await f.save('literal-report',[f.usage({version:'literal '})]);
  assert.equal((await f.list()).items[0].version,'literal ','Version identities follow the catalog literally, without normalization.');
});

test('saved file states and historical origin stay separate from loading and later version assignments',async t=>{
  const f=await setup(t),match=await f.inspect('match');await f.save('with-match',[f.usage({observation_id:match.observation_id})]);
  writeFileSync(join(f.folder,'SKILL.md'),'수정한 파일');const modified=await f.inspect('modified');await f.save('with-modified',[f.usage({observation_id:modified.observation_id})]);
  renameSync(join(f.folder,'SKILL.md'),join(f.folder,'preserved.md'));const missing=await f.inspect('missing');await f.save('with-missing',[f.usage({observation_id:missing.observation_id})]);
  symlinkSync(join(f.folder,'preserved.md'),join(f.folder,'SKILL.md'));const unavailable=await f.inspect('unavailable');
  await f.save('retrospective',[f.usage({observation_id:unavailable.observation_id})],{report_origin:'retrospective'});
  await f.call('memory_register_skill',{...f.register,version:'2',body:'새 버전',idempotency_key:'v2'});
  await f.call('memory_assign_skill',{project_id:f.pid,skill_key:'use-sample',version:'2',tool:'codex',folder:'use-sample',idempotency_key:'assign-v2'});
  const items=(await f.list()).items;assert.deepEqual(items.map(x=>x.file_observation.state),['unavailable','missing','modified','matches']);
  assert.equal(items[0].report_origin,'retrospective');
  for(const row of items){assert.equal(row.version,'1');assert.equal(row.file_observation.expected_hash,f.version.content_hash);assert.equal(row.claims_verified,false);assert.equal(row.loading_status,'unknown');}
  const raw=new DatabaseSync(f.db,{readOnly:true});validateDatabase(raw);raw.close();
  assert.equal(readFileSync(join(f.folder,'preserved.md'),'utf8'),'수정한 파일');
});

test('reject guessed versions, forged observation fields, wrong skills/versions and out-of-scope roots',async t=>{
  const f=await setup(t),o=await f.inspect('observed');
  await assert.rejects(f.save('unknown',[f.usage({version:'guessed'})]),{code:'not_found'});
  await assert.rejects(f.save('forged',[f.usage({state:'matches'})]),{code:'invalid_input'});
  await assert.rejects(f.save('duplicate',[f.usage(),f.usage()]),{code:'invalid_input'});
  await assert.rejects(f.save('missing',[f.usage({observation_id:randomUUID()})]),{code:'scope_mismatch'});
  await f.call('memory_register_skill',{...f.register,version:'2',idempotency_key:'v2'});
  await assert.rejects(f.save('wrong-version',[f.usage({version:'2',observation_id:o.observation_id})]),{code:'scope_mismatch'});
  await f.call('memory_register_skill',{...f.register,skill_key:'another',idempotency_key:'another'});
  await assert.rejects(f.save('wrong-key',[f.usage({skill_key:'another',observation_id:o.observation_id})]),{code:'scope_mismatch'});
  const wrongRoot=realpathSync(mkdtempSync(join(tmpdir(),'skilly-wrong-root-'))),other=openLocal(f.db,f.binding,wrongRoot),unbound=openLocal(f.db);t.after(()=>other.close());t.after(()=>unbound.close());
  for(const a of [other,unbound]) await assert.rejects(a.dispatcher.call('memory_checkpoint',{project_id:f.pid,run_id:f.rid,topic:'sample',kind:'note',body:'다른 루트',idempotency_key:'root-'+randomUUID(),skill_usage:[f.usage({observation_id:o.observation_id})]}),{code:'scope_mismatch'});
  assert.equal((await unbound.dispatcher.call('memory_checkpoint',{project_id:f.pid,run_id:f.rid,topic:'sample',kind:'note',body:'관측 없는 보고만',idempotency_key:'unbound-report',skill_usage:[f.usage()]})).status,'persisted');
  const recovery=await f.call('memory_recovery_status',{project_id:f.pid});assert.equal(recovery.requests.length,0);
});

test('foreign repository/project observations cannot be attached; closed tasks and query scopes stay bounded',async t=>{
  const f=await setup(t),o=await f.inspect('own');
  const other=openLocal(f.db,{...f.binding,repository:'api'},f.root);t.after(()=>other.close());
  const r=(await other.dispatcher.call('memory_begin_task',{project_id:f.pid,goal:'API',mode:'change',idempotency_key:'api'})).run.id;
  await assert.rejects(other.dispatcher.call('memory_checkpoint',{project_id:f.pid,run_id:r,topic:'sample',kind:'note',body:'foreign',idempotency_key:'foreign',skill_usage:[f.usage({observation_id:o.observation_id})]}),{code:'scope_mismatch'});
  await assert.rejects(other.dispatcher.call('memory_list_task_skills',{project_id:f.pid,run_id:f.rid}),{code:'scope_mismatch'});
  const unbound=openLocal(f.db);t.after(()=>unbound.close());const pid=(await unbound.dispatcher.call('memory_register_project',{key:'foreign',name:'Foreign',idempotency_key:'foreign-project'})).project.id;
  await unbound.dispatcher.call('memory_register_skill',{...f.register,project_id:pid,idempotency_key:'foreign-version'});
  const foreignRun=(await unbound.dispatcher.call('memory_begin_task',{project_id:pid,goal:'Foreign',mode:'change',repository:'web',environment:'test',idempotency_key:'foreign-run'})).run.id;
  await assert.rejects(unbound.dispatcher.call('memory_checkpoint',{project_id:pid,run_id:foreignRun,topic:'sample',kind:'note',body:'foreign',idempotency_key:'foreign-observation',skill_usage:[f.usage({observation_id:o.observation_id})]}),{code:'scope_mismatch'});
  await f.call('memory_finish_task',{project_id:f.pid,run_id:f.rid,summary:'종료',outcome:'completed',idempotency_key:'finish'});
  await assert.rejects(f.save('closed'),{code:'run_closed'});await assert.rejects(f.list(-1),{code:'invalid_input'});
});

test('failed metadata insert rolls back original and receipt; original retained request recovers exactly once',async t=>{
  const f=await setup(t),raw=new DatabaseSync(f.db);t.after(()=>raw.close());
  raw.exec("CREATE TRIGGER fail_usage BEFORE INSERT ON task_skill_usage BEGIN SELECT RAISE(ABORT,'fixture'); END;");
  const before=raw.prepare('SELECT count(*) n FROM records').get().n;let failure;
  try{await f.save('atomic');}catch(error){failure=error;}
  assert.equal(failure.code,'storage_error');assert.equal(raw.prepare('SELECT count(*) n FROM records').get().n,before);
  assert.equal(raw.prepare("SELECT count(*) n FROM receipts WHERE idempotency_key='atomic'").get().n,0);
  raw.exec('DROP TRIGGER fail_usage');
  const saved=await f.call('memory_retry_write',{project_id:f.pid,request_id:failure.recovery.request_id});
  assert.equal((await f.save('atomic')).record_id,saved.record_id);assert.equal((await f.list()).items.length,1);
});

test('pagination and record evidence preserve repeated skill reports without substituting latest observations',async t=>{
  const f=await setup(t);for(let n=0;n<10;n++)await f.save('page-'+n);
  const a=await f.list(),b=await f.list(a.next_offset);assert.equal(a.items.length,8);assert.equal(a.next_offset,8);assert.equal(b.items.length,2);assert.equal(b.next_offset,null);
  const ids=[...a.items,...b.items].map(x=>x.record_id);assert.equal(new Set(ids).size,10);
  const exact=await f.call('memory_get_evidence',{project_id:f.pid,record_id:ids[9]});assert.equal(exact.skill_usage.items.length,1);assert.equal(exact.skill_usage.items[0].record_id,ids[9]);
  const viewer=new SqliteViewer(f.db);t.after(()=>viewer.close());assert.deepEqual(viewer.taskSkills(f.pid,f.rid,8),b);
});

test('fresh MCP and authenticated HTTP return the same saved task skill evidence',async t=>{
  const f=await setup(t),o=await f.inspect('observed');await f.save('linked',[f.usage({observation_id:o.observation_id})]);
  const viewer=await startViewer({db:f.db});t.after(()=>viewer.close());const url=new URL(viewer.url),token=new URLSearchParams(url.hash.slice(1)).get('token');
  const path=url.origin+'/api/runs/'+f.rid+'/skills?project='+f.pid;
  assert.equal((await fetch(path)).status,401);assert.equal((await fetch(path,{headers:{Authorization:'Bearer '+token,Origin:'https://foreign.invalid'}})).status,403);
  const transport=new StdioClientTransport({command:process.execPath,args:[new URL('../dist/runtime/local/main.js',import.meta.url).pathname,'serve','--db',f.db,'--project',f.root],stderr:'pipe'}),client=new Client({name:'task-skill-test',version:'1'});transport.stderr.resume();t.after(()=>client.close());await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(x=>x.name==='memory_list_task_skills'));
  const result=await client.callTool({name:'memory_list_task_skills',arguments:{project_id:f.pid,run_id:f.rid}}),mcp=JSON.parse(result.content[0].text);
  const http=await fetch(path,{headers:{Authorization:'Bearer '+token}}).then(r=>r.json());assert.deepEqual(mcp,http);assert.deepEqual(http,await f.list());
  assert.equal(http.items[0].file_observation.state,'matches');assert.equal(http.items[0].loading_status,'unknown');
  assert.equal((await fetch(url.origin+'/task-skills.js')).status,200);assert.equal((await fetch(url.origin+'/task-skills.css')).status,200);
});

test('backup/restore and project transfer preserve historical links; corrupt identities are rejected',async t=>{
  const f=await setup(t),o=await f.inspect('observed');await f.save('linked',[f.usage({observation_id:o.observation_id})]);
  await f.call('memory_register_skill',{...f.register,version:'2',body:'updated',idempotency_key:'v2'});
  await f.call('memory_assign_skill',{project_id:f.pid,skill_key:'use-sample',version:'2',tool:'codex',folder:'use-sample',idempotency_key:'v2-assign'});
  const before=await f.list();const backup=join(f.root,'backup'),restore=join(f.root,'restore'),bundle=join(f.root,'bundle'),imported=join(f.root,'imported');
  await backupDatabase(f.db,backup);await restoreDatabase(backup,restore);exportProject(f.db,f.pid,bundle);await importProject(bundle,imported);
  for(const directory of [restore,imported]){const app=openLocal(join(directory,'memory.sqlite'));try{assert.deepEqual(await app.dispatcher.call('memory_list_task_skills',{project_id:f.pid,run_id:f.rid}),before);}finally{await app.close();}}
  const raw=new DatabaseSync(join(imported,'memory.sqlite'));t.after(()=>raw.close());assert.throws(()=>raw.exec("UPDATE task_skill_usage SET version='2'"));raw.exec('DROP TRIGGER task_skill_usage_update');raw.exec("UPDATE task_skill_usage SET content_hash='"+'b'.repeat(64)+"'");assert.throws(()=>validateTaskSkillData(raw));assert.throws(()=>validateDatabase(raw));
});

test('legacy reads remain uncollected without migration; explicit writer upgrades v14 without rewriting originals',async t=>{
  const f=await setup(t),old=join(f.root,'legacy.sqlite'),raw=new DatabaseSync(old);initialize(raw,false,14);
  raw.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run(f.pid,'legacy','Legacy',0,'2026-10-23T00:00:00Z');
  raw.prepare('INSERT INTO runs VALUES(?,?,?,?,?,?,?,?,?)').run(f.rid,f.pid,'보존할 작업','change','test','web','completed','2026-10-23T00:00:00Z','2026-10-23T00:00:00Z');raw.close();
  const reader=new SqliteViewer(old);assert.equal(reader.taskSkills(f.pid,f.rid).schema_supported,false);assert.equal(reader.detail(f.pid,f.rid).skill_usage.schema_supported,false);reader.close();
  const check=new DatabaseSync(old,{readOnly:true});assert.equal(check.prepare('PRAGMA user_version').get().user_version,14);const original=check.prepare('SELECT * FROM runs').all();check.close();
  const app=openLocal(old);await app.close();const upgraded=new DatabaseSync(old,{readOnly:true});assert.equal(upgraded.prepare('PRAGMA user_version').get().user_version,15);assert.deepEqual(upgraded.prepare('SELECT * FROM runs').all(),original);validateDatabase(upgraded);upgraded.close();
});
