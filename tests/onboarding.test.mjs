import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,writeFileSync,readFileSync,existsSync,mkdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setupCodex} from '../scripts/setup-codex.mjs';
import {diagnoseLocal} from '../scripts/doctor.mjs';
import {openLocal} from '../dist/runtime/local/app.js';
const identity={key:'onboarding-test',name:'Onboarding test',repository:'web',environment:'test'};
function fixture(){const root=realpathSync(mkdtempSync(join(tmpdir(),'skilly-onboarding-')));return {root,db:join(root,'memory.sqlite')};}
test('first install validates explicit identity and creates all connection files without trusting or opening DB',async()=>{
 const f=fixture();const result=setupCodex({project:f.root,db:f.db,identity});assert.equal(result.connection_verified,false);assert.equal(result.files.length,4);
 assert.deepEqual(JSON.parse(readFileSync(join(f.root,'skilly.project.json'),'utf8')),{version:1,...identity});assert.equal(existsSync(f.db),false);
 const before=result.files.map(p=>readFileSync(p));assert.throws(()=>setupCodex({project:f.root,db:f.db,identity}));
 assert.throws(()=>setupCodex({project:f.root,db:f.db}));result.files.forEach((p,n)=>assert.deepEqual(readFileSync(p),before[n]));
 const report=await diagnoseLocal({project:f.root,db:f.db});assert.equal(report.status,'local_preflight_ready');assert.equal(report.database.status,'not_initialized');assert.equal(report.connection_status,'not_checked');assert.equal(report.trust_status,'unknown');assert.equal(existsSync(f.db),false);
});
test('existing config causes preflight refusal before identity or skills are created; invalid identity never writes',()=>{
 const f=fixture();mkdirSync(join(f.root,'.codex'));const config=join(f.root,'.codex/config.toml');writeFileSync(config,'PRIVATE_SENTINEL_NOT_TO_READ');
 assert.throws(()=>setupCodex({project:f.root,db:f.db,identity}));assert.equal(existsSync(join(f.root,'skilly.project.json')),false);assert.equal(existsSync(join(f.root,'.agents')),false);
 assert.equal(readFileSync(config,'utf8'),'PRIVATE_SENTINEL_NOT_TO_READ');
 const other=fixture();assert.throws(()=>setupCodex({project:other.root,db:other.db,identity:{...identity,key:'../bad'}}));assert.equal(existsSync(join(other.root,'skilly.project.json')),false);
});
test('doctor distinguishes missing local files from a broken connection and never reads config contents',async()=>{
 const f=fixture();mkdirSync(join(f.root,'.codex'));const config=join(f.root,'.codex/config.toml');writeFileSync(config,'PRIVATE_SENTINEL_NOT_TO_READ');
 const report=await diagnoseLocal({project:f.root,db:f.db});assert.equal(report.status,'action_required');assert.equal(report.connection_status,'not_checked');
 assert.equal(report.checks.find(c=>c.key==='mcp_config').status,'present_unverified');assert.equal(JSON.stringify(report).includes('PRIVATE_SENTINEL'),false);assert.equal(report.configuration_contents_read,false);assert.equal(existsSync(f.db),false);
});
test('doctor reads the registered project without creating reports, changing source DB bytes or following a database link',async t=>{
 const f=fixture();setupCodex({project:f.root,db:f.db,identity});const app=openLocal(f.db,{version:1,...identity},f.root);t.after(()=>app.close());
 await app.dispatcher.call('memory_resolve_project',{});const before=readFileSync(f.db);
 const report=await diagnoseLocal({project:f.root,db:f.db});assert.equal(report.database.project_registered,true);assert.equal(report.connection_status,'not_checked');assert.deepEqual(readFileSync(f.db),before);
 symlinkSync(f.db,join(f.root,'link.sqlite'));const linked=await diagnoseLocal({project:f.root,db:join(f.root,'link.sqlite')});assert.equal(linked.database.status,'unavailable');
});

test('installed-config diagnostic reports trust/approval blocks without further calls, model turns or DB writes',{skip:process.platform!=='darwin'},async()=>{
 const {spawnSync}=await import('node:child_process');
 for(const reason of ['trust','approval']){
  const f=fixture(),fake=join(f.root,'fake-codex'),calls=join(f.root,'requests.txt');
  writeFileSync(fake,`#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nimport {createInterface} from 'node:readline';\nif(process.argv.includes('--version')){console.log('fake-codex-fixture');process.exit(0);}\ncreateInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.method)return;appendFileSync(${JSON.stringify(calls)},m.method+'\\n');if(m.method==='initialize'){console.log(JSON.stringify(${JSON.stringify(reason==='trust'?{method:'configWarning',params:{summary:'Project config requires trust'}}:{id:987,method:'item/commandExecution/requestApproval',params:{}})}));console.log(JSON.stringify({id:m.id,result:{}}));}});\n`,{mode:0o700});
  const result=spawnSync(process.execPath,[new URL('../scripts/verify-codex.mjs',import.meta.url).pathname,'--configured','--project',f.root,'--db',f.db,'--codex',fake],{encoding:'utf8',timeout:15000});
  assert.equal(result.status,1,result.stderr);const report=JSON.parse(result.stdout);
  assert.equal(report.status,reason==='trust'?'project_trust_required':'interactive_approval_required');assert.equal(report.model_turns,0);assert.equal(report.connection_check_passed,false);assert.equal(report.desktop_current_session_verified,false);
  assert.equal(readFileSync(calls,'utf8'),'initialize\n');assert.equal(existsSync(f.db),false);assert.equal(report.sessions.length,1);assert.equal(report.processes_checked,1);
 }
});
