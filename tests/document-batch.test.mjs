import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentBatch} from '../ui/document-batch.js';
const file=(name,text)=>({name,size:Buffer.byteLength(text),arrayBuffer:async()=>new TextEncoder().encode(text).buffer});
const destination={project_id:'project',target_scope:{repository:'main',environment:'dev'},component_key:''};
const preview=input=>({preview_token:'signed-'+input.path,source:{sha256:input.text,bytes:10},parts:1,existing:{state:'new'}});

test('batch independently previews, skips exact duplicates, continues on failures and retries only the exact failed snapshot',async()=>{
 const posts=[];let fail=true;
 const batch=createDocumentBatch({request:async(url,options)=>{
  const input=JSON.parse(options.body);posts.push({url,input});
  if(url.endsWith('preview'))return input.path==='old.md'?{...preview(input),existing:{state:'stored',run_id:'old',record_ids:['record']}}:preview(input);
  if(input.path==='fail.md'&&fail)throw new Error('connection lost');
  return {run_id:input.path,record_ids:['saved']};
 }});
 await batch.select([file('old.md','# old'),file('ok.md','# ok'),file('ok.md','# ok'),file('fail.md','# fail'),file('last.md','# last')]);
 await batch.preview(destination);assert.deepEqual(batch.items.map(i=>i.state),['duplicate','ready','selection_duplicate','ready','ready']);
 assert.equal(posts.filter(p=>p.url.endsWith('import')).length,0);
 await batch.save();assert.deepEqual(batch.items.map(i=>i.state),['duplicate','saved','selection_duplicate','save_error','saved']);assert.equal(batch.locked,true);
 const original=posts.find(p=>p.url.endsWith('import')&&p.input.path==='fail.md');
 batch.rename(3,'changed.md');assert.equal(batch.items[3].path,'fail.md');
 fail=false;const before=posts.length;await batch.save(true);assert.deepEqual(posts.slice(before),[original]);assert.equal(batch.items[3].state,'saved');
});

test('bad files and preview failures do not hide good files; size and selection limits are bounded without truncation',async()=>{
 const batch=createDocumentBatch({request:async(_url,options)=>{const input=JSON.parse(options.body);if(input.path==='bad.md')throw new Error('invalid label');return preview(input);}});
 const broken={name:'broken.md',size:1,arrayBuffer:async()=>new Uint8Array([255]).buffer};
 await batch.select([file('good.md','# good'),broken,{name:'large.md',size:49153},file('bad.md','# bad')]);
 await batch.preview(destination);assert.deepEqual(batch.items.map(i=>i.state),['ready','read_error','read_error','preview_error']);
 assert.match(batch.items[1].message,/UTF-8/);assert.match(batch.items[2].message,/48 KiB/);
 const savedItems=batch.items;await assert.rejects(batch.select(Array.from({length:21},()=>file('x.md','x'))),/20/);assert.equal(batch.items,savedItems);
});

test('destination changes invalidate approvals; selecting another file ignores an older pending file read',async()=>{
 let finishRead;const batch=createDocumentBatch({request:async(_url,options)=>preview(JSON.parse(options.body))});
 const first=batch.select([{name:'old.md',size:1,arrayBuffer:()=>new Promise(resolve=>{finishRead=resolve;})}]);
 batch.invalidate();await batch.select([file('new.md','# new')]);finishRead(new TextEncoder().encode('# old').buffer);await first;
 assert.equal(batch.items[0].path,'new.md');await batch.preview(destination);assert.equal(batch.items[0].state,'ready');
 batch.invalidate();assert.equal(batch.items[0].state,'unreviewed');assert.equal(batch.items[0].reviewed,null);assert.equal(batch.items[0].preview,null);
});

test('different names or changed content are separate documents, and unfinished import completion remains eligible for save',async()=>{
 const batch=createDocumentBatch({request:async(_url,options)=>{const input=JSON.parse(options.body);return {...preview(input),existing:{state:'completion_pending'}};}});
 await batch.select([file('same.md','# one'),file('same.md','# two'),file('other.md','# one')]);await batch.preview(destination);
 assert.deepEqual(batch.items.map(i=>i.state),['ready','ready','ready']);assert.match(batch.items[0].message,/마감/);
});
