import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,realpathSync,symlinkSync,renameSync} from 'node:fs';
import {fixture,project,run} from './helpers.mjs';
import {observeSource} from '../dist/adapters/project/source-version.js';
import {fingerprintWorktree} from '../dist/adapters/project/worktree-fingerprint.js';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {initialize,validateDatabase} from '../dist/adapters/storage/transfer/database.js';
import {backupDatabase,restoreDatabase} from '../dist/adapters/storage/transfer/snapshot.js';
import {exportProject,importProject} from '../dist/adapters/storage/transfer/project.js';
import {compareExecutionSource,sourceObservationSchema} from '../dist/core/execution/currentness.js';
import {openLocal} from '../dist/runtime/local/app.js';
import {startViewer} from '../dist/transport/viewer/server.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const exec=promisify(execFile),main=realpathSync('dist/runtime/local/main.js');
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function setup(t){
 const f=fixture(t),root=join(realpathSync(f.directory),'project');mkdirSync(root);
 const binding={version:1,key:'example',name:'example',repository:'default',environment:'development'};
 for(const [name,text] of Object.entries({'skilly.project.json':JSON.stringify(binding),'source.mjs':'export const value = 1;\n',
  'check.test.mjs':"import test from 'node:test';import assert from 'node:assert/strict';import {value} from './source.mjs';test('value matches requested behavior',()=>assert.equal(value,2));\n",'.gitignore':'.env\nignored.ts\n'}))writeFileSync(join(root,name),text);
 git(root,'init');git(root,'add','.');git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','fixture');
 const pid=await project(f.call),rid=await run(f.call,pid,{features:[{key:'fixture',name:'Fixture'}]});
 return {...f,root,binding,pid,rid};
}
async function execute(f,args=['--test','check.test.mjs']){
 try {const r=await exec(process.execPath,[main,'exec','--db',realpathSync(f.path),'--project',f.root,'--run-id',f.rid,'--',process.execPath,...args],{timeout:20000,env:{...process.env,NODE_TEST_CONTEXT:undefined}});return JSON.parse(r.stdout);}
 catch(error){if(error.stdout)return JSON.parse(error.stdout);throw error;}
}
function list(f){const app=openLocal(realpathSync(f.path),f.binding,f.root);try{return app.executions.list(f.pid,f.rid);}finally{void app.close();}}
test('dirty code matches only collected endpoints; fresh MCP and authenticated HTTP preserve results and source rows',async t=>{
 const f=await setup(t);writeFileSync(join(f.root,'source.mjs'),'export const value = 2;\n');
 mkdirSync(join(f.root,'new'));writeFileSync(join(f.root,'new','helper.ts'),'export const helper = true;\n');
 const receipt=await execute(f);let row=list(f).items.find(x=>x.id===receipt.execution_id);
 assert.equal(row.code_version.before.status,'dirty');assert.equal(row.code_version.comparison.status,'same_version');
 assert.equal(row.code_version.comparison.reason,'matching_source_fingerprints');assert.equal(row.code_version.comparison.scope,'bounded_public_source_v1');
 assert.equal(row.test_details.counts.passed,1);assert.equal(row.code_version.comparison.claims_verified,false);
 assert.equal(JSON.stringify(row).includes('export const'),false);assert.equal(JSON.stringify(row).includes(f.root),false);
 const app=openLocal(realpathSync(f.path),f.binding,f.root);t.after(()=>app.close());
 assert.equal((await app.dispatcher.call('memory_query_overview',{project_id:f.pid,view:'features'})).items[0].current_knowledge.status,'current');
 const saved=readFileSync(f.path);
 const client=new Client({name:'dirty-source-fixture',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[main,'serve','--db',realpathSync(f.path),'--project',f.root],stderr:'pipe'});
 transport.stderr.on('data',()=>{});await client.connect(transport);t.after(()=>client.close());
 const mcp=async()=>JSON.parse((await client.callTool({name:'memory_list_executions',arguments:{project_id:f.pid,run_id:f.rid}})).content[0].text);
 assert.equal((await mcp()).items[0].code_version.comparison.status,'same_version');
 const viewer=await startViewer({db:realpathSync(f.path),sourceProjects:[f.root]});t.after(()=>viewer.close());
 const token=new URLSearchParams(new URL(viewer.url).hash.slice(1)).get('token');
 const http=()=>fetch(`${viewer.origin}/api/runs/${f.rid}/executions?project=${f.pid}`,{headers:{Authorization:`Bearer ${token}`}}).then(x=>x.json());
 assert.equal((await http()).items[0].code_version.comparison.status,'same_version');
 git(f.root,'add','source.mjs');assert.equal(list(f).items[0].code_version.comparison.status,'same_version');
 writeFileSync(join(f.root,'source.mjs'),'export const value = 3;\n');
 for(const result of [await mcp(),await http()]){
  assert.equal(result.items[0].code_version.comparison.status,'changed');assert.equal(result.items[0].code_version.comparison.reason,'source_fingerprint_changed');
  assert.deepEqual(result.items[0].code_version.before,row.code_version.before);assert.equal(result.items[0].test_details.counts.passed,1);
 }
 assert.deepEqual(readFileSync(f.path),saved);
 assert.equal((await app.dispatcher.call('memory_query_overview',{project_id:f.pid,view:'features'})).items[0].current_knowledge.status,'stale');
 const failed=await execute(f);row=list(f).items.find(x=>x.id===failed.execution_id);
 assert.equal(row.exit_code,1);assert.equal(row.test_details.counts.failed,1);assert.equal(row.code_version.comparison.status,'same_version');
 assert.equal(row.claims_verified,false);
});
test('before/after content changes are detected even under the same commit; old dirty observations stay unknown',async t=>{
 const f=await setup(t);writeFileSync(join(f.root,'source.mjs'),'export const value = 2;\n');
 await execute(f,['-e',"require('fs').writeFileSync('source.mjs','export const value = 3;\\n')"]);
 const row=list(f).items[0];assert.equal(row.code_version.before.commit,row.code_version.after.commit);
 assert.equal(row.code_version.comparison.reason,'source_changed_during_execution');assert.equal(row.code_version.comparison.claims_verified,false);
 const {worktree,...legacy}=observeSource(f.root,f.binding);
 assert.equal(compareExecutionSource(legacy,legacy,legacy).status,'unknown');
 assert.equal(sourceObservationSchema.safeParse({...legacy,worktree:{...worktree,sha256:'bad'}}).success,false);
});
test('ignored/private files are excluded; symlinks, unsupported edits and limits never claim matching dirty source',async t=>{
 const f=await setup(t),clean=observeSource(f.root,f.binding);assert.equal(clean.worktree.status,'collected');
 writeFileSync(join(f.root,'.env'),'synthetic fixture only');writeFileSync(join(f.root,'ignored.ts'),'not observed');
 assert.equal(observeSource(f.root,f.binding).worktree.sha256,clean.worktree.sha256);
 writeFileSync(join(f.root,'credentials.json'),'synthetic fixture only');
 const partial=observeSource(f.root,f.binding);assert.equal(partial.worktree.status,'collected');
 assert.equal(partial.worktree.excluded_changes,1);assert.equal(partial.worktree.sha256,clean.worktree.sha256);
 assert.equal(compareExecutionSource(clean,clean,partial).status,'unknown');
 renameSync(join(f.root,'credentials.json'),join(f.directory,'credentials.fixture'));
 symlinkSync(join(f.directory,'credentials.fixture'),join(f.root,'linked.ts'));
 assert.equal(observeSource(f.root,f.binding).worktree.reason,'unsafe_entry');
 renameSync(join(f.root,'linked.ts'),join(f.directory,'linked.fixture'));
 writeFileSync(join(f.root,'large.ts'),'x'.repeat(1024*1024+1));
 const large=observeSource(f.root,f.binding);assert.equal(large.worktree.reason,'limit_exceeded');assert.equal(compareExecutionSource(large,large,large).status,'unknown');
 const over=fingerprintWorktree(f.root,'',args=>args.includes('--ignored')?'':Array.from({length:2049},(_,i)=>`x${i}.ts`).join('\0'));
 assert.equal(over.reason,'inventory_limit_exceeded');
});
test('renames and deleted parent directories produce stable source fingerprints; concurrent file inventory changes stay unknown',async t=>{
 const f=await setup(t);mkdirSync(join(f.root,'old'));writeFileSync(join(f.root,'old','file.ts'),'original');
 git(f.root,'add','old');git(f.root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','fixture directory');
 renameSync(join(f.root,'old'),join(f.directory,'old.fixture'));
 const removed=observeSource(f.root,f.binding);assert.equal(removed.worktree.status,'collected');assert.equal(compareExecutionSource(removed,removed,removed).status,'same_version');
 let inventory=0;const unstable=fingerprintWorktree(f.root,'',args=>args.includes('--ignored')?'':(++inventory===1?'source.mjs\0':'source.mjs\0new.ts\0'));
 assert.equal(unstable.reason,'unstable');
});
test('private names and ignored tracked files never reach content open',async t=>{
 const f=await setup(t),names=['credentials.ts','secrets.ts','passwords.md','passwd.py','access-token.js','config.local.ts','.env.ts','auth/client.ts','private/data.ts','ignored.ts'];
 let opened=0;const original=fs.openSync;
 try {
  fs.openSync=()=>{opened++;throw new Error('must not open private fixture');};syncBuiltinESMExports();
  const result=fingerprintWorktree(f.root,names.map(name=>'?? '+name+'\0').join(''),args=>args.includes('--ignored')?'ignored.ts\0':names.join('\0'));
  assert.equal(result.status,'collected');assert.equal(result.files,0);assert.equal(result.excluded,names.length);assert.equal(result.excluded_changes,names.length);assert.equal(opened,0);
 } finally {fs.openSync=original;syncBuiltinESMExports();}
});
test('v12 stores fingerprints separately, transfers them and preserves v11 rows for already-running readers',async t=>{
 const f=await setup(t);writeFileSync(join(f.root,'source.mjs'),'export const value = 2;\n');await execute(f);
 const source=list(f).items[0].code_version,raw=new DatabaseSync(f.path,{readOnly:true});t.after(()=>raw.close());
 const rows=raw.prepare('SELECT * FROM execution_sources').all();assert.equal(JSON.stringify(rows).includes('worktree'),false);
 assert.equal(raw.prepare('SELECT count(*) AS n FROM execution_worktrees').get().n,1);validateDatabase(raw);
 const base=realpathSync(f.directory);await backupDatabase(realpathSync(f.path),join(base,'backup'));
 const restored=await restoreDatabase(join(base,'backup'),join(base,'restored'));
 exportProject(realpathSync(f.path),f.pid,join(base,'export'));const imported=await importProject(join(base,'export'),join(base,'import'));
 for(const path of [restored.db,imported.db]){
  const app=openLocal(path,f.binding,f.root);t.after(()=>app.close());
  assert.deepEqual(app.executions.list(f.pid,f.rid).items[0].code_version.before,source.before);
  assert.equal(app.executions.list(f.pid,f.rid).items[0].code_version.comparison.status,'same_version');
 }
 const legacy=join(base,'legacy.sqlite'),db=new DatabaseSync(legacy);initialize(db,false,11);
 for(const table of ['projects','runs','executions','execution_sources'])for(const row of raw.prepare('SELECT * FROM '+table).all()){
  const fields=Object.keys(row);db.prepare(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`).run(...Object.values(row));
 }
 db.close();const migrated=openLocal(legacy);t.after(()=>migrated.close());
 const check=new DatabaseSync(legacy,{readOnly:true});t.after(()=>check.close());validateDatabase(check);
 assert.deepEqual(check.prepare('SELECT * FROM execution_sources').all(),rows);
 assert.equal(check.prepare('SELECT count(*) AS n FROM execution_worktrees').get().n,0);
 assert.equal(migrated.executions.list(f.pid,f.rid).items[0].code_version.comparison.status,'unknown');
 exportProject(realpathSync(f.path),f.pid,join(base,'bad-export'));
 const dataPath=join(base,'bad-export','data.ndjson'),manifestPath=join(base,'bad-export','manifest.json');
 const altered=readFileSync(dataPath,'utf8').trimEnd().split('\n').map(line=>{
  const entry=JSON.parse(line);if(entry.table==='execution_sources')entry.row.before_json=JSON.stringify(source.before);return JSON.stringify(entry);
 }).join('\n')+'\n';writeFileSync(dataPath,altered);
 const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));manifest.files.main={sha256:createHash('sha256').update(altered).digest('hex'),bytes:Buffer.byteLength(altered)};
 writeFileSync(manifestPath,JSON.stringify(manifest));
 await assert.rejects(()=>importProject(join(base,'bad-export'),join(base,'must-not-import-inline')),{code:'invalid_bundle'});
});


test('excluded changes retain a bounded source comparison through fresh MCP and HTTP without promoting currentness',async t=>{
 const f=await setup(t);writeFileSync(join(f.root,'source.mjs'),'export const value = 2;\n');
 // Unsupported metadata is intentionally not read; its presence must not hide source changes.
 writeFileSync(join(f.root,'metadata.txt'),'fixture metadata');
 const receipt=await execute(f),saved=list(f).items[0].code_version.before;
 assert.equal(saved.worktree.status,'collected');assert.equal(saved.worktree.excluded_changes,1);
 const client=new Client({name:'excluded-change-fixture',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[main,'serve','--db',realpathSync(f.path),'--project',f.root],stderr:'pipe'});
 transport.stderr.on('data',()=>{});await client.connect(transport);t.after(()=>client.close());
 const viewer=await startViewer({db:realpathSync(f.path),sourceProjects:[f.root]});t.after(()=>viewer.close());
 const token=new URLSearchParams(new URL(viewer.url).hash.slice(1)).get('token');
 const both=async(status,publicStatus)=>{
  const mcp=JSON.parse((await client.callTool({name:'memory_list_executions',arguments:{project_id:f.pid,run_id:f.rid}})).content[0].text);
  const http=await fetch(`${viewer.origin}/api/runs/${f.rid}/executions?project=${f.pid}`,{headers:{Authorization:`Bearer ${token}`}}).then(r=>r.json());
  for(const result of [mcp,http]){const row=result.items.find(x=>x.id===receipt.execution_id),comparison=row.code_version.comparison;
   assert.equal(comparison.status,status);assert.equal(comparison.public_source.status,publicStatus);
   assert.deepEqual(comparison.excluded_changes,{before:1,after:1,current:1,contents_observed:false});
   assert.equal(comparison.claims_verified,false);assert.deepEqual(row.code_version.before,saved);
   assert.equal(JSON.stringify(row).includes('metadata.txt'),false);assert.equal(JSON.stringify(row).includes('fixture metadata'),false);
  }
 };
 await both('unknown','same_version');
 const app=openLocal(realpathSync(f.path),f.binding,f.root);t.after(()=>app.close());
 assert.equal((await app.dispatcher.call('memory_query_overview',{project_id:f.pid,view:'features'})).items[0].current_knowledge.status,'unknown');
 writeFileSync(join(f.root,'metadata.txt'),'different excluded contents');await both('unknown','same_version');
 writeFileSync(join(f.root,'source.mjs'),'export const value = 3;\n');await both('changed','changed');
 const old={...saved,worktree:{policy:'public_source_v1',status:'unavailable',reason:'excluded_changes'}};
 assert.equal(compareExecutionSource(old,old,observeSource(f.root,f.binding)).reason,'fingerprint_excluded_changes');
 assert.equal(compareExecutionSource(old,old,observeSource(f.root,f.binding)).public_source,undefined);
});


test('excluded changes at any endpoint stay unknown; legacy collected bytes are never rewritten',async t=>{
 const f=await setup(t);writeFileSync(join(f.root,'source.mjs'),'export const value = 2;\n');await execute(f);
 const original=list(f).items[0].code_version.before;
 for(const endpoint of [0,1,2]){
  const points=[original,original,original].map((p,i)=>({...p,worktree:{...p.worktree,excluded_changes:i===endpoint?1:0}}));
  const comparison=compareExecutionSource(...points);assert.equal(comparison.status,'unknown');assert.equal(comparison.public_source.status,'same_version');
 }
 const changed={...original,worktree:{...original.worktree,sha256:'f'.repeat(64),excluded_changes:1}};
 assert.equal(compareExecutionSource(original,changed,changed).reason,'source_changed_during_execution');
 const raw=new DatabaseSync(f.path);t.after(()=>raw.close());
 for(const field of ['before_json','after_json']){
  const row=raw.prepare('SELECT * FROM execution_worktrees').get(),value=JSON.parse(row[field]);delete value.excluded_changes;
  raw.prepare(`UPDATE execution_worktrees SET ${field}=?`).run(JSON.stringify(value));
 }
 const retained=raw.prepare('SELECT * FROM execution_worktrees').all();
 const legacy=list(f).items[0].code_version;
 assert.equal(legacy.comparison.status,'same_version');assert.equal(legacy.before.worktree.excluded_changes,0);
 assert.deepEqual(raw.prepare('SELECT * FROM execution_worktrees').all(),retained);
});
