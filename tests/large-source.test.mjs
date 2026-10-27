import test from 'node:test';
import assert from 'node:assert/strict';
import fs, {mkdirSync, writeFileSync, realpathSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {syncBuiltinESMExports} from 'node:module';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fixture, project, run} from './helpers.mjs';
import {sourceRepository} from './support/source-repository.mjs';
import {fingerprintWorktree} from '../dist/adapters/project/worktree-fingerprint.js';
import {worktreeFingerprintSchema} from '../dist/core/execution/currentness.js';
import {SOURCE_LIMITS} from '../dist/core/execution/source-limits.js';
import {startViewer} from '../dist/transport/viewer/server.js';
import {openLocal} from '../dist/runtime/local/app.js';
import {exportProject, importProject} from '../dist/adapters/storage/transfer/project.js';
import {backupDatabase, restoreDatabase} from '../dist/adapters/storage/transfer/snapshot.js';

const main=realpathSync('dist/runtime/local/main.js'),exec=promisify(execFile);
const assets=n=>Array.from({length:n},(_,i)=>`assets/item-${i}.png`);
const listing=(names,ignored=[])=>args=>(args.includes('--ignored')?ignored:names).join('\0');
function withoutContentOpen(fn){
 const original=fs.openSync;let opened=0;
 try{fs.openSync=()=>{opened++;throw Error('content must not be opened');};syncBuiltinESMExports();fn(()=>opened);}
 finally{fs.openSync=original;syncBuiltinESMExports();}
}

test('inventory and excluded-change budgets allow 16384 metadata entries without opening excluded contents',()=>{
 withoutContentOpen(opened=>{
  const names=assets(SOURCE_LIMITS.inventory_entries),status=names.map(p=>`?? ${p}\0`).join('');
  const result=fingerprintWorktree('/unused',status,listing(names));
  assert.equal(result.status,'collected');assert.equal(result.files,0);
  assert.equal(result.excluded,16384);assert.equal(result.excluded_changes,16384);
  assert.equal(worktreeFingerprintSchema.safeParse(result).success,true);assert.equal(opened(),0);
  assert.equal(fingerprintWorktree('/unused','',listing(assets(16385))).reason,'inventory_limit_exceeded');
  assert.equal(fingerprintWorktree('/unused',status+'?? another.png\0',listing([])).reason,'inventory_limit_exceeded');
  // A rename contributes both old and new paths; duplicate paths do not inflate the count.
  const rename=status+'R  target.png\0assets/item-0.png\0';
  assert.equal(fingerprintWorktree('/unused',rename,listing([])).reason,'inventory_limit_exceeded');
  assert.equal(fingerprintWorktree('/unused',status+'?? assets/item-0.png\0',listing(names)).status,'collected');
  assert.equal(fingerprintWorktree('/unused','',()=>('x'.repeat(2*1024*1024)+'\0')).reason,'inventory_limit_exceeded');
  assert.equal(fingerprintWorktree('/unused','',listing([],assets(16385))).reason,'inventory_limit_exceeded');
  assert.equal(opened(),0);
 });
});

test('2049 public files are rejected before any open while ignored source files use only metadata',()=>{
 withoutContentOpen(opened=>{
  const names=Array.from({length:2049},(_,i)=>`src/file-${i}.ts`);
  assert.equal(fingerprintWorktree('/unused','',listing(names)).reason,'source_file_limit_exceeded');
  assert.equal(opened(),0);
  assert.equal(fingerprintWorktree('/unused','',listing(names,names)).status,'collected');
  assert.equal(opened(),0);
 });
});

test('2048 missing tracked public entries remain bounded and changing ignored inventory stays unknown',t=>{
 const f=fixture(t),root=realpathSync(f.directory),names=Array.from({length:2048},(_,i)=>`missing-${i}.ts`);
 assert.equal(fingerprintWorktree(root,'',listing(names)).files,2048);
 let calls=0;
 assert.equal(fingerprintWorktree(root,'',args=>args.includes('--ignored')?(++calls===1?'':'newly-ignored.ts\0'):'').reason,'unstable');
});

test('content byte and elapsed-time budgets remain fixed when metadata inventory grows',t=>{
 const f=fixture(t),root=realpathSync(f.directory);
 writeFileSync(join(root,'large.ts'),'x'.repeat(SOURCE_LIMITS.file_bytes+1));
 assert.equal(fingerprintWorktree(root,'',listing(['large.ts',...assets(3000)])).reason,'limit_exceeded');
 const names=[];for(let i=0;i<17;i++){const p=`part-${i}.ts`;names.push(p);writeFileSync(join(root,p),'x'.repeat(SOURCE_LIMITS.file_bytes));}
 assert.equal(fingerprintWorktree(root,'',listing([...names,...assets(3000)])).reason,'limit_exceeded');
 let ticks=0;t.mock.method(performance,'now',()=>ticks++*1001);
 assert.equal(fingerprintWorktree(root,'',listing([])).reason,'limit_exceeded');
});

for(const component of ['web','media','infra'])test(`${component}: large inventory same/changed/unknown agrees in fresh MCP and HTTP with immutable source rows`,async t=>{
 const f=fixture(t),root=sourceRepository(f.directory),binding={version:1,key:'example',name:'example',repository:'default',environment:'development'};
 const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-C',root,...args],{stdio:['ignore','pipe','pipe']});
 writeFileSync(join(root,'skilly.project.json'),JSON.stringify(binding));
 writeFileSync(join(root,'sample.test.mjs'),"import test from 'node:test';import assert from 'node:assert/strict';import {sample} from './sample.js';test('sample',()=>assert.equal(sample,true));\n");
 mkdirSync(join(root,'assets'));for(const path of assets(2300))writeFileSync(join(root,path),'');
 git('add','.');git('commit','-m','Synthetic large inventory');
 const pid=await project(f.call),rid=await run(f.call,pid,{components:[{key:component,name:component}],features:[{key:'large-source',name:'대형 코드 비교 테스트'}]});
 const receipt=JSON.parse((await exec(process.execPath,[main,'exec','--db',realpathSync(f.path),'--project',root,'--run-id',rid,'--',process.execPath,'--test','sample.test.mjs'],{env:{...process.env,NODE_TEST_CONTEXT:undefined}})).stdout);
 const viewer=await startViewer({db:realpathSync(f.path),sourceProjects:[root]});t.after(()=>viewer.close());
 const token=new URLSearchParams(new URL(viewer.url).hash.slice(1)).get('token'),headers={Authorization:`Bearer ${token}`};
 const both=async(status,publicStatus,reason)=>{
  const client=new Client({name:'large-source-fresh',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[main,'serve','--db',realpathSync(f.path),'--project',root],stderr:'pipe'});transport.stderr.on('data',()=>{});
  let response;try{await client.connect(transport);response=JSON.parse((await client.callTool({name:'memory_list_executions',arguments:{project_id:pid,run_id:rid}})).content[0].text);}finally{await client.close();}
  const http=await fetch(`${viewer.origin}/api/runs/${rid}/executions?project=${pid}`,{headers}).then(r=>r.json());
  for(const result of [response,http]){const row=result.items.find(r=>r.id===receipt.execution_id);assert.equal(row.code_version.comparison.status,status);assert.equal(row.code_version.comparison.public_source?.status,publicStatus);if(reason)assert.equal(row.code_version.comparison.reason,reason);assert.equal(row.claims_verified,false);assert.equal(row.test_details.counts.passed,1);}
  const stable=version=>({...version,current:{...version.current,observed_at:null},comparison:{...version.comparison,checked_at:null}});
  assert.deepEqual(stable(response.items[0].code_version),stable(http.items[0].code_version));
  return response.items[0];
 };
 const baseline=await both('same_version','same_version');assert.equal(baseline.code_version.before.worktree.excluded,2301);
 const sourceRows=()=>{const db=new DatabaseSync(f.path,{readOnly:true});try{return Object.fromEntries(['execution_sources','execution_worktrees','executions'].map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()]));}finally{db.close();}};
 const storedRows=sourceRows();
 const saved=readFileSync(f.path);
 writeFileSync(join(root,'metadata.txt'),'synthetic excluded change');await both('unknown','same_version','fingerprint_excluded_changes');
 writeFileSync(join(root,'sample.js'),'export const sample = false;\n');const changed=await both('changed','changed');assert.deepEqual(changed.code_version.before,baseline.code_version.before);
 writeFileSync(join(root,'oversized.ts'),'x'.repeat(SOURCE_LIMITS.file_bytes+1));await both('unknown',undefined,'fingerprint_limit_exceeded');
 assert.deepEqual(readFileSync(f.path),saved);
 assert.deepEqual(sourceRows(),storedRows);
 const base=realpathSync(f.directory);exportProject(realpathSync(f.path),pid,join(base,'export'));
 const imported=await importProject(join(base,'export'),join(base,'import'));
 await backupDatabase(realpathSync(f.path),join(base,'backup'));const restored=await restoreDatabase(join(base,'backup'),join(base,'restore'));
 for(const db of [imported.db,restored.db]){const app=openLocal(db);try{const row=app.executions.list(pid,rid).items[0];assert.deepEqual(row.code_version.before,baseline.code_version.before);}finally{await app.close();}}
});
