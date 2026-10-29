import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fixture,project,run,checkpoint} from './helpers.mjs';
import {startViewer} from '../dist/transport/viewer/server.js';
import {saveAttachment,validateAttachmentData} from '../dist/adapters/storage/sqlite/attachments.js';
import {putAuthority} from '../dist/adapters/storage/sqlite/project-authority.js';
import {backupDatabase,restoreDatabase} from '../dist/adapters/storage/transfer/snapshot.js';
import {exportProject,importProject} from '../dist/adapters/storage/transfer/project.js';
import {prepareTransfer,activateTransfer,recoverTransfer} from '../dist/adapters/storage/transfer/cutover.js';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
import {diagnoseLocal} from '../scripts/doctor.mjs';
import {formatAttachmentBytes,attachmentPreviewKind} from '../ui/attachments.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function setup(t){
 const f=fixture(t),pid=await project(f.call),rid=await run(f.call,pid,{repository:'main',environment:'test'});
 const note=await f.call('memory_checkpoint',checkpoint(pid,rid,{body:'원래 기록 😀\r\n'}));
 const db=new DatabaseSync(f.path);t.after(()=>db.close());
 const server=await startViewer({db:f.path});t.after(()=>server.close());
 const headers={Authorization:'Bearer '+new URLSearchParams(new URL(server.url).hash.slice(1)).get('token'),Origin:server.origin,'Content-Type':'application/json'};
 const payload=(text='\ufeff원본\r\n<script>alert(1)</script>')=>({project_id:pid,run_id:rid,record_id:note.record_id,name:'원본.txt',data_base64:Buffer.from(text).toString('base64')});
 const post=async(input,patch={})=>{const r=await fetch(server.origin+'/api/attachments',{method:'POST',headers:{...headers,...patch},body:typeof input==='string'?input:JSON.stringify(input)});return {status:r.status,data:await r.json()};};
 const list=async()=>{const r=await fetch(server.origin+`/api/attachments?project=${pid}&run=${rid}`,{headers});return {status:r.status,data:await r.json()};};
 const original=async(id,p=pid,r=rid)=>fetch(server.origin+`/api/attachments/${id}/original?project=${p}&run=${r}`,{headers});
 const version=()=>db.prepare('PRAGMA user_version').get().user_version;
 return {...f,pid,rid,note,db,server,headers,payload,post,list,original,version};
}
test('read-only empty attachments do not migrate; original bytes, source file and records survive exact retries',async t=>{
 const f=await setup(t);const rows=f.db.prepare('SELECT * FROM records').all();assert.equal(f.version(),15);
 const empty=await f.list();assert.equal(empty.status,200);assert.equal(empty.data.total,0);assert.equal(empty.data.usage.original_bytes,0);assert.equal(f.version(),15);
 const input=f.payload(),bytes=Buffer.from(input.data_base64,'base64'),source=join(f.directory,'source.txt');writeFileSync(source,bytes);
 const saved=await f.post(input);assert.equal(saved.status,200);assert.equal(saved.data.duplicate,false);assert.equal(saved.data.claims_verified,false);assert.equal(f.version(),17);
 const retry=await f.post(input);assert.equal(retry.status,200);assert.equal(retry.data.duplicate,true);assert.equal(retry.data.attachment.id,saved.data.attachment.id);
 const original=await f.original(saved.data.attachment.id);assert.equal(original.status,200);assert.equal(original.headers.get('content-type'),'application/octet-stream');assert.match(original.headers.get('content-disposition'),/^attachment;/);
 assert.equal(original.headers.get('x-skilly-content-sha256'),hash(bytes));assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes);
 assert.deepEqual(readFileSync(source),bytes);assert.deepEqual(f.db.prepare('SELECT * FROM records').all(),rows);
 const data=(await f.list()).data;assert.equal(data.usage.unique_files,1);assert.equal(data.usage.original_bytes,bytes.length);assert.equal(data.usage.database_scope,'all_projects');assert.equal(data.usage.automatic_deletion,false);assert.ok(data.usage.database_total_bytes>bytes.length);
 assert.equal(data.items[0].record_id,f.note.record_id);assert.equal(data.items[0].claims_verified,false);
});
test('same project bytes deduplicate across names and tasks; concurrent response retries add one link',async t=>{
 const f=await setup(t),input=f.payload();
 const results=await Promise.all(Array.from({length:8},()=>f.post(input)));assert.ok(results.every(r=>r.status===200));assert.equal(new Set(results.map(r=>r.data.attachment.id)).size,1);
 assert.equal((await f.post({...input,name:'별도 이름.txt'})).status,200);
 const rid=await run(f.call,f.pid,{idempotency_key:'another-task'});assert.equal((await f.post({...input,run_id:rid,record_id:undefined})).status,200);
 const data=(await f.list()).data;assert.equal(data.total,2);assert.equal(data.usage.links,3);assert.equal(data.usage.unique_files,1);
 assert.equal(data.usage.original_bytes,Buffer.from(input.data_base64,'base64').length);
});
test('auth, foreign project/run/record, filenames and malformed requests fail without schema writes',async t=>{
 const f=await setup(t),input=f.payload();
 assert.equal((await f.post(input,{Authorization:'Bearer invalid'})).status,401);
 assert.equal((await f.post(input,{Origin:'https://evil.example'})).status,403);
 assert.equal((await f.post(input,{Origin:''})).status,403);
 const foreign=await project(f.call,'other'),rid=await run(f.call,f.pid,{idempotency_key:'foreign-record-task'});
 for(const patch of [{project_id:foreign},{run_id:rid},{record_id:randomUUID()}])assert.equal((await f.post({...input,...patch})).status,404);
 for(const name of ['../escape','/etc/passwd','evil\\file','\r\nevil','.env','.env.local','auth.json','id_rsa','secret.pem'])assert.equal((await f.post({...input,name})).status,400,name);
 for(const patch of [{data_base64:'YWJj\n'},{data_base64:'not base64'},{extra:'no'},{name:'x'.repeat(181)}])assert.equal((await f.post({...input,...patch})).status,400);
 assert.equal((await f.post('{')).status,400);assert.equal((await f.post(input,{'Content-Type':'text/plain'})).status,400);
 assert.equal((await f.post({...input,data_base64:Buffer.alloc(4*1024*1024+1).toString('base64')})).status,400);
 assert.equal(f.version(),15);assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name LIKE 'attachment_%'").get().n,0);
});
test('download scope, empty files, paging and record membership are explicit',async t=>{
 const f=await setup(t),input={...f.payload(''),record_id:undefined};
 const empty=await f.post(input);assert.equal(empty.status,200);assert.equal((await f.original(empty.data.attachment.id)).status,200);
 const other=await project(f.call,'other'),otherRun=await run(f.call,other);
 assert.equal((await f.original(empty.data.attachment.id,other,otherRun)).status,404);
 const another=await run(f.call,f.pid,{idempotency_key:'different'});assert.equal((await f.original(empty.data.attachment.id,f.pid,another)).status,404);
 for(let n=0;n<23;n++)assert.equal((await f.post({...input,name:`file-${n}.txt`})).status,200);
 const page=(await f.list()).data;assert.equal(page.total,24);assert.equal(page.items.length,20);assert.equal(page.next_offset,20);assert.equal(page.usage.unique_files,1);
 const more=await fetch(f.server.origin+`/api/attachments?project=${f.pid}&run=${f.rid}&offset=20`,{headers:f.headers});assert.equal((await more.json()).items.length,4);
});
test('failed link writes rollback object bytes, leave records intact and allow an exact retry',async t=>{
 const f=await setup(t);await f.post(f.payload());const originalRows=f.db.prepare('SELECT * FROM records').all();
 const before=f.db.prepare('SELECT * FROM attachment_objects').all();f.db.exec("CREATE TRIGGER fail_attachment BEFORE INSERT ON record_attachments BEGIN SELECT RAISE(ABORT,'fixture'); END");
 const input=f.payload('new bytes');assert.equal((await f.post(input)).status,503);assert.deepEqual(f.db.prepare('SELECT * FROM attachment_objects').all(),before);assert.deepEqual(f.db.prepare('SELECT * FROM records').all(),originalRows);
 f.db.exec('DROP TRIGGER fail_attachment');assert.equal((await f.post(input)).status,200);validateAttachmentData(f.db);
});
test('first migration failure rolls back its extension and preserves existing schema objects',async t=>{
 const f=await setup(t);f.db.exec('CREATE TABLE attachment_chunks (original TEXT)');
 assert.equal((await f.post(f.payload())).status,503);assert.equal(f.version(),15);assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='storage_origins'").get().n,0);
 assert.equal(f.db.prepare('SELECT count(*) n FROM attachment_chunks').get().n,0);
});
test('tampered content cannot be downloaded or acknowledged as an existing successful duplicate',async t=>{
 const f=await setup(t),input=f.payload();const saved=await f.post(input);
 f.db.prepare('UPDATE attachment_chunks SET data_base64=?').run(Buffer.from('tampered').toString('base64'));
 assert.equal((await f.original(saved.data.attachment.id)).status,503);assert.equal((await f.post(input)).status,503);
});
test('project quota refuses new bytes without deleting existing objects',async t=>{
 const f=await setup(t);await f.post(f.payload());
 // Synthetic quota metadata isolates the admission rule without filling the test disk.
 for(let n=0;n<16;n++)f.db.prepare('INSERT INTO attachment_objects VALUES(?,?,?,?,?)').run(f.pid,String(n).padStart(64,'0'),4*1024*1024,64,new Date().toISOString());
 const count=f.db.prepare('SELECT count(*) n FROM attachment_objects').get().n;
 assert.equal((await f.post(f.payload('over quota'))).status,400);assert.equal(f.db.prepare('SELECT count(*) n FROM attachment_objects').get().n,count);
});
test('fenced project writes refuse before migration and v17 triggers fence already-open writers',async t=>{
 const f=await setup(t),authority={project_id:f.pid,project_key:'example',transfer_id:randomUUID(),generation:1,role:'source',state:'blocked',updated_at:new Date().toISOString()};
 putAuthority(f.db,'main',authority);assert.equal((await f.post(f.payload())).status,409);assert.equal(f.version(),15);
 f.db.prepare("UPDATE project_authority SET state='writable'").run();assert.equal((await f.post(f.payload())).status,200);
 f.db.prepare("UPDATE project_authority SET state='blocked'").run();assert.equal((await f.post(f.payload('new'))).status,409);
 assert.throws(()=>f.db.prepare('UPDATE attachment_chunks SET data_base64=?').run(''),/project_write_blocked/);
});
test('backup/restore and project-only export/import preserve chunked originals and exact record links',async t=>{
 const f=await setup(t),bytes=Buffer.alloc(190000,133),input={...f.payload(),name:'원본.bin',data_base64:bytes.toString('base64')};
 const saved=await f.post(input);assert.equal(saved.status,200);await project(f.call,'excluded-project');
 const directory=realpathSync(f.directory),backup=join(directory,'backup'),restored=join(directory,'restored'),bundle=join(directory,'project'),imported=join(directory,'imported');
 await backupDatabase(realpathSync(f.path),backup);await restoreDatabase(backup,restored);exportProject(realpathSync(f.path),f.pid,bundle);await importProject(bundle,imported);
 for(const path of [join(restored,'memory.sqlite'),join(imported,'memory.sqlite')]){
  const reader=new SqliteViewer(path);try{assert.deepEqual(reader.attachmentOriginal(f.pid,f.rid,saved.data.attachment.id).bytes,bytes);assert.equal(reader.attachments(f.pid,f.rid).items[0].record_id,f.note.record_id);}finally{reader.close();}
 }
 const selected=new DatabaseSync(join(imported,'memory.sqlite'));try{assert.equal(selected.prepare('SELECT count(*) n FROM projects').get().n,1);}finally{selected.close();}
 const db=new DatabaseSync(join(restored,'memory.sqlite'));try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,17);validateAttachmentData(db);}finally{db.close();}
});
test('display units and preview types never treat active HTML/SVG as a document',()=>{
 assert.equal(formatAttachmentBytes(0),'0 B');assert.equal(formatAttachmentBytes(2048),'2.0 KiB');assert.equal(formatAttachmentBytes(4194304),'4.0 MiB');
 assert.equal(attachmentPreviewKind(Buffer.from('<svg onload=alert(1)>'),'evil.svg'),null);
 assert.equal(attachmentPreviewKind(Buffer.from('<script>alert(1)</script>'),'evil.html'),null);
 assert.equal(attachmentPreviewKind(Buffer.from('literal <script>'),'notes.md'),'text/plain');
});
test('doctor recognizes v17 without changing original data',async t=>{
 const f=await setup(t);await f.post(f.payload());writeFileSync(join(f.directory,'skilly.project.json'),JSON.stringify({version:1,key:'example',name:'example',repository:'main',environment:'test'}));
 const before=f.db.prepare('SELECT * FROM records').all(),report=await diagnoseLocal({project:realpathSync(f.directory),db:realpathSync(f.path)});
 assert.equal(report.database.status,'readable');assert.equal(report.database.schema_version,17);assert.equal(report.database.project_registered,true);assert.deepEqual(f.db.prepare('SELECT * FROM records').all(),before);
});
test('v17 write cutover and return keep original attachments and fence the previous connection',async t=>{
 const f=await setup(t),input=f.payload(),saved=await f.post(input),operation=join(realpathSync(f.directory),'cutover');
 await prepareTransfer(realpathSync(f.path),f.pid,operation);const active=activateTransfer(operation);
 assert.equal((await f.post(f.payload('old source'))).status,409);
 const next=saveAttachment(active.active_db,{...input,name:'새 연결.txt'});assert.equal(next.status,'persisted');
 const returned=await recoverTransfer(operation);assert.equal(returned.status,'returned');
 const reader=new SqliteViewer(returned.active_db);try{assert.equal(reader.attachments(f.pid,f.rid).total,2);assert.deepEqual(reader.attachmentOriginal(f.pid,f.rid,saved.data.attachment.id).bytes,Buffer.from(input.data_base64,'base64'));}finally{reader.close();}
 assert.throws(()=>saveAttachment(active.active_db,{...input,name:'차단.txt'}),/fenced/);
});
test('raster previews check dimensions before decoding and refuse animation or unknown formats',()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1kAAAAASUVORK5CYII=','base64');
 assert.equal(attachmentPreviewKind(png,'small.png'),'image/png');
 const huge=Buffer.from(png);huge.writeUInt32BE(20000,16);assert.equal(attachmentPreviewKind(huge,'huge.png'),null);
 const broken=Buffer.from(png);broken.writeUInt32BE(0xffffffff,33);assert.equal(attachmentPreviewKind(broken,'broken.png'),null);
 const animated=Buffer.concat([png.subarray(0,33),Buffer.from([0,0,0,0,97,99,84,76,0,0,0,0]),png.subarray(33)]);assert.equal(attachmentPreviewKind(animated,'animated.png'),null);
 assert.equal(attachmentPreviewKind(Buffer.from('GIF89a'),'animated.gif'),null);
 assert.equal(attachmentPreviewKind(Buffer.from('RIFFxxxxWEBP'),'animated.webp'),null);
 const jpeg=Buffer.from([255,216,255,192,0,8,8,0,10,0,10,1]);assert.equal(attachmentPreviewKind(jpeg,'small.jpg'),'image/jpeg');
 jpeg[9]=16;assert.equal(attachmentPreviewKind(jpeg,'large.jpg'),null);
});
