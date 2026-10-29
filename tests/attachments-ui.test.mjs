import test from 'node:test';
import assert from 'node:assert/strict';
import {createAttachments} from '../ui/attachments.js';

class Element {
 constructor(tag){this.tag=tag;this.children=[];this.listeners={};this.classList={add(){},remove(){}};this.value='';}
 set textContent(v){this.children=[String(v)];}
 get textContent(){return this.children.map(x=>typeof x==='string'?x:x.textContent).join(' ');}
 get options(){return this.children.filter(x=>x.tag==='option');}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=items;}
 setAttribute(){}
 addEventListener(name,fn){this.listeners[name]=fn;}
 find(predicate){if(predicate(this))return this;return this.children.filter(x=>typeof x!=='string').map(x=>x.find(predicate)).find(Boolean);}
}
const document={createElement:tag=>new Element(tag)};
const empty={items:[],total:0,next_offset:null};
const tick=()=>new Promise(setImmediate);
test('saving during an older pending list always schedules a fresh read',async()=>{
 let release,reads=0;const calls=[];
 const saved={id:'attachment',name:'new.txt',bytes:3,project_id:'project',run_id:'run',record_id:'record',sha256:'hash'};
 const ui=createAttachments({document,headers:()=>({}),onUnauthorized(){},request:async(path,options)=>{
  calls.push({path,options});if(options?.method==='POST')return {status:'persisted',duplicate:false,attachment:saved};
  reads++;if(reads===1)return new Promise(resolve=>{release=resolve;});return {...empty,items:[saved],total:1};
 }});
 const root=ui.panel('project','run',[{id:'record',report:{title:'선택한 원문'}}]);
 const file=root.find(x=>x.tag==='input'),select=root.find(x=>x.tag==='select'),save=root.find(x=>x.tag==='button'&&x.textContent==='원본 보관');
 file.files=[{name:'new.txt',size:3,arrayBuffer:async()=>new TextEncoder().encode('new').buffer}];file.listeners.change();select.value='record';
 await save.listeners.click();assert.equal(reads,1);
 release(empty);await tick();await tick();assert.equal(reads,2);assert.match(root.textContent,/new.txt/);
 const input=JSON.parse(calls.find(c=>c.options?.method==='POST').options.body);assert.equal(input.record_id,'record');assert.equal(input.data_base64,'bmV3');
});
test('later record pages cannot silently replace the selected attachment target with the whole task',async()=>{
 const ui=createAttachments({document,headers:()=>({}),onUnauthorized(){},request:async()=>empty});
 const root=ui.panel('project','run',[{id:'older',report:{title:'이전 원문'}}]);const select=root.find(x=>x.tag==='select');select.value='older';
 ui.panel('project','run',[{id:'latest',report:{title:'새 원문'}}]);assert.equal(select.value,'older');assert.ok(select.options.some(x=>x.value==='older'));
 await tick();
});
test('a late response from another project cannot overwrite the current attachment panel',async()=>{
 let release;const ui=createAttachments({document,headers:()=>({}),onUnauthorized(){},request:async path=>{
  if(path.includes('project=first'))return new Promise(resolve=>{release=resolve;});return {...empty,items:[{id:'new',name:'current.txt',bytes:2}],total:1};
 }});
 const root=ui.panel('first','old',[]);ui.panel('second','new',[]);await tick();release({...empty,items:[{id:'old',name:'stale.txt',bytes:1}],total:1});await tick();
 assert.match(root.textContent,/current.txt/);assert.doesNotMatch(root.textContent,/stale.txt/);
});
