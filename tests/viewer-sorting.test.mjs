import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createListSorting} from '../ui/list-sorting.js';
import {recoverySchemaSql} from '../dist/adapters/storage/sqlite/recovery-schema.js';
import {SqliteViewer} from '../dist/adapters/storage/sqlite/viewer.js';
import {startViewer} from '../dist/transport/viewer/server.js';
import {fixture,project,run,checkpoint} from './helpers.mjs';

const date=i=>new Date(Date.UTC(2026,0,1,0,i)).toISOString();
const number=i=>String(i).padStart(2,'0');
function allPages(read){const rows=[];let offset=0;do{const page=read(offset);rows.push(...page.items);offset=page.next_offset;}while(offset!==null);return rows;}

test('task and feature sorting precedes pagination, respects scope and keeps alias matches',async t=>{
 const f=fixture(t),pid=await project(f.call),db=new DatabaseSync(f.path),reader=new SqliteViewer(f.path);t.after(()=>{reader.close();db.close();});
 const ids=[];
 for(let i=0;i<43;i++){
  const id=await run(f.call,pid,{title:`작업 ${number(42-i)}`,repository:i===42?'other':'web',features:[{key:`feature-${number(i)}`,name:`기능 ${number(42-i)}`,aliases:['공통 별칭']}],idempotency_key:`run-${i}`});ids.push(id);
  db.prepare('UPDATE runs SET updated_at=?,state=? WHERE id=?').run(date(i),i===0?'active':'completed',id);
 }
 const expected=ids.toReversed();
 assert.deepEqual(allPages(offset=>reader.runs(pid,{sort:'latest',offset})).map(x=>x.id),expected);
 assert.deepEqual(allPages(offset=>reader.runs(pid,{sort:'oldest',offset})).map(x=>x.id),expected.toReversed());
 assert.deepEqual(allPages(offset=>reader.runs(pid,{sort:'name',offset})).map(x=>x.id),expected);
 assert.deepEqual(allPages(offset=>reader.runs(pid,{sort:'name_desc',offset})).map(x=>x.id),expected.toReversed());
 const active=allPages(offset=>reader.runs(pid,{sort:'active',offset}));assert.equal(active[0].id,ids[0]);assert.equal(active[1].id,ids[42]);
 for(const sort of ['active','latest','oldest','name','name_desc']){
  const rows=allPages(offset=>reader.overview(pid,'features',offset,{sort,repository:'web',query:'공통 별칭'}));
  assert.equal(rows.length,42);assert.equal(new Set(rows.map(x=>x.key)).size,42);assert.ok(rows.every(x=>x.match_reasons.some(r=>r.kind==='feature_alias')));
  const scoped=ids.slice(0,42).reverse();
  const order=sort==='active'?[ids[0],...ids.slice(1,42).reverse()]:sort==='oldest'||sort==='name_desc'?scoped.toReversed():scoped;
  assert.deepEqual(rows.map(x=>x.key),order.map(id=>`feature-${number(ids.indexOf(id))}`));
 }
 // Equal timestamps still have deterministic ordering over page boundaries.
 db.prepare('UPDATE runs SET updated_at=? WHERE project_id=?').run(date(0),pid);
 const tied=allPages(offset=>reader.runs(pid,{sort:'latest',offset})).map(x=>x.id);
 assert.deepEqual(tied,[...ids].sort().reverse());
 assert.throws(()=>reader.runs(pid,{sort:'name;DROP TABLE runs'}),{code:'invalid_input'});
 assert.equal(reader.runs(pid).items.length,40);
});

test('plan sorting uses latest version progress and latest item date; source checks never imply progress',async t=>{
 const f=fixture(t),pid=await project(f.call),rid=await run(f.call,pid),db=new DatabaseSync(f.path),reader=new SqliteViewer(f.path);t.after(()=>{reader.close();db.close();});
 const record=await f.call('memory_checkpoint',checkpoint(pid,rid,{report_origin:'contemporaneous'}));
 for(let i=0;i<15;i++){
  await f.call('memory_save_plan',{project_id:pid,run_id:rid,plan_key:`plan-${number(i)}`,title:`계획 ${number(14-i)}`,source_kind:'markdown',source_ref:'selected.md',source_body:'- [x] 첫 항목\n- [ ] 둘째 항목',idempotency_key:`plan-${i}`});
  db.prepare('UPDATE plan_versions SET created_at=? WHERE plan_key=?').run(date(i),`plan-${number(i)}`);
 }
 const update=(index,item,state)=>f.call('memory_update_plan_item',{project_id:pid,run_id:rid,plan_key:`plan-${number(index)}`,version:1,item_key:item,record_id:record.record_id,state,note:'테스트용 진행 보고',criteria_results:state==='completed'?[{key:'acceptance',met:true,detail:'테스트용 보고이며 실제 검증 아님'}]:[],idempotency_key:`update-${index}-${item}`});
 await update(0,'item-1','completed'); // partial completion is in progress
 await update(1,'item-1','blocked');
 await update(2,'item-1','completed');await update(2,'item-2','completed');
 db.prepare('UPDATE plan_item_updates SET created_at=?').run(date(60));
 const read=sort=>allPages(offset=>reader.plans(pid,{sort,offset}));
 assert.deepEqual(read('name').map(p=>p.plan_key),Array.from({length:15},(_,i)=>`plan-${number(14-i)}`));
 assert.deepEqual(read('oldest').slice(0,3).map(p=>p.plan_key),['plan-03','plan-04','plan-05']);
 assert.deepEqual(read('active').slice(0,2).map(p=>p.plan_key),['plan-00','plan-01']);
 assert.equal(read('active')[0].progress.percent,50);assert.equal(read('active')[1].progress.status,'blocked');
 assert.equal(read('latest').find(p=>p.plan_key==='plan-14').progress.percent,0);
 await f.call('memory_save_plan',{project_id:pid,run_id:rid,plan_key:'plan-00',expected_version:1,title:'새 버전',source_kind:'markdown',source_ref:'selected.md',source_body:'- [x] 변경된 조건',idempotency_key:'new-version'});
 assert.equal(read('active')[0].plan_key,'plan-01');assert.equal(read('active').find(p=>p.plan_key==='plan-00').progress.status,'not_started');
});

test('skills and recovery requests sort globally by name or actual registration/request date without invented progress',async t=>{
 const f=fixture(t),pid=await project(f.call),db=new DatabaseSync(f.path),reader=new SqliteViewer(f.path);t.after(()=>{reader.close();db.close();});
 for(let i=0;i<15;i++)await f.call('memory_register_skill',{project_id:pid,skill_key:`skill-${number(i)}`,version:'1',name:`스킬 ${number(14-i)}`,source:'local:test',body:'테스트 전문',install_instructions:'테스트 설치',idempotency_key:`skill-${i}`});
 for(let i=0;i<15;i++)db.prepare('UPDATE skill_versions SET created_at=? WHERE skill_key=?').run(date(i),`skill-${number(i)}`);
 const skills=sort=>allPages(offset=>reader.skills(pid,{sort,offset}));
 assert.deepEqual(skills('name').map(s=>s.skill_key),Array.from({length:15},(_,i)=>`skill-${number(14-i)}`));
 assert.deepEqual(skills('active'),skills('latest'));assert.equal(skills('oldest')[0].skill_key,'skill-00');assert.equal(skills('name_desc')[0].skill_key,'skill-00');
 const journal=new DatabaseSync(`${f.path}.recovery.sqlite`);t.after(()=>journal.close());
 journal.exec(recoverySchemaSql);
 const insert=journal.prepare('INSERT INTO requests(id,project_id,repository,environment,tool,request_key,payload_hash,input_json,received_at,last_error) VALUES(?,?,?,?,?,?,?,?,?,?)');
 for(let i=0;i<43;i++)insert.run(`request-${number(i)}`,pid,'web','test','memory_begin_task',`key-${i}`,'a'.repeat(64),JSON.stringify({goal:`요청 ${number(42-i)}`}),date(i),'busy');
 const recovery=sort=>allPages(offset=>reader.recovery(pid,offset,sort));
 assert.equal(recovery('name').length,43);assert.equal(recovery('name')[0].goal,'요청 00');assert.equal(recovery('oldest')[0].goal,'요청 42');
 assert.deepEqual(recovery('active'),recovery('latest'));assert.ok(recovery('active').every(r=>r.delivery_status==='recovery_pending'));
 assert.throws(()=>reader.recovery(pid,0,'invalid'),{code:'invalid_input'});
});

test('authenticated HTTP validates sorting and serves the preference module',async t=>{
 const f=fixture(t),pid=await project(f.call);await run(f.call,pid);const server=await startViewer({db:f.path});t.after(()=>server.close());
 const token=new URLSearchParams(new URL(server.url).hash.slice(1)).get('token'),headers={Authorization:`Bearer ${token}`};
 for(const path of ['/api/runs','/api/skills','/api/plans','/api/recovery','/api/overview']){
  const suffix=path==='/api/overview'?'&view=features':'';
  assert.equal((await fetch(`${server.origin}${path}?project=${pid}&sort=latest${suffix}`,{headers})).status,200);
  assert.equal((await fetch(`${server.origin}${path}?project=${pid}&sort=invalid${suffix}`,{headers})).status,400);
  assert.equal((await fetch(`${server.origin}${path}?project=${pid}&sort=name${suffix}`)).status,401);
 }
 assert.equal((await fetch(`${server.origin}/list-sorting.js`,{headers})).status,200);
});

test('sorting preferences are per tab, bounded, and survive reload without touching connection storage',()=>{
 const storage=new Map([['connection','secret'],['skilly.viewer.list-sorting.v1',JSON.stringify({runs:'invalid',skills:'name',unknown:'latest'})]]),writes=[];
 const get=()=>({getItem:key=>storage.get(key),setItem:(key,value)=>{writes.push(key);storage.set(key,value);}});
 const sort=createListSorting(get);assert.equal(sort.get('runs'),'active');assert.equal(sort.get('skills'),'name');
 assert.equal(sort.set('runs','oldest'),true);assert.equal(sort.set('unknown','name'),false);assert.equal(sort.set('runs','bad'),false);
 assert.equal(createListSorting(get).get('runs'),'oldest');assert.deepEqual(writes,['skilly.viewer.list-sorting.v1']);assert.equal(storage.get('connection'),'secret');
 const unavailable=createListSorting(()=>{throw Error('blocked');});assert.equal(unavailable.set('plans','name'),true);assert.equal(unavailable.get('plans'),'name');
});
