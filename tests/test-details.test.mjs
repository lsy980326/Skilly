import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, realpathSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openLocal } from '../dist/runtime/local/app.js';
import { fixture, project, run } from './helpers.mjs';
import { nodeTestArguments, testCollector } from '../dist/runtime/local/test-collector.js';
import { backupDatabase, restoreDatabase } from '../dist/adapters/storage/transfer/snapshot.js';
import { exportProject, importProject } from '../dist/adapters/storage/transfer/project.js';
import { initialize, validateDatabase } from '../dist/adapters/storage/transfer/database.js';
import { SqliteViewer } from '../dist/adapters/storage/sqlite/viewer.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const exec = promisify(execFile), main = realpathSync('dist/runtime/local/main.js');
async function setup(t) {
  const f = fixture(t), pid = await project(f.call), rid = await run(f.call, pid);
  const root = realpathSync(f.directory);
  writeFileSync(join(root, 'skilly.project.json'), JSON.stringify({version:1,key:'example',name:'example',repository:'default',environment:'development'}));
  return { ...f, path:realpathSync(f.path), root, pid, rid };
}
async function execute(f, source, extra=[]) {
  const file=join(f.root,'details.test.mjs'); writeFileSync(file,source);
  const argv=[main,'exec','--db',realpathSync(f.path),'--project',f.root,'--run-id',f.rid,...extra,'--',process.execPath,'--test',file];
  let result; try { result={...await exec(process.execPath,argv,{timeout:15000,env:{...process.env,NODE_TEST_CONTEXT:undefined}}),code:0}; }
  catch(error){result={stdout:error.stdout,stderr:error.stderr,code:error.code};}
  const receipt=JSON.parse(result.stdout);
  const row=(await f.call('memory_list_executions',{project_id:f.pid,run_id:f.rid})).items.find(item=>item.id===receipt.execution_id);
  return {...result,row};
}
test('actual node:test events persist counts/failure names, fresh MCP reads them without verifying the AI report', async t=>{
  const f=await setup(t);
  const {row,code,stdout}=await execute(f,`import {test,describe} from 'node:test';import assert from 'node:assert/strict';
    describe('그룹',()=>{test('성공',()=>{});test('실패 <img src=x>',()=>assert.fail('PRIVATE ASSERTION'));});
    test.skip('건너뜀',()=>{});test.todo('예정');`);
  assert.equal(code,1);assert.equal(stdout.includes('PRIVATE ASSERTION'),false);
  const d=row.test_details;assert.equal(d.status,'collected');
  assert.deepEqual(d.counts,{tests:4,passed:1,failed:1,cancelled:0,skipped:1,todo:1,suites:1});
  assert.equal(d.suite_success,false);assert.ok(d.failures.includes('실패 <img src=x>'));
  assert.equal(JSON.stringify(row).includes('PRIVATE ASSERTION'),false);assert.equal(row.claims_verified,false);
  const client=new Client({name:'details-test',version:'1'});
  const transport=new StdioClientTransport({command:process.execPath,args:[main,'serve','--db',f.path,'--project',f.root],stderr:'pipe'});
  transport.stderr.on('data',()=>{});t.after(()=>client.close());await client.connect(transport);
  const page=JSON.parse((await client.callTool({name:'memory_list_executions',arguments:{project_id:f.pid,run_id:f.rid}})).content[0].text);
  assert.deepEqual(page.items[0].test_details,d);
  const viewer=new SqliteViewer(f.path);t.after(()=>viewer.close());
  assert.deepEqual(viewer.executions(f.pid,f.rid).items[0].test_details,d);
  const bundle=join(f.root,'export');exportProject(f.path,f.pid,bundle);
  const imported=join(f.root,'import');await importProject(bundle,imported);
  const importedView=new SqliteViewer(join(imported,'memory.sqlite'));t.after(()=>importedView.close());
  assert.deepEqual(importedView.executions(f.pid,f.rid).items[0].test_details,d);
  const backup=join(f.root,'backup');await backupDatabase(f.path,backup);
  const restored=join(f.root,'restored');await restoreDatabase(backup,restored);
  const restoredView=new SqliteViewer(join(restored,'memory.sqlite'));t.after(()=>restoredView.close());
  assert.deepEqual(restoredView.executions(f.pid,f.rid).items[0].test_details,d);
});
test('passing suites, bounded failure names and interrupted tests stay distinct',async t=>{
  const f=await setup(t);
  let r=await execute(f,`import {test} from 'node:test';test('통과',()=>{});`);
  assert.equal(r.code,0);assert.equal(r.row.test_details.counts.passed,1);assert.deepEqual(r.row.test_details.failures,[]);
  r=await execute(f,`import {test} from 'node:test';for(let n=0;n<25;n++)test('failure'+n+'x'.repeat(300),()=>{throw new Error('secret')});`);
  assert.equal(r.row.test_details.counts.failed,25);assert.equal(r.row.test_details.failures.length,20);
  assert.equal(r.row.test_details.failures_truncated,true);assert.equal(r.row.test_details.failures[0].length,200);
  r=await execute(f,`import {test} from 'node:test';test('never ends',async()=>new Promise(()=>{}));setInterval(()=>{},1000);`,['--timeout-ms','1000']);
  assert.equal(r.code,124);assert.deepEqual(r.row.test_details,{status:'not_collected',reason:'interrupted'});
});
test('unsupported invocations, malformed results and output text never become test evidence',()=>{
  assert.equal(nodeTestArguments(process.execPath,['-e','console.log("passed 100")']),undefined);
  assert.equal(nodeTestArguments(process.execPath,['--test','--test-reporter=tap','foo']),undefined);
  assert.equal(nodeTestArguments(process.execPath,['--test','--watch']),undefined);
  assert.equal(nodeTestArguments('/nonexistent/node',['--test']),undefined);
  for(const raw of ['passed 100',JSON.stringify({status:'collected',framework:'node_test',counts:{tests:1,passed:99}}),'{}\n{}']){
    const c=testCollector(true);c.add(Buffer.from(raw));assert.equal(c.finish(true).reason,'invalid_report');
  }
  const c=testCollector(true);c.add(Buffer.alloc(17000));assert.equal(c.finish(true).reason,'limit_exceeded');
  assert.equal(testCollector(true).finish(true).reason,'missing_summary');
  assert.equal(testCollector(false).finish(true).reason,'unsupported_command');
});
test('relative executable lookup uses project cwd and environment reporters stay untouched',t=>{
  const f=fixture(t);symlinkSync(process.execPath,join(f.directory,'node'));
  assert.ok(nodeTestArguments('./node',['--test'],f.directory));
  assert.equal(nodeTestArguments('./node',['--test'],join(f.directory,'missing')),undefined);
  const original=process.env.NODE_OPTIONS;
  try { process.env.NODE_OPTIONS='--test-reporter=tap';assert.equal(nodeTestArguments(process.execPath,['--test']),undefined); }
  finally { if(original===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=original; }
});
test('v6 read-only databases remain unchanged and migration preserves their exact execution rows',async t=>{
  const f=await setup(t), path=join(f.root,'legacy.sqlite');
  const db=new DatabaseSync(path);initialize(db,false,6);
  f.app.executions.start({project_id:f.pid,run_id:f.rid,executable:'legacy',command_hash:'a'.repeat(64)});
  const source=new DatabaseSync(f.path,{readOnly:true});
  for(const name of ['projects','runs','executions']){
    for(const row of source.prepare(`SELECT * FROM ${name}`).all()){
      const names=Object.keys(row);db.prepare(`INSERT INTO ${name} (${names.join(',')}) VALUES (${names.map(()=>'?').join(',')})`).run(...Object.values(row));
    }
  }
  const original=source.prepare('SELECT * FROM executions').all();source.close();
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,6);validateDatabase(db);db.close();
  const before=readFileSync(path);const viewer=new SqliteViewer(path);assert.equal(viewer.executions(f.pid,f.rid).items[0].test_details.reason,'unfinished');viewer.close();assert.deepEqual(readFileSync(path),before);
  const migrated=openLocal(path);await migrated.close();const check=new DatabaseSync(path,{readOnly:true});t.after(()=>check.close());
  assert.equal(check.prepare('PRAGMA user_version').get().user_version,12);assert.deepEqual(check.prepare('SELECT * FROM executions').all(),original);validateDatabase(check);
});

test('detail insertion failure rolls back finalization without replaying the process',async t=>{
  const f=await setup(t),db=new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER deny_details BEFORE INSERT ON execution_test_details BEGIN SELECT RAISE(ABORT,'fixture failure');END");db.close();
  const marker=join(f.root,'executed-once');
  const argv=[main,'exec','--db',f.path,'--project',f.root,'--run-id',f.rid,'--',process.execPath,'-e',`require('fs').appendFileSync(${JSON.stringify(marker)},'x')`];
  await assert.rejects(exec(process.execPath,argv),error=>error.stderr.includes('execution_save_failed'));
  assert.equal(readFileSync(marker,'utf8'),'x');
  const row=(await f.call('memory_list_executions',{project_id:f.pid,run_id:f.rid})).items[0];
  assert.equal(row.outcome,'unconfirmed');assert.equal(row.test_details.reason,'unfinished');
});
