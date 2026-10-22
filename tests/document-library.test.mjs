import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {randomUUID} from 'node:crypto';
import {fixture,project,run} from './helpers.mjs';import {startViewer} from '../dist/transport/viewer/server.js';
import {documentChangeRange,createDocumentLibrary} from '../ui/document-library.js';
async function setup(t){
 const f=fixture(t),pid=await project(f.call);const server=await startViewer({db:f.path});t.after(()=>server.close());
 const headers={Authorization:'Bearer '+new URLSearchParams(new URL(server.url).hash.slice(1)).get('token'),Origin:server.origin,'Content-Type':'application/json'};
 const get=async(path,custom=headers)=>{const response=await fetch(server.origin+path,{headers:custom});return {status:response.status,data:await response.json()};};
 const post=async(op,input)=>{const response=await fetch(server.origin+'/api/documents/'+op,{method:'POST',headers,body:JSON.stringify(input)});assert.equal(response.status,200);return response.json();};
 const save=async(path,text,extra={})=>{const input={project_id:pid,target_scope:{repository:'main',environment:'test'},component_key:'',path,text,...extra};const p=await post('preview',input);return post('import',{...input,preview_token:p.preview_token});};
 return {...f,pid,server,headers,get,save};
}
test('library groups source histories, reconstructs exact multipart versions, and compares other sources without merging them',async t=>{
 const f=await setup(t),original='\ufeff# 과거 원문\r\n<script>자료</script> 😀\r\n'.repeat(260),changed=original+'새 내용\r\n';
 const v1=await f.save('docs/history.md',original),v2=await f.save('docs/history.md',changed);await f.save('docs/history.md',changed);
 const rid=await run(f.call,f.pid,{repository:'main',environment:'test',components:[{key:'web',name:'Web'}]});
 const other=await f.save('docs/history.md','# Web 출처\n',{target_scope:undefined,target_run_id:rid,component_key:'web'});
 const db=new DatabaseSync(f.path);t.after(()=>db.close());const before=db.prepare('SELECT * FROM records ORDER BY seq').all();
 const list=await f.get('/api/documents?project='+f.pid);assert.equal(list.status,200);assert.equal(list.data.items.length,2);assert.equal(list.data.items.find(i=>i.source_root==='viewer').version_count,2);
 const id=v2.record_ids[0],detail=await f.get(`/api/document?project=${f.pid}&document=${id}`);assert.equal(detail.status,200);assert.equal(detail.data.current.text,changed);assert.equal(detail.data.previous.text,original);assert.equal(detail.data.current.integrity,'stored_bytes_match_metadata');assert.equal(detail.data.current.claims_verified,false);assert.equal(detail.data.current.source_path_verified,false);assert.equal(detail.data.comparison_kind,'same_document');
 const older=await f.get(`/api/document?project=${f.pid}&document=${id}&version=${v1.record_ids[0]}`);assert.equal(older.data.current.text,original);assert.equal(older.data.previous,null);
 const compare=await f.get(`/api/document?project=${f.pid}&document=${id}&compare=${other.record_ids[0]}`);assert.equal(compare.data.comparison_kind,'different_source_or_document');assert.equal(compare.data.previous.source_root,'component:web');
 assert.deepEqual(db.prepare('SELECT * FROM records ORDER BY seq').all(),before);
});
test('library enforces authentication, project isolation, version-family membership and bounded queries',async t=>{
 const f=await setup(t),a=await f.save('a.md','# A'),b=await f.save('b.md','# B'),other=await project(f.call,'other');
 const root=`/api/document?project=${f.pid}&document=${a.record_ids[0]}`;
 assert.equal((await f.get('/api/documents?project='+f.pid,{})).status,401);
 assert.equal((await f.get(root,{...f.headers,Origin:'https://example.com'})).status,403);
 assert.equal((await f.get(root+'&version='+b.record_ids[0])).status,404);
 assert.equal((await f.get(root.replace(f.pid,other))).status,404);assert.equal((await f.get(root+'&compare='+randomUUID())).status,404);
 for(const path of ['/api/document?project='+f.pid,root+'&version=invalid','/api/documents?project='+f.pid+'&offset=-1','/api/documents?project='+f.pid+'&query='+('x'.repeat(201))])assert.equal((await f.get(path)).status,400);
 assert.deepEqual((await f.get('/api/documents?project='+other)).data.items,[]);
 assert.equal((await f.get('/api/documents?project='+f.pid+'&query=not-found')).data.items.length,0);
});
test('document and version pages are bounded and older versions remain selectable',async t=>{
 const f=await setup(t);let latest;
 for(let i=0;i<22;i++){latest=await f.save('history.md','# Version '+i);await f.save('file-'+i+'.md','# source');}
 const list=await f.get('/api/documents?project='+f.pid);assert.equal(list.data.items.length,20);assert.equal(list.data.next_offset,20);
 assert.equal((await f.get('/api/documents?project='+f.pid+'&offset=20')).data.items.length,3);
 const detail=await f.get(`/api/document?project=${f.pid}&document=${latest.record_ids[0]}&offset=20`);assert.equal(detail.data.versions.total,22);assert.equal(detail.data.versions.items.length,2);assert.equal(detail.data.versions.next_offset,null);
 assert.equal((await f.get(`/api/document?project=${f.pid}&document=${latest.record_ids[0]}&version=${detail.data.versions.items[1].id}`)).data.current.text,'# Version 0');
});
test('incomplete or changed stored bytes are never presented as a complete original',async t=>{
 const f=await setup(t),saved=await f.save('original.md','original\n'.repeat(1600));const db=new DatabaseSync(f.path);t.after(()=>db.close());
 db.prepare('UPDATE records SET body=body||? WHERE id=?').run('tampered',saved.record_ids[1]);const before=db.prepare('SELECT * FROM records ORDER BY seq').all();
 const result=await f.get(`/api/document?project=${f.pid}&document=${saved.record_ids[0]}`);assert.equal(result.status,503);assert.equal(result.data.current,undefined);
 assert.deepEqual(db.prepare('SELECT * FROM records ORDER BY seq').all(),before);
});
test('difference ranges preserve BOM, CRLF, blank lines and literal markup with bounded rendering pieces',()=>{
 for(const [before,after] of [['\ufeff# 제목\r\n원문\r\n끝\n','\ufeff# 제목\r\n<script>변경</script>\r\n끝\n'],['a\n','a\n'],['','\n'],['same\n','same']]){
  const range=documentChangeRange(before,after);assert.equal(range.before.join(''),before);assert.equal(range.after.join(''),after);assert.equal(range.identical,before===after);assert.equal(range.before.length,3);
 }
});

class Element {
 constructor(tag){this.tagName=tag;this.children=[];this.attributes={};this.listeners={};this.value='';}
 set textContent(value){this.children=[String(value)];}get textContent(){return this.children.map(c=>typeof c==='string'?c:c.textContent).join('');}
 append(...children){this.children.push(...children);}replaceChildren(...children){this.children=children;}
 setAttribute(key,value){this.attributes[key]=value;}addEventListener(name,callback){this.listeners[name]=callback;}showModal(){}close(){}
 all(){return this.children.filter(c=>c instanceof Element).flatMap(c=>[c,...c.all()]);}
}
const doc=()=>({body:new Element('body'),createElement:tag=>new Element(tag),createTextNode:text=>text});
const meta=(id,root='viewer')=>({id,run_id:'run',path:'docs/history.md',repository:'main',environment:'test',source_root:root,sha256:id.repeat(64),bytes:20,imported_at:'2026-10-22T00:00:00Z',version_count:2,record_ids:[id],text:id+'\n'});
test('library UI renders literal originals, source comparison, and ignores stale project responses',async()=>{
 const document=doc();let finishOld;const old=new Promise(resolve=>{finishOld=resolve;});const current=meta('b'),previous=meta('a');
 const requests=[];const library=createDocumentLibrary({document,request:async path=>{
  requests.push(path);const params=new URL('http://local'+path).searchParams;
  if(params.get('project')==='old')return old;
  if(path.startsWith('/api/documents?'))return {items:[current,meta('c','component:web')],next_offset:null};
  return {document:current,versions:{items:[current,previous],total:2,next_offset:null},current:{...current,text:'<script>원문</script>\r\n'},previous,comparison_kind:'same_document'};
 }});
 const first=library.open({id:'old',name:'이전 프로젝트'});await library.open({id:'new',name:'선택 프로젝트'});finishOld({items:[meta('x')],next_offset:null});await first;
 assert.match(document.body.textContent,/선택 프로젝트/);assert.doesNotMatch(document.body.textContent,/이전 프로젝트/);assert.match(document.body.textContent,/<script>원문<\/script>/);
 assert.equal(document.body.all().filter(n=>n.tagName==='script').length,0);
 const compare=document.body.all().find(n=>n.attributes['aria-label']==='비교할 보관본');compare.value='c';compare.listeners.change();await new Promise(resolve=>setImmediate(resolve));assert.match(requests.at(-1),/compare=c/);
});

test('starting a new library search clears old paging and cannot append a different query to the old list',async()=>{
 const document=doc();let finishSearch;const requests=[];
 const library=createDocumentLibrary({document,request:async path=>{
  requests.push(path);const params=new URL('http://local'+path).searchParams;
  if(path.startsWith('/api/documents?')){
   if(params.get('query')==='new')return new Promise(resolve=>{finishSearch=resolve;});
   return {items:[meta('a')],next_offset:20};
  }
  return {document:meta('a'),versions:{items:[meta('a')],total:1,next_offset:null},current:meta('a'),previous:null,comparison_kind:null};
 }});
 await library.open({id:'project',name:'검색 테스트'});
 const search=document.body.all().find(n=>n.attributes['aria-label']==='가져온 문서 검색');search.value='new';
 const buttons=()=>document.body.all().filter(n=>n.tagName==='button');const more=buttons().find(n=>n.textContent==='문서 더 보기');
 buttons().find(n=>n.textContent==='검색').listeners.click();assert.equal(more.hidden,true);const before=requests.length;
 more.listeners.click();await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,before);
 finishSearch({items:[],next_offset:null});await new Promise(resolve=>setImmediate(resolve));
 assert.equal(document.body.all().filter(n=>n.className.startsWith('task-card')).length,0);assert.doesNotMatch(requests.at(-1),/offset=20/);
});

test('a failed original read leaves an explicit failure instead of stale text or a loading indicator',async()=>{
 const document=doc(),library=createDocumentLibrary({document,request:async path=>{
  if(path.startsWith('/api/documents?'))return {items:[meta('a')],next_offset:null};throw new Error('incomplete original');
 }});
 await library.open({id:'project',name:'손상 원문 테스트'});
 assert.match(document.body.textContent,/원문을 표시하지 못했습니다/);assert.match(document.body.textContent,/incomplete original/);assert.doesNotMatch(document.body.textContent,/불러오는 중/);
});
