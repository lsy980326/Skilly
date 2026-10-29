import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync,readFileSync,symlinkSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {fixture,project,run,checkpoint} from './helpers.mjs';
import {openLocal} from '../dist/runtime/local/app.js';
import {startViewer} from '../dist/transport/viewer/server.js';
import {putAuthority} from '../dist/adapters/storage/sqlite/project-authority.js';
import {uploadSelectedAttachment,readStoredAttachment,callAttachment} from '../dist/adapters/attachments/mcp-client.js';

const main=fileURLToPath(new URL('../dist/runtime/local/main.js',import.meta.url));
const digest=b=>createHash('sha256').update(b).digest('hex');
const manifest=(p,r,bytes=Buffer.from('원본 😀\r\n'),extra={})=>({project_id:p,run_id:r,name:'original.txt',bytes:bytes.length,sha256:digest(bytes),selection:{kind:'user_selected',reference:'사용자가 지정한 테스트 원본'},...extra});
async function connect(t,path,root){const client=new Client({name:'local-attachment-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:[main,'serve','--db',path,...(root?['--project',root]:[])],stderr:'pipe'});transport.stderr?.resume();await client.connect(transport);t.after(()=>client.close());return client;}
async function setup(t){const f=fixture(t),p=await project(f.call),r=await run(f.call,p),note=await f.call('memory_checkpoint',checkpoint(p,r));const db=new DatabaseSync(f.path);t.after(()=>db.close());return {...f,p,r,note,db};}

test('real stdio MCP saves selected chunked bytes, viewer agrees, fresh connection reads original and preserves reports',async t=>{
 const f=await setup(t),client=await connect(t,f.path),before=f.db.prepare('SELECT * FROM records').all();
 const tools=(await client.listTools()).tools;assert.equal(tools.length,28);assert.match(client.getInstructions(),/explicitly selected by the user/);
 for(const name of ['prepare_attachment','put_attachment_part','commit_attachment'])assert.equal(tools.find(x=>x.name==='memory_'+name).annotations.readOnlyHint,false);
 assert.equal(tools.find(x=>x.name==='memory_list_attachments').annotations.readOnlyHint,true);
 const bytes=Buffer.concat([Buffer.from('\ufeff선택 원본\r\n<script>data only</script>'),Buffer.alloc(190000,133)]),path=join(f.directory,'original.bin');writeFileSync(path,bytes);
 const input={project_id:f.p,run_id:f.r,record_id:f.note.record_id,selection:{kind:'user_selected',reference:'테스트용으로 명시적으로 선택한 파일'}};
 const saved=await uploadSelectedAttachment(client,path,input);assert.equal(saved.status,'persisted');assert.equal(saved.attachment.record_id,f.note.record_id);assert.equal(saved.claims_verified,false);
 assert.deepEqual(readFileSync(path),bytes);assert.deepEqual(f.db.prepare('SELECT * FROM records').all(),before);
 const viewer=await startViewer({db:f.path});t.after(()=>viewer.close());const headers={Authorization:'Bearer '+new URLSearchParams(new URL(viewer.url).hash.slice(1)).get('token')};
 const list=await fetch(viewer.origin+`/api/attachments?project=${f.p}&run=${f.r}`,{headers});const screen=await list.json();assert.equal(screen.items[0].id,saved.attachment.id);assert.equal(screen.usage.original_bytes,bytes.length);
 const original=await fetch(viewer.origin+`/api/attachments/${saved.attachment.id}/original?project=${f.p}&run=${f.r}`,{headers});assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes);
 await client.close();const next=await connect(t,f.path);const recalled=await callAttachment(next,'memory_list_attachments',{project_id:f.p,run_id:f.r});assert.equal(recalled.items[0].id,saved.attachment.id);
 const reread=await readStoredAttachment(next,{project_id:f.p,run_id:f.r,attachment_id:saved.attachment.id});assert.deepEqual(reread.bytes,bytes);assert.equal(reread.claims_verified,false);
 const retry=await uploadSelectedAttachment(next,path,input);assert.equal(retry.attachment.id,saved.attachment.id);assert.equal((await callAttachment(next,'memory_list_attachments',{project_id:f.p,run_id:f.r})).total,1);
});
test('volatile partial upload is not saved/queued; incomplete/hash/conflicting parts leave v15 and original records unchanged',async t=>{
 const f=await setup(t),m=manifest(f.p,f.r),u=await f.call('memory_prepare_attachment',m),scope={project_id:f.p,run_id:f.r,upload_id:u.upload_id};
 assert.equal(u.persistence,'not_persisted');assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,15);
 await assert.rejects(f.call('memory_commit_attachment',scope),{code:'incomplete_upload'});
 await assert.rejects(f.call('memory_put_attachment_part',{...scope,part:0,data_base64:'AA=='}),{code:'invalid_input'});
 const bytes=Buffer.from('원본 😀\r\n');await f.call('memory_put_attachment_part',{...scope,part:0,data_base64:bytes.toString('base64')});
 await assert.rejects(f.call('memory_put_attachment_part',{...scope,part:0,data_base64:Buffer.alloc(bytes.length,1).toString('base64')}),{code:'conflict'});
 const other=f.open();await assert.rejects(other.dispatcher.call('memory_commit_attachment',scope),{code:'not_found'});
 assert.equal((await f.call('memory_recovery_status',{project_id:f.p})).requests.length,0);
 const bad=await f.call('memory_prepare_attachment',{...m,sha256:'a'.repeat(64)}),badScope={...scope,upload_id:bad.upload_id};
 await f.call('memory_put_attachment_part',{...badScope,part:0,data_base64:bytes.toString('base64')});await assert.rejects(f.call('memory_commit_attachment',badScope),{code:'hash_mismatch'});
 assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,15);assert.equal((await f.call('memory_list_attachments',{project_id:f.p,run_id:f.r})).total,0);
 await assert.rejects(f.call('memory_prepare_attachment',{...m,name:'another.txt'}),{code:'busy'});
});
test('missing selection, source paths, private names, foreign task/record and over-limit parts are rejected',async t=>{
 const f=await setup(t),m=manifest(f.p,f.r);
 for(const extra of [{selection:undefined},{selection:{kind:'automatic',reference:'scan'}},{path:'/some/file'},{name:'.env'},{bytes:4194305}])await assert.rejects(f.call('memory_prepare_attachment',{...m,...extra}),{code:'invalid_input'});
 await assert.rejects(f.call('memory_prepare_attachment',{...m,record_id:randomUUID()}),{code:'not_found'});
 const p=await project(f.call,'other'),r=await run(f.call,p);await assert.rejects(f.call('memory_prepare_attachment',{...m,project_id:p,run_id:r,record_id:f.note.record_id}),{code:'not_found'});
 const u=await f.call('memory_prepare_attachment',m),s={project_id:f.p,run_id:f.r,upload_id:u.upload_id};
 await assert.rejects(f.call('memory_put_attachment_part',{...s,part:0,data_base64:'a'.repeat(87385)}),{code:'invalid_input'});
 await assert.rejects(f.call('memory_put_attachment_part',{...s,part:0,data_base64:'not base64'}),{code:'invalid_input'});
 await assert.rejects(f.call('memory_put_attachment_part',{...s,project_id:p,run_id:r,part:0,data_base64:''}),{code:'not_found'});
 assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,15);
});
test('binding repository and project scope cannot be bypassed for attachment methods',async t=>{
 const f=await setup(t),binding={version:1,key:'example',name:'example',repository:'main',environment:'test'},app=openLocal(f.path,binding);t.after(()=>app.close());
 await app.dispatcher.call('memory_resolve_project',{});
 for(const name of ['memory_prepare_attachment','memory_list_attachments'])await assert.rejects(app.dispatcher.call(name,name==='memory_prepare_attachment'?manifest(f.p,f.r):{project_id:f.p,run_id:f.r}),{code:'scope_mismatch'});
 const p=await project(f.call,'other');await assert.rejects(app.dispatcher.call('memory_list_attachments',{project_id:p,run_id:f.r}),{code:'scope_mismatch'});
});
test('write authority revoked between buffering and commit blocks save before schema migration',async t=>{
 const f=await setup(t),bytes=Buffer.from('원본 😀\r\n'),u=await f.call('memory_prepare_attachment',manifest(f.p,f.r)),s={project_id:f.p,run_id:f.r,upload_id:u.upload_id};
 await f.call('memory_put_attachment_part',{...s,part:0,data_base64:bytes.toString('base64')});
 putAuthority(f.db,'main',{project_id:f.p,project_key:'example',transfer_id:randomUUID(),generation:1,role:'source',state:'blocked',updated_at:new Date().toISOString()});
 await assert.rejects(f.call('memory_commit_attachment',s),{code:'project_write_blocked'});assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,15);
});
test('empty files and maximum 4 MiB file fit bounded MCP parts; duplicate commit keeps one link',async t=>{
 const f=await setup(t),client=await connect(t,f.path),path=join(f.directory,'bounded.bin'),input={project_id:f.p,run_id:f.r,selection:{kind:'user_selected',reference:'선택한 경계값 테스트 파일'}};
 for(const bytes of [Buffer.alloc(0),Buffer.alloc(4194304,7)]){
  writeFileSync(path,bytes);const saved=await uploadSelectedAttachment(client,path,input),r=await readStoredAttachment(client,{project_id:f.p,run_id:f.r,attachment_id:saved.attachment.id});assert.deepEqual(r.bytes,bytes);
 }
 const m=manifest(f.p,f.r),u=await f.call('memory_prepare_attachment',m),s={project_id:f.p,run_id:f.r,upload_id:u.upload_id};await f.call('memory_put_attachment_part',{...s,part:0,data_base64:Buffer.from('원본 😀\r\n').toString('base64')});const saved=await f.call('memory_commit_attachment',s),retry=await f.call('memory_commit_attachment',s);assert.equal(retry.attachment.id,saved.attachment.id);assert.equal(retry.duplicate,true);
});
test('host helper refuses private/hidden paths and symlinks before sending any original',async t=>{
 const f=await setup(t),client=await connect(t,f.path),input={project_id:f.p,run_id:f.r,selection:{kind:'user_selected',reference:'테스트 선택'}};
 writeFileSync(join(f.directory,'.env'),'not real credentials');writeFileSync(join(f.directory,'public.txt'),'public');symlinkSync(join(f.directory,'public.txt'),join(f.directory,'alias.txt'));mkdirSync(join(f.directory,'.private'));writeFileSync(join(f.directory,'.private','hidden.txt'),'test');
 symlinkSync(f.directory,join(f.directory,'.hidden-alias'));symlinkSync(join(f.directory,'.private'),join(f.directory,'public-alias'));
 for(const path of [join(f.directory,'.env'),join(f.directory,'alias.txt'),join(f.directory,'.private','hidden.txt'),join(f.directory,'.hidden-alias','public.txt'),join(f.directory,'public-alias','hidden.txt')])await assert.rejects(uploadSelectedAttachment(client,path,input));
 await assert.rejects(uploadSelectedAttachment(client,join(f.directory,'missing.txt'),{...input,selection:undefined}),/selection/);
 assert.equal(f.db.prepare('PRAGMA user_version').get().user_version,15);assert.equal((await f.call('memory_list_attachments',{project_id:f.p,run_id:f.r})).total,0);
});
test('repeated commit and original reads refuse a tampered stored file instead of trusting cached receipts',async t=>{
 const f=await setup(t),bytes=Buffer.from('원본 😀\r\n'),u=await f.call('memory_prepare_attachment',manifest(f.p,f.r)),s={project_id:f.p,run_id:f.r,upload_id:u.upload_id};
 await f.call('memory_put_attachment_part',{...s,part:0,data_base64:bytes.toString('base64')});const saved=await f.call('memory_commit_attachment',s);
 f.db.prepare('UPDATE attachment_chunks SET data_base64=?').run(Buffer.alloc(bytes.length,1).toString('base64'));
 await assert.rejects(f.call('memory_commit_attachment',s),{code:'unavailable'});
 await assert.rejects(f.call('memory_read_attachment_part',{project_id:f.p,run_id:f.r,attachment_id:saved.attachment.id}),{code:'unavailable'});
 await assert.rejects(f.call('memory_prepare_attachment',manifest(f.p,f.r)),{code:'unavailable'});
});
