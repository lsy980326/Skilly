import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fixture,project,run,checkpoint} from './helpers.mjs';
import {startViewer} from '../dist/transport/viewer/server.js';
import {openLocal} from '../dist/runtime/local/app.js';

async function setup(t){
 const f=fixture(t),pid=await project(f.call),rid=await run(f.call,pid,{repository:'main',environment:'test',components:[{key:'web',name:'Web'}]});
 await f.call('memory_checkpoint',checkpoint(pid,rid,{body:'기존 기록'}));
 const server=await startViewer({db:f.path});t.after(()=>server.close());
 const headers={Authorization:'Bearer '+new URLSearchParams(new URL(server.url).hash.slice(1)).get('token'),Origin:server.origin,'Content-Type':'application/json'};
 const post=async(operation,input,patch={})=>{const response=await fetch(server.origin+'/api/documents/'+operation,{method:'POST',headers:{...headers,...patch},body:typeof input==='string'?input:JSON.stringify(input)});return {status:response.status,data:await response.json()}};
 const input={project_id:pid,target_run_id:rid,component_key:'web',path:'docs/selected.md',text:'# 선택한 문서\r\n\n옛 주장과 <img src=x onerror=bad()> 😀\n'};
 return {...f,pid,rid,server,headers,post,input};
}
test('authenticated selected imports preserve originals, use retrospective records, and survive response retries',async t=>{
 const f=await setup(t);f.input.text='\ufeff'+f.input.text.repeat(240);const source=join(f.directory,'selected.md');writeFileSync(source,f.input.text);const before=readFileSync(source);
 const db=new DatabaseSync(f.path);t.after(()=>db.close());const previous=db.prepare('SELECT * FROM records').all();const rows=()=>db.prepare('SELECT count(*) n FROM records').get().n;
 const scopes=await fetch(f.server.origin+'/api/documents/targets?project='+f.pid,{headers:f.headers});assert.equal(scopes.status,200);assert.equal((await scopes.json()).items[0].component_key,'web');
 const preview=await f.post('preview',f.input);assert.equal(preview.status,200);assert.equal(preview.data.persistence,'not_written');assert.equal(rows(),previous.length);
 const payload={...f.input,preview_token:preview.data.preview_token};const saved=await f.post('import',payload);assert.equal(saved.status,200);assert.ok(saved.data.record_ids.length>1);
 const firstCount=rows(),retry=await f.post('import',payload);assert.deepEqual(retry,saved);assert.equal(rows(),firstCount);assert.deepEqual(readFileSync(source),before);
 let text='';for(const id of saved.data.record_ids){const evidence=await f.call('memory_get_evidence',{project_id:f.pid,record_id:id});assert.equal(evidence.record.report_origin,'retrospective');assert.equal(evidence.verified,false);text+=evidence.record.body;}
 assert.equal(text,f.input.text);assert.deepEqual(db.prepare('SELECT * FROM records WHERE id=?').get(previous[0].id),previous[0]);
 const detail=await(await fetch(f.server.origin+`/api/runs/${saved.data.run_id}?project=${f.pid}`,{headers:f.headers})).json();assert.equal(detail.run.state,'completed');assert.equal(detail.run.actor,'로컬 화면');assert.ok(detail.records.items.every(r=>r.report_origin==='retrospective'&&r.verified===false));
});
test('preview signatures bind exact text and destination; malformed, unauthenticated and cross-origin writes fail',async t=>{
 const f=await setup(t),preview=await f.post('preview',f.input);const payload={...f.input,preview_token:preview.data.preview_token};
 for(const patch of [{text:f.input.text+'changed'},{component_key:''},{path:'docs/changed.md'}])assert.equal((await f.post('import',{...payload,...patch})).status,400);
 assert.equal((await f.post('import',f.input)).status,400);
 assert.equal((await f.post('import',payload,{Authorization:'Bearer invalid'})).status,401);
 assert.equal((await f.post('import',payload,{Origin:'https://evil.example'})).status,403);
 assert.equal((await f.post('import',payload,{Origin:''})).status,403);
 assert.equal((await f.post('preview',f.input,{'Content-Type':'text/plain'})).status,400);
 for(const input of [{...f.input,path:'../escape.md'},{...f.input,path:'auth.md'},{...f.input,text:'x'.repeat(49153)},{...f.input,text:'\ud800'},{...f.input,extra:'forbidden'}])assert.equal((await f.post('preview',input)).status,400);
 assert.equal((await f.post('preview','{')).status,400);assert.equal((await f.post('preview','x'.repeat(131073))).status,400);
 const other=await project(f.call,'other');assert.equal((await f.post('preview',{...f.input,project_id:other})).status,404);
 assert.equal((await f.post('preview',{...f.input,target_run_id:randomUUID()})).status,404);
 const records=await f.call('memory_query_context',{project_id:f.pid,topic:'document-import'});assert.equal(records.records.length,0);
});
test('an import retry finishes its own partial task; a previous MCP import is reused without closing its task',async t=>{
 const f=await setup(t);const binding={version:1,key:'example',name:'example',repository:'main',environment:'test',component:{key:'web',name:'Web'}};
 const bound=openLocal(f.path,binding,f.directory);t.after(()=>bound.close());await bound.dispatcher.call('memory_resolve_project',{});
 const selected={project_id:f.pid,path:f.input.path,text:f.input.text};
 const preview=await bound.dispatcher.call('memory_preview_markdown',selected);
 const imported=await bound.dispatcher.call('memory_import_markdown',{...selected,run_id:f.rid,expected_hash:preview.source.sha256});
 const reviewed=await f.post('preview',f.input),saved=await f.post('import',{...f.input,preview_token:reviewed.data.preview_token});
 assert.equal(saved.status,200);assert.equal(saved.data.run_id,f.rid);assert.deepEqual(saved.data.record_ids,imported.record_ids);
 assert.equal((await f.call('memory_get_status',{project_id:f.pid,run_id:f.rid})).run.state,'active');
 const input={...f.input,path:'docs/partial.md',text:'# 중간 저장 실패 재시도'};const p=await f.post('preview',input),payload={...input,preview_token:p.data.preview_token};
 const db=new DatabaseSync(f.path);t.after(()=>db.close());db.exec("CREATE TRIGGER fail_finish BEFORE INSERT ON records WHEN NEW.topic='task-summary' BEGIN SELECT RAISE(ABORT,'fixture'); END");
 assert.equal((await f.post('import',payload)).status,503);const count=db.prepare("SELECT count(*) n FROM records WHERE topic='document-import'").get().n;
 db.exec('DROP TRIGGER fail_finish');const retried=await f.post('import',payload);assert.equal(retried.status,200);assert.equal(db.prepare("SELECT count(*) n FROM records WHERE topic='document-import'").get().n,count);
 assert.equal((await f.call('memory_get_status',{project_id:f.pid,run_id:retried.data.import_run_id})).run.state,'completed');
});
