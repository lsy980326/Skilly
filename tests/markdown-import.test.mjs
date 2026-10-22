import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,realpathSync,symlinkSync,utimesSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {fixture,project,run} from './helpers.mjs';
import {openLocal} from '../dist/runtime/local/app.js';
import {parseProjectBinding} from '../dist/adapters/project/binding.js';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
import {exportProject,importProject} from '../dist/adapters/storage/transfer/project.js';
async function setup(t){const f=fixture(t);const root=realpathSync(f.directory);mkdirSync(join(root,'docs'));const binding=parseProjectBinding({version:1,key:'example',name:'example',repository:'default',environment:'development'});const app=openLocal(f.path,binding,root);t.after(()=>app.close());const call=(tool,args)=>app.dispatcher.call(tool,args);const pid=(await call('memory_resolve_project',{})).project.id;const rid=await run(call,pid);return {...f,path:realpathSync(f.path),root,call,pid,rid};}
test('selected UTF-8 originals and source metadata survive chunking, fresh connection and transfer without verification',async t=>{
 const f=await setup(t),original='\ufeff# 이전 문서\r\n\n과거 주장과 😀 원문\n'.repeat(300),path='docs/history.md';writeFileSync(join(f.root,path),original);
 const bytes=readFileSync(join(f.root,path));const preview=await f.call('memory_preview_markdown',{project_id:f.pid,path,text:original});assert.equal(preview.persistence,'not_written');assert.equal(preview.source.sha256,createHash('sha256').update(bytes).digest('hex'));
 assert.equal((await f.call('memory_query_context',{project_id:f.pid,query:'과거'})).records.length,0);
 const saved=await f.call('memory_import_markdown',{project_id:f.pid,run_id:f.rid,path,text:original,expected_hash:preview.source.sha256});assert.ok(saved.record_ids.length>1);let combined='';
 for(const [index,id] of saved.record_ids.entries()){const e=await f.call('memory_get_evidence',{project_id:f.pid,record_id:id});combined+=e.record.body;assert.equal(e.record.report_origin,'retrospective');assert.equal(e.verified,false);assert.equal(e.record.report.import_source.part,index+1);assert.equal(e.record.report.import_source.path,path);}
 assert.equal(combined,original);assert.deepEqual(readFileSync(join(f.root,path)),bytes);
 const next=await run(f.call,f.pid,{idempotency_key:'next'});utimesSync(join(f.root,path),new Date(),new Date());assert.deepEqual(await f.call('memory_import_markdown',{project_id:f.pid,run_id:next,path,text:original,expected_hash:preview.source.sha256}),saved);
 const changed=original+'\n변경';writeFileSync(join(f.root,path),changed);await assert.rejects(f.call('memory_import_markdown',{project_id:f.pid,run_id:next,path,text:changed,expected_hash:preview.source.sha256}),{code:'source_changed'});
 const updated=await f.call('memory_preview_markdown',{project_id:f.pid,path,text:changed});const v2=await f.call('memory_import_markdown',{project_id:f.pid,run_id:next,path,text:changed,expected_hash:updated.source.sha256});assert.notDeepEqual(v2.record_ids,saved.record_ids);
 const fresh=openLocal(f.path,undefined,f.root);t.after(()=>fresh.close());assert.equal((await fresh.dispatcher.call('memory_get_evidence',{project_id:f.pid,record_id:saved.record_ids[0]})).record.body,Array.from(original).slice(0,6000).join(''));
 const bundle=join(f.root,'bundle');exportProject(f.path,f.pid,bundle);const result=await importProject(bundle,join(f.root,'imported'));const viewer=new SqliteViewer(result.db);t.after(()=>viewer.close());assert.ok(viewer.detail(f.pid,f.rid).records.items.some(r=>r.report.import_source.sha256===preview.source.sha256));
});
test('private path labels, invalid text, size limits and closed tasks are rejected; submitted paths are never opened',async t=>{
 const f=await setup(t);writeFileSync(join(f.root,'docs/ok.md'),'# 안전한 테스트');
 for(const path of ['../outside.md','/tmp/other.md','.codex/config.md','docs/auth.md','docs/token.md','node_modules/file.md','docs/secret-key.md','docs/a.txt'])await assert.rejects(f.call('memory_preview_markdown',{project_id:f.pid,path,text:'provided original'}),{code:'invalid_path'});
 symlinkSync(join(f.root,'docs'),join(f.root,'linked'));symlinkSync(join(f.root,'docs/ok.md'),join(f.root,'docs/link.md'));
 for(const path of ['linked/ok.md','docs/link.md']){const preview=await f.call('memory_preview_markdown',{project_id:f.pid,path,text:'host supplied'});assert.equal(preview.source_path_verified,false);}
 writeFileSync(join(f.root,'docs/bad.md'),Buffer.from([255,254]));await assert.rejects(f.call('memory_preview_markdown',{project_id:f.pid,path:'docs/bad.md',text:'\ud800'}),{code:'invalid_document'});
 writeFileSync(join(f.root,'docs/large.md'),'x'.repeat(49153));await assert.rejects(f.call('memory_preview_markdown',{project_id:f.pid,path:'docs/large.md',text:'x'.repeat(49153)}),{code:'document_limit'});
 const preview=await f.call('memory_preview_markdown',{project_id:f.pid,path:'docs/ok.md',text:'# 안전한 테스트'});await f.call('memory_finish_task',{project_id:f.pid,run_id:f.rid,summary:'done',outcome:'completed',idempotency_key:'end'});await assert.rejects(f.call('memory_import_markdown',{project_id:f.pid,run_id:f.rid,path:'docs/ok.md',text:'# 안전한 테스트',expected_hash:preview.source.sha256}),{code:'run_closed'});
});
test('a failed multipart import is atomic and an identical retry preserves one copy',async t=>{
 const f=await setup(t);writeFileSync(join(f.root,'docs/batch.md'),'원문😀'.repeat(4000));const preview=await f.call('memory_preview_markdown',{project_id:f.pid,path:'docs/batch.md',text:'원문😀'.repeat(4000)});
 const db=new DatabaseSync(f.path);db.exec("CREATE TRIGGER deny_import BEFORE INSERT ON records WHEN (SELECT count(*) FROM records WHERE topic='document-import')=1 BEGIN SELECT RAISE(ABORT,'fixture');END");
 const args={project_id:f.pid,run_id:f.rid,path:'docs/batch.md',text:'원문😀'.repeat(4000),expected_hash:preview.source.sha256};await assert.rejects(f.call('memory_import_markdown',args));assert.equal(db.prepare("SELECT count(*) n FROM records WHERE topic='document-import'").get().n,0);db.exec('DROP TRIGGER deny_import');db.close();
 const saved=await f.call('memory_import_markdown',args);assert.deepEqual(await f.call('memory_import_markdown',args),saved);
});

test('component roots sharing one scope retain separate document provenance and receipts',async t=>{
 const f=await setup(t),text='# 같은 원문',path='docs/shared.md';const ids=[];
 for(const key of ['web','api']){
  const root=join(f.root,key);mkdirSync(root);const binding=parseProjectBinding({version:1,key:'example',name:'example',repository:'default',environment:'development',component:{key,name:key}});
  const app=openLocal(f.path,binding,root);t.after(()=>app.close());const call=(tool,args)=>app.dispatcher.call(tool,args);await call('memory_resolve_project',{});
  const rid=await run(call,f.pid,{idempotency_key:'run-'+key}),preview=await call('memory_preview_markdown',{project_id:f.pid,path,text});
  assert.equal(preview.source.source_root,'component:'+key);const saved=await call('memory_import_markdown',{project_id:f.pid,run_id:rid,path,text,expected_hash:preview.source.sha256});ids.push(saved.record_ids[0]);
 }
 assert.notEqual(ids[0],ids[1]);
});
