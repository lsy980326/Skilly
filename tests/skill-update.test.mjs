import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { skillContentHash } from '../dist/core/skills/model.js';
import { installSkillPackage } from '../dist/adapters/skills/package-files.js';
import { applySkillUpdate, previewSkillUpdate, recoverSkillUpdate } from '../dist/adapters/skills/update.js';

const cli = new URL('../dist/runtime/local/main.js', import.meta.url).pathname;
const adapter = new URL('../dist/adapters/skills/update.js', import.meta.url).href;
function pack(version, body, files = [{path:'references/guide.md',content:'Guide '+version}]) {
 return {format:'skilly-skill',format_version:1,skill_key:'sample',version,source:'local:sample',name:'Sample',description:'',body,files,
  install_instructions:'Inspect first',content_hash:skillContentHash(body,files)};
}
function fixture(tool = 'codex') {
 const root = realpathSync(mkdtempSync(join(tmpdir(),'skilly-update-test-'))), old = pack('1','Old guide'), next = pack('2','New guide',[
  {path:'references/guide.md',content:'Guide 2'},{path:'scripts/check.sh',content:'echo SHOULD_NOT_RUN'}]);
 installSkillPackage(old,root,tool);
 const installation = join(root,tool === 'codex' ? '.agents' : '.cursor','skills','sample');
 writeFileSync(join(installation,'local-notes.txt'),'Leave this file alone');
 const config = join(root,'existing-settings.txt');writeFileSync(config,'Existing settings fixture');
 const input = {before:old,after:next,root,tool};
 const state = join(root,'update-state');
 const call = (command,args=[]) => spawnSync(process.execPath,[cli,command,'--project',root,'--tool',tool,...args],{encoding:'utf8',timeout:15000});
 const recover = () => recoverSkillUpdate({root,tool,folder:'sample',state});
 return {root,old,next,input,installation,state,config,call,recover,apply:io=>applySkillUpdate(input,{expect:previewSkillUpdate(input).preview_hash,state},io)};
}
const bytes = path => readFileSync(path,'utf8');
function original(f) {
 assert.equal(bytes(join(f.installation,'SKILL.md')),f.old.body);
 assert.equal(bytes(join(f.installation,'references/guide.md')),f.old.files[0].content);
 assert.equal(existsSync(join(f.installation,'scripts/check.sh')),false);
 assert.equal(bytes(join(f.installation,'local-notes.txt')),'Leave this file alone');
 assert.equal(bytes(f.config),'Existing settings fixture');
}

test('preview is read-only, includes exact changed text, pins scope and refuses stale approval before creating state',()=>{
 const f=fixture(), before=lstatSync(join(f.installation,'SKILL.md'),{bigint:true});
 const preview=previewSkillUpdate(f.input);assert.equal(preview.applicable,true);
 assert.equal(preview.files.find(x=>x.path==='SKILL.md').before,'Old guide');
 assert.equal(preview.files.find(x=>x.path==='SKILL.md').after,'New guide');
 assert.equal(preview.files.find(x=>x.path==='scripts/check.sh').change,'added');
 assert.equal(preview.preview_hash,previewSkillUpdate(f.input).preview_hash);
 assert.equal(existsSync(f.state),false);assert.equal(lstatSync(join(f.installation,'SKILL.md'),{bigint:true}).mtimeNs,before.mtimeNs);
 writeFileSync(join(f.installation,'SKILL.md'),'Local edit');
 assert.throws(()=>applySkillUpdate(f.input,{expect:preview.preview_hash,state:f.state}),{code:'preview_changed'});
 assert.equal(existsSync(f.state),false);assert.equal(bytes(join(f.installation,'SKILL.md')),'Local edit');
});

test('approved update retains originals and unrelated files, preserves modes and can be updated again without DB or execution',()=>{
 const f=fixture('cursor');chmodSync(join(f.installation,'SKILL.md'),0o640);
 const result=f.apply();assert.equal(result.status,'applied');assert.equal(result.lock_status,'released');assert.equal(result.scripts_executed,false);
 assert.equal(bytes(join(f.installation,'SKILL.md')),f.next.body);assert.equal(bytes(join(f.state,'original/0.txt')),f.old.body);
 assert.equal(lstatSync(join(f.installation,'SKILL.md')).mode&0o777,0o640);
 assert.equal(bytes(join(f.installation,'local-notes.txt')),'Leave this file alone');assert.equal(bytes(f.config),'Existing settings fixture');
 assert.equal(existsSync(join(f.root,'.skilly')),false);assert.equal(existsSync(join(f.root,'skilly.project.json')),false);
 assert.equal(f.recover().recovery_performed,false);assert.equal(bytes(join(f.installation,'SKILL.md')),f.next.body);
 const input={...f.input,before:f.next,after:pack('3','Third guide',f.next.files)};
 assert.equal(applySkillUpdate(input,{expect:previewSkillUpdate(input).preview_hash,state:join(f.root,'second-update')}).status,'applied');
 assert.equal(bytes(join(f.state,'original/0.txt')),f.old.body);
});

test('local edits, missing originals, occupied additions, removals, source and case collisions never overwrite data',()=>{
 for(const kind of ['edit','missing','occupied','removed']) {
  const f=fixture();
  if(kind==='edit')writeFileSync(join(f.installation,'references/guide.md'),'User edit');
  if(kind==='missing')renameSync(join(f.installation,'references/guide.md'),join(f.root,'original-retained.md'));
  if(kind==='occupied'){mkdirSync(join(f.installation,'scripts'));writeFileSync(join(f.installation,'scripts/check.sh'),'User script');}
  if(kind==='removed')f.input.after=pack('2','New',[]);
  const preview=previewSkillUpdate(f.input);assert.equal(preview.applicable,false,kind);
  assert.throws(()=>applySkillUpdate(f.input,{expect:preview.preview_hash,state:f.state}),{code:'update_conflict'});
  assert.equal(existsSync(f.state),false);assert.equal(bytes(join(f.installation,'SKILL.md')),f.old.body);
 }
 const f=fixture();assert.throws(()=>previewSkillUpdate({...f.input,after:{...f.next,source:'other'}}),{code:'source_conflict'});
 assert.throws(()=>previewSkillUpdate({...f.input,after:{...f.next,version:'1'}}),{code:'version_conflict'});
 assert.throws(()=>previewSkillUpdate({...f.input,after:pack('2','New',[{path:'references/A.md',content:'A'},{path:'references/a.md',content:'a'}])}),{code:'path_conflict'});
});

test('symlinks, changed directory identities, unsafe state paths and existing output directories are refused',()=>{
 const f=fixture(),other=fixture();
 symlinkSync(other.installation,join(f.root,'linked'));assert.throws(()=>previewSkillUpdate({...f.input,root:join(f.root,'linked')}));
 for(const state of [f.installation,join(f.installation,'state'),join(f.root,'.agents/skills'),f.root])
  assert.throws(()=>applySkillUpdate(f.input,{expect:previewSkillUpdate(f.input).preview_hash,state}));
 mkdirSync(f.state);assert.throws(()=>f.apply());original(f);
 const g=fixture(),preview=previewSkillUpdate(g.input);
 renameSync(g.installation,join(g.root,'old-installation'));installSkillPackage(g.old,g.root,'codex');
 assert.throws(()=>applySkillUpdate(g.input,{expect:preview.preview_hash,state:g.state}),{code:'preview_changed'});
});

test('a partial write failure automatically restores original files and keeps the attempted update for inspection',()=>{
 const f=fixture();let links=0;
 const result=f.apply({rename:renameSync,link:(a,b)=>{if(++links===2)throw new Error('Injected write failure');linkSync(a,b);}});
 assert.equal(result.status,'recovered');assert.equal(result.update_error,'file_operation_failed');assert.equal(result.lock_status,'released');original(f);
 assert.equal(existsSync(join(f.state,'recovered.json')),true);assert.equal(bytes(join(f.state,'original/0.txt')),f.old.body);
 assert.equal(f.recover().recovery_performed,false);original(f);
});

test('failed rollback remains pending and explicit recovery restores it without replaying the update',()=>{
 const f=fixture();const result=f.apply({rename:renameSync,link:()=>{throw new Error('Unavailable disk');}});
 assert.equal(result.status,'recovery_blocked');assert.equal(existsSync(join(f.state,'recovered.json')),false);
 assert.equal(existsSync(join(f.installation,'SKILL.md')),false);
 assert.equal(f.recover().status,'recovered');original(f);assert.equal(f.recover().recovery_performed,false);
});

test('completion-marker publication failure cannot leave a false applied marker, and recovery completion can be retried',()=>{
 const f=fixture();
 const result=f.apply({rename:renameSync,link:(a,b)=>{if(b.endsWith('/applied.json'))throw new Error('Marker write failed');linkSync(a,b);}});
 assert.equal(result.status,'recovered');assert.equal(existsSync(join(f.state,'applied.json')),false);original(f);
 const g=fixture();let calls=0;
 const pending=g.apply({rename:renameSync,link:(a,b)=>{if(++calls===2 || b.endsWith('/recovered.json'))throw new Error('Marker write failed');linkSync(a,b);}});
 assert.equal(pending.status,'recovery_blocked');assert.equal(existsSync(join(g.state,'recovered.json')),false);
 assert.equal(g.recover().status,'recovered');original(g);
});

test('recovery preserves an intervening user edit, reports blocked paths and continues after the user retains that edit elsewhere',()=>{
 const f=fixture();let calls=0;
 const result=f.apply({rename:renameSync,link:(a,b)=>{
  if(++calls===2){writeFileSync(join(f.installation,'SKILL.md'),'New user edit');throw new Error('Injected failure');}linkSync(a,b);
 }});
 assert.equal(result.status,'recovery_blocked');assert.ok(result.blocked_files.includes('SKILL.md'));
 assert.equal(bytes(join(f.installation,'SKILL.md')),'New user edit');assert.equal(f.recover().status,'recovery_blocked');
 renameSync(join(f.installation,'SKILL.md'),join(f.root,'user-edit-retained.md'));
 assert.equal(f.recover().status,'recovered');original(f);assert.equal(bytes(join(f.root,'user-edit-retained.md')),'New user edit');
});

for(const phase of ['after-original-move','after-new-link'])test(`actual child process exit ${phase} retains a dead-owner lock and recovers through a fresh CLI`,()=>{
 const f=fixture();const script=`import {applySkillUpdate} from ${JSON.stringify(adapter)};import {renameSync,linkSync} from 'node:fs';
 const input=${JSON.stringify(f.input)};const options=${JSON.stringify({expect:previewSkillUpdate(f.input).preview_hash,state:f.state})};
 applySkillUpdate(input,options,{rename:(a,b)=>{renameSync(a,b);${phase==='after-original-move'?'process.exit(77)':''}},link:(a,b)=>{linkSync(a,b);${phase==='after-new-link'?'process.exit(78)':''}}});`;
 const stopped=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:15000});
 assert.equal(stopped.status,phase==='after-original-move'?77:78,stopped.stderr);
 assert.equal(existsSync(join(f.state,'applied.json')),false);
 const recovered=f.call('skill-update-recover',['--state',f.state,'--folder','sample']);
 assert.equal(recovered.status,0,recovered.stderr);assert.equal(JSON.parse(recovered.stdout).status,'recovered');original(f);
});

test('an active lock, foreign root and corrupted backup block recovery without changing unrelated files',()=>{
 const f=fixture();let checked=false;
 assert.equal(f.apply({rename:renameSync,link:(a,b)=>{if(!checked){checked=true;assert.throws(()=>f.recover(),{code:'update_busy'});}linkSync(a,b);}}).status,'applied');
 const g=fixture();g.apply({rename:renameSync,link:()=>{throw new Error('Failure');}});
 assert.throws(()=>recoverSkillUpdate({root:f.root,tool:'codex',folder:'sample',state:g.state}),{code:'scope_mismatch'});
 writeFileSync(join(g.state,'original/0.txt'),'Corrupt backup');assert.equal(g.recover().status,'recovery_blocked');
 assert.equal(existsSync(join(g.installation,'SKILL.md')),false);assert.equal(bytes(join(g.state,'original/0.txt')),'Corrupt backup');
});

test('a concurrent permission change is not discarded during rollback',()=>{
 const f=fixture();let calls=0;
 const result=f.apply({rename:renameSync,link:(a,b)=>{
  if(++calls===2){chmodSync(join(f.installation,'SKILL.md'),0o644);throw new Error('Injected failure');}linkSync(a,b);
 }});
 assert.equal(result.status,'recovery_blocked');assert.ok(result.blocked_files.includes('SKILL.md'));
 assert.equal(lstatSync(join(f.installation,'SKILL.md')).mode&0o777,0o644);
});

test('CLI requires an exact reviewed preview and no DB options; preview/apply/recover expose separate statuses',()=>{
 const f=fixture(),before=join(f.root,'old.json'),after=join(f.root,'new.json');writeFileSync(before,JSON.stringify(f.old));writeFileSync(after,JSON.stringify(f.next));
 const args=['--from',before,'--input',after];const preview=f.call('skill-update-preview',args);assert.equal(preview.status,0,preview.stderr);
 const hash=JSON.parse(preview.stdout).preview_hash;
 assert.equal(f.call('skill-update',[...args,'--state',f.state]).status,1);assert.equal(existsSync(f.state),false);
 assert.equal(f.call('skill-update-preview',[...args,'--db',join(f.root,'do-not-create.sqlite')]).status,1);assert.equal(existsSync(join(f.root,'do-not-create.sqlite')),false);
 const applied=f.call('skill-update',[...args,'--expect',hash,'--state',f.state]);assert.equal(applied.status,0,applied.stderr);
 assert.equal(JSON.parse(applied.stdout).status,'applied');assert.equal(JSON.parse(applied.stdout).database_changed,false);
 const recovered=f.call('skill-update-recover',['--state',f.state,'--folder','sample']);assert.equal(recovered.status,0,recovered.stderr);
 assert.equal(JSON.parse(recovered.stdout).status,'applied');assert.equal(JSON.parse(recovered.stdout).recovery_performed,false);
 assert.equal(bytes(f.config),'Existing settings fixture');
});
