import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {realpathSync,mkdirSync,writeFileSync,symlinkSync,readFileSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fixture,project,run} from './helpers.mjs';
import {prepareVitest} from '../dist/runtime/local/vitest-collector.js';
import Reporter from '../dist/runtime/local/vitest-reporter.js';
const exec=promisify(execFile),main=realpathSync('dist/runtime/local/main.js');
const installed=process.env.SKILLY_VITEST_PACKAGE;
test('Vitest public lifecycle yields only bounded aggregate and failure titles',t=>{
 const f=fixture(t),path=join(f.directory,'summary.json'),previous=process.env.SKILLY_TEST_RESULT_FILE;
 const cases=[['passed','pass','run'],['failed','bad <img>','run'],['skipped','skip','skip'],['skipped','todo','todo']].map(([state,name,mode])=>({fullName:name,options:{mode},result:()=>({state,errors:['PRIVATE STACK']})}));
 try{process.env.SKILLY_TEST_RESULT_FILE=path;new Reporter().onTestRunEnd([{children:{allTests:()=>cases,allSuites:()=>[1]},ok:()=>false}],[],'failed');}
 finally{if(previous===undefined)delete process.env.SKILLY_TEST_RESULT_FILE;else process.env.SKILLY_TEST_RESULT_FILE=previous;}
 const text=readFileSync(path,'utf8'),data=JSON.parse(text);assert.deepEqual(data.counts,{tests:4,passed:1,failed:1,cancelled:0,skipped:1,todo:1,suites:1});assert.deepEqual(data.failures,['bad <img>']);assert.equal(text.includes('PRIVATE STACK'),false);
});
test('unsupported npm scripts and modes do not execute or install anything',t=>{const f=fixture(t);assert.throws(()=>prepareVitest('npm',['install'],f.directory),{code:'unsupported_test_command'});});
test('real installed Vitest and npm test preserve observed counts through the runner', {skip:!installed},async t=>{
 const f=fixture(t),root=realpathSync(f.directory),pid=await project(f.call),rid=await run(f.call,pid);
 writeFileSync(join(root,'skilly.project.json'),JSON.stringify({version:1,key:'example',name:'example',repository:'default',environment:'development'}));
 symlinkSync(dirname(realpathSync(installed)),join(root,'node_modules'));
 writeFileSync(join(root,'package.json'),JSON.stringify({type:'module',scripts:{test:'vitest run'}}));
 writeFileSync(join(root,'vitest.config.mjs'),'export default {test:{include:["qa/*.test.js"],maxWorkers:1,minWorkers:1,pool:"forks"}}');mkdirSync(join(root,'qa'));
 writeFileSync(join(root,'qa/sample.test.js'),`import {test,expect,describe} from 'vitest';describe('QA',()=>{test('성공',()=>expect(1).toBe(1));test('의도적 실패',()=>expect(1).toBe(2));test.skip('skip',()=>{});test.todo('todo');});`);
 for(const [command,args] of [[process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','--reporter=default']],['npm',['test','--','--reporter=default']]]){
 const argv=[main,'exec','--db',realpathSync(f.path),'--project',root,'--run-id',rid,'--test-format','vitest','--',command,...args];let r;
 try{r={...await exec(process.execPath,argv,{timeout:45000,env:{...process.env,NODE_TEST_CONTEXT:undefined}}),code:0};}catch(e){r={stdout:e.stdout,stderr:e.stderr,code:e.code};}
 assert.equal(r.code,1,r.stderr);const id=JSON.parse(r.stdout).execution_id;const item=(await f.call('memory_list_executions',{project_id:pid,run_id:rid})).items.find(x=>x.id===id);
 assert.equal(item.test_details.status,'collected');assert.equal(item.test_details.framework,'vitest');assert.deepEqual(item.test_details.counts,{tests:4,passed:1,failed:1,cancelled:0,skipped:1,todo:1,suites:1});assert.match(item.test_details.failures[0],/의도적 실패/);assert.equal(item.test_details.suite_success,false);assert.equal(item.claims_verified,false);
 }
});
