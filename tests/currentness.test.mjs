import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {mkdirSync,writeFileSync,realpathSync,readFileSync,existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {fixture,project,run} from './helpers.mjs';
import {observeSource,sourceProvider} from '../dist/adapters/project/source-version.js';
import {compareExecutionSource} from '../dist/core/execution/currentness.js';
import {openLocal} from '../dist/runtime/local/app.js';
import {startViewer} from '../dist/transport/viewer/server.js';
import {initialize,validateDatabase} from '../dist/adapters/storage/transfer/database.js';
import {backupDatabase,restoreDatabase} from '../dist/adapters/storage/transfer/snapshot.js';
import {exportProject,importProject} from '../dist/adapters/storage/transfer/project.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const exec=promisify(execFile), main=realpathSync('dist/runtime/local/main.js');
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function commit(root){git(root,'add','.');git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','commit','-m','fixture');}
async function setupGit(t){
 const f=fixture(t);const root=join(realpathSync(f.directory),'project');mkdirSync(root);
 const binding={version:1,key:'example',name:'example',repository:'default',environment:'development'};
 writeFileSync(join(root,'skilly.project.json'),JSON.stringify(binding));writeFileSync(join(root,'source.js'),'export const value = 1;\n');
 writeFileSync(join(root,'.gitignore'),'.env\n');git(root,'init');commit(root);
 const pid=await project(f.call),rid=await run(f.call,pid);
 return {...f,root,binding,pid,rid};
}
async function execute(f,code='process.exit(0)'){
 const r=await exec(process.execPath,[main,'exec','--db',realpathSync(f.path),'--project',f.root,'--run-id',f.rid,'--',process.execPath,'-e',code],{timeout:15000});return JSON.parse(r.stdout);
}
const list=f=>{const app=openLocal(realpathSync(f.path),f.binding,f.root);try{return app.executions.list(f.pid,f.rid);}finally{void app.close();}};
test('clean matching versions, dirty unknown, changed commit; fresh MCP and HTTP agree without promoting reports',async t=>{
 const f=await setupGit(t),receipt=await execute(f);let row=list(f).items[0];
 assert.equal(row.id,receipt.execution_id);assert.equal(row.code_version.comparison.status,'same_version');assert.equal(row.code_version.comparison.claims_verified,false);
 assert.equal(row.code_version.comparison.dependencies_and_runtime_verified,false);
 assert.equal(JSON.stringify(row).includes(f.root),false);
 writeFileSync(join(f.root,'.env'),'ignored private contents');assert.equal(list(f).items[0].code_version.comparison.status,'same_version');
 writeFileSync(join(f.root,'source.js'),'export const value = 2;\n');assert.equal(list(f).items[0].code_version.comparison.reason,'source_fingerprint_changed');
 commit(f.root);assert.equal(list(f).items[0].code_version.comparison.reason,'different_commit');
 const client=new Client({name:'currentness-fixture',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[main,'serve','--db',realpathSync(f.path),'--project',f.root],stderr:'pipe'});
 transport.stderr.on('data',()=>{});await client.connect(transport);t.after(()=>client.close());
 const reply=JSON.parse((await client.callTool({name:'memory_list_executions',arguments:{project_id:f.pid,run_id:f.rid}})).content[0].text);
 assert.equal(reply.items[0].code_version.comparison.status,'changed');
 const viewer=await startViewer({db:realpathSync(f.path),sourceProjects:[f.root]});t.after(()=>viewer.close());
 const token=new URLSearchParams(new URL(viewer.url).hash.slice(1)).get('token'),headers={Authorization:`Bearer ${token}`};
 const request=()=>fetch(`${viewer.origin}/api/runs/${f.rid}/executions?project=${f.pid}`,{headers}).then(r=>r.json());
 assert.deepEqual((await request()).items[0].code_version.before,reply.items[0].code_version.before);
 assert.equal((await request()).items[0].code_version.comparison.status,'changed');viewer.reload();assert.equal((await request()).items[0].code_version.comparison.status,'changed');
 assert.equal((await fetch(`${viewer.origin}/api/runs/${f.rid}/executions?project=${f.pid}`)).status,401);
 const noRoot=await startViewer({db:realpathSync(f.path)});t.after(()=>noRoot.close());
 const plain=openLocal(realpathSync(f.path));t.after(()=>plain.close());assert.equal(plain.executions.list(f.pid,f.rid).items[0].code_version.comparison.reason,'comparison_root_not_configured');
});
test('execution source observations survive backups and project export without following stored roots',async t=>{
 const f=await setupGit(t);await execute(f);const before=list(f).items[0].code_version;
 const base=realpathSync(f.directory),backup=join(base,'backup');await backupDatabase(realpathSync(f.path),backup);const restored=await restoreDatabase(backup,join(base,'restored'));
 const exported=join(base,'exported');exportProject(realpathSync(f.path),f.pid,exported);const imported=await importProject(exported,join(base,'imported'));
 for(const path of [restored.db,imported.db]){const app=openLocal(path);t.after(()=>app.close());const row=app.executions.list(f.pid,f.rid).items[0];assert.deepEqual(row.code_version.before,before.before);assert.deepEqual(row.code_version.after,before.after);assert.equal(row.code_version.comparison.reason,'comparison_root_not_configured');}
});
test('legacy v7 rows are preserved byte-for-byte and remain unknown after additive migration',async t=>{
 const f=await setupGit(t);f.app.executions.start({project_id:f.pid,run_id:f.rid,executable:'legacy',command_hash:'a'.repeat(64)});
 const legacy=join(realpathSync(f.directory),'legacy.sqlite'),db=new DatabaseSync(legacy);initialize(db,false,7);const src=new DatabaseSync(f.path,{readOnly:true});
 for(const table of ['projects','runs','executions'])for(const row of src.prepare(`SELECT * FROM ${table}`).all()){const fields=Object.keys(row);db.prepare(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`).run(...Object.values(row));}
 const original=src.prepare('SELECT * FROM executions').all();src.close();db.close();
 const app=openLocal(legacy);t.after(()=>app.close());const check=new DatabaseSync(legacy,{readOnly:true});t.after(()=>check.close());validateDatabase(check);
 assert.deepEqual(check.prepare('SELECT * FROM executions').all(),original);assert.equal(app.executions.list(f.pid,f.rid).items[0].code_version.comparison.reason,'legacy_not_collected');
});
test('during-run changes, untracked files, unavailable Git and scoped explicit roots cannot become same version',async t=>{
 const f=await setupGit(t),clean=observeSource(f.root,f.binding);assert.equal(clean.status,'clean');
 writeFileSync(join(f.root,'untracked.txt'),'new');assert.equal(observeSource(f.root,f.binding).status,'dirty');
 assert.equal(compareExecutionSource(clean,{...clean,commit:'b'.repeat(40)},clean).reason,'changed_during_execution');
 assert.equal(compareExecutionSource(clean,clean,{...clean,root_hash:'b'.repeat(64)}).reason,'comparison_scope_mismatch');
 assert.equal(compareExecutionSource(clean,undefined,clean).reason,'execution_unfinished');
 assert.equal(sourceProvider([])(clean),undefined);assert.throws(()=>sourceProvider(['.']),/absolute/);
 const sub=join(f.root,'sub');mkdirSync(sub);assert.equal(observeSource(sub,f.binding).reason,'not_repository_root');
 assert.equal(observeSource('/nonexistent/skilly-fixture',f.binding).status,'unavailable');
 await execute(f,`require('fs').writeFileSync('source.js','changed while running')`);assert.equal(list(f).items[0].code_version.comparison.reason,'fingerprint_excluded_changes');
});
test('hidden index flags cannot become matching code and invalid scope never persists',async t=>{
 const f=await setupGit(t);for(const flag of ['assume-unchanged','skip-worktree']){
  git(f.root,'update-index',`--${flag}`,'source.js');assert.equal(observeSource(f.root,f.binding).reason,'index_entries_unobserved');git(f.root,'update-index',`--no-${flag}`,'source.js');
 }
 const source=observeSource(f.root,f.binding);assert.throws(()=>sourceProvider(['/x'.repeat(900)]),/limit/);
 assert.throws(()=>f.app.executions.start({project_id:f.pid,run_id:f.rid,executable:'fixture',command_hash:'a'.repeat(64),source_observation:{...source,repository:'other'}}),{code:'scope_mismatch'});
 assert.equal(list(f).items.length,0);
});

test('an oversized index remains unavailable rather than claiming dirty source equality',async t=>{
 const f=await setupGit(t),bin=join(realpathSync(f.directory),'git-bin'),marker=join(bin,'index-read');mkdirSync(bin);
 const fake=`#!${process.execPath}
const args=process.argv.slice(2);
if(args.includes('--show-toplevel'))console.log(${JSON.stringify(f.root)});
else if(args.includes('rev-parse'))console.log('a'.repeat(40));
else if(args.includes('status'))process.stdout.write(' M source.js\\0');
else if(args.includes('ls-files')){require('fs').writeFileSync(${JSON.stringify(marker)},'read');process.stdout.write('H hidden-path\\0'.repeat(20000));}
`;
 writeFileSync(join(bin,'git'),fake,{mode:0o700});const originalPath=process.env.PATH;
 try {process.env.PATH=bin+':'+originalPath;const observation=observeSource(f.root,f.binding);assert.equal(observation.status,'unavailable');assert.equal(observation.commit,null);assert.equal(observation.reason,'git_unavailable');assert.equal(existsSync(marker),true);assert.equal(compareExecutionSource(observation,observation,observation).status,'unknown');}
 finally {if(originalPath===undefined)delete process.env.PATH;else process.env.PATH=originalPath;}
});
