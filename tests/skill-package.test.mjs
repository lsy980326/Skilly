import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,readFileSync,writeFileSync,mkdirSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {skillContentHash} from '../dist/core/skills/model.js';
import {parseSkillPackage,createSkillPackage} from '../dist/core/skills/package.js';
import {readSkillPackage,installSkillPackage,verifySkillPackage} from '../dist/adapters/skills/package-files.js';
const body='---\nname: sample\ndescription: A sample\n---\n# Sample';
const files=[{path:'references/guide.md',content:'Reference'},{path:'scripts/check.sh',content:'echo SHOULD_NOT_RUN'}];
const p={format:'skilly-skill',format_version:1,skill_key:'sample',version:'1.0',source:'local:sample',name:'Sample',description:'',body,files,install_instructions:'Inspect first',content_hash:skillContentHash(body,files)};
const root=()=>realpathSync(mkdtempSync(join(tmpdir(),'skilly-share-test-')));

test('portable packages contain only content, validate hashes and reject paths/duplicates/extra metadata',()=>{
 const made=createSkillPackage({...p,project_id:'hidden-id',project_root:'/hidden/root',created_at:'now',installations:['private']});
 assert.deepEqual(made,p); assert.ok(!JSON.stringify(made).includes('/hidden'));
 for(const value of [{...p,body:'tampered'},{...p,project_id:'private'}, {...p,files:[{path:'../SKILL.md',content:'bad'}]}, {...p,files:[files[0],files[0]]}]) assert.throws(()=>parseSkillPackage(value));
});
test('installation writes a new folder only, keeps existing files and verifies changed/missing files without execution',()=>{
 const r=root(),result=installSkillPackage(p,r,'codex'); assert.equal(result.state,'matches'); assert.equal(result.scripts_executed,false);
 assert.equal(readFileSync(join(r,'.agents/skills/sample/SKILL.md'),'utf8'),body);
 assert.throws(()=>installSkillPackage({...p,body:'changed'},r,'codex'));
 assert.equal(readFileSync(join(r,'.agents/skills/sample/SKILL.md'),'utf8'),body);
 writeFileSync(join(r,'.agents/skills/sample/SKILL.md'),'local changes');
 assert.equal(verifySkillPackage(p,r,'codex').state,'modified'); assert.equal(verifySkillPackage(p,r,'cursor').state,'missing');
 assert.throws(()=>installSkillPackage(p,r,'codex','../escape')); assert.equal(existsSync(join(r,'escape')),false);
});
test('symlink roots, package links, special files and oversized input are refused',()=>{
 const r=root(),outside=root(); symlinkSync(outside,join(r,'.agents')); assert.throws(()=>installSkillPackage(p,r,'codex')); assert.equal(existsSync(join(outside,'skills')),false);
 const path=join(r,'package.json');writeFileSync(path,JSON.stringify(p)); symlinkSync(path,join(r,'link.json'));assert.throws(()=>readSkillPackage(join(r,'link.json')));
 writeFileSync(path,'x'.repeat(129*1024));assert.throws(()=>readSkillPackage(path));
 assert.throws(()=>readSkillPackage(r));
});
test('CLI package install and verify work without DB or binding; verify returns exit 2 on mismatches',()=>{
 const r=root(),path=join(r,'package.json');writeFileSync(path,JSON.stringify(p));
 const call=cmd=>spawnSync(process.execPath,[new URL('../dist/runtime/local/main.js',import.meta.url).pathname,cmd,'--input',path,'--project',r,'--tool','cursor'],{encoding:'utf8',timeout:15000});
 const installed=call('skill-install'); assert.equal(installed.status,0,installed.stderr); assert.equal(JSON.parse(installed.stdout).state,'matches');
 assert.equal(call('skill-verify').status,0); writeFileSync(join(r,'.cursor/skills/sample/SKILL.md'),'changed');
 const changed=call('skill-verify'); assert.equal(changed.status,2,changed.stderr);assert.equal(JSON.parse(changed.stdout).state,'modified');
 assert.equal(existsSync(join(r,'skilly.project.json')),false);assert.equal(existsSync(join(r,'.skilly')),false);
});

test('CLI exports only a selected version and preserves existing package outputs and source DB',async t=>{
 const {openLocal}=await import('../dist/runtime/local/app.js');
 const r=root(),db=join(r,'memory.sqlite'),output=join(r,'export.json');
 const app=openLocal(db);t.after(()=>app.close());
 const project=(await app.dispatcher.call('memory_register_project',{key:'source',name:'Private project name',idempotency_key:'p'})).project;
 await app.dispatcher.call('memory_register_skill',{project_id:project.id,skill_key:p.skill_key,version:p.version,source:p.source,name:p.name,description:p.description,body:p.body,files:p.files,install_instructions:p.install_instructions,idempotency_key:'s'});
 const before=readFileSync(db);
 const args=[new URL('../dist/runtime/local/main.js',import.meta.url).pathname,'skill-export','--db',db,'--project-id',project.id,'--skill',p.skill_key,'--version',p.version,'--output',output];
 const exported=spawnSync(process.execPath,args,{encoding:'utf8',timeout:15000});assert.equal(exported.status,0,exported.stderr);
 assert.deepEqual(readSkillPackage(output),p); assert.ok(!readFileSync(output,'utf8').includes('Private project name'));
 const existing=readFileSync(output);assert.equal(spawnSync(process.execPath,args,{encoding:'utf8',timeout:15000}).status,1);assert.deepEqual(readFileSync(output),existing);
 assert.deepEqual(readFileSync(db),before);
});
