import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {openLocal} from '../../dist/runtime/local/app.js';
import {recordLifecycle} from '../../dist/adapters/storage/sqlite/lifecycle.js';
import {eventCapacity} from '../../dist/adapters/storage/sqlite/event-retention.js';
import {eventRetentionCommand} from '../../dist/runtime/local/event-retention.js';

export const digest=path=>createHash('sha256').update(readFileSync(path)).digest('hex');
export const fileHashes=path=>Object.fromEntries(['','.recovery.sqlite','.events.sqlite'].filter(s=>existsSync(path+s)).map(s=>[s,digest(path+s)]));
export const blocked=e=>e.code==='project_write_blocked'||e.message.includes('project_write_blocked');
export function inspectEvents(path,callback){const d=new DatabaseSync(path+'.events.sqlite',{readOnly:true});try{return callback(d);}finally{d.close();}}
export function capacity(path){return inspectEvents(path,d=>eventCapacity(d));}

export async function retainedFixture(t,{large=true,retained=true}={}) {
 const root=mkdtempSync('/private/tmp/skilly-retained-project-'),db=join(root,'memory.sqlite');
 const open=(path,entry)=>{const app=openLocal(path,entry.binding,entry.root);t.after(()=>app.close());return app;};
 const make=async label=>{
  const folder=join(root,label);mkdirSync(folder);
  const binding={version:1,key:label+'-'+randomUUID(),name:'합성 이전 '+label,repository:'web',environment:'test'};
  writeFileSync(join(folder,'skilly.project.json'),JSON.stringify(binding));
  const entry={root:folder,binding},app=open(db,entry),call=(name,input)=>app.dispatcher.call(name,input);
  const p=(await call('memory_resolve_project',{})).project.id,run=(await call('memory_begin_task',{project_id:p,goal:'합성 보존형 이전 '+label,mode:'change',idempotency_key:'begin'})).run.id;
  const note=async key=>(await call('memory_checkpoint',{project_id:p,run_id:run,topic:'retained-transfer',kind:'note',body:'보존할 합성 원문 '+key,idempotency_key:key,report_origin:'contemporaneous'})).record_id;
  const event=(name='PostToolUse',path=db,session='synthetic-'+label)=>recordLifecycle(path,folder,{cwd:folder,session_id:session,hook_event_name:name,tool_name:'Bash'}).observation_id;
  const link=(id,client=app)=>client.dispatcher.call('memory_link_task_events',{project_id:p,run_id:run,observation_id:id});
  const point=await note('first');const anchor=event('SessionStart');await link(anchor);event('Interrupt');
  return {...entry,app,call,p,run,note,event,link,point,anchor};
 };
 const a=await make('selected'),b=await make('foreign');
 const enable=()=>{const preview=eventRetentionCommand('events-retention-status',{db});return eventRetentionCommand('events-retention-enable',{db,expect:preview.expect});};
 if(retained){enable();await a.link(a.event());await b.link(b.event());a.event('Interrupt');b.event('Interrupt');}
 const seed=amount=>{
  const d=new DatabaseSync(db+'.events.sqlite');d.exec('BEGIN IMMEDIATE');
  try{const sample=d.prepare('SELECT * FROM events WHERE project_key=? ORDER BY seq DESC LIMIT 1').get(a.binding.key),foreign=d.prepare('SELECT * FROM events WHERE project_key=? ORDER BY seq DESC LIMIT 1').get(b.binding.key);
   const insert=d.prepare('INSERT INTO events VALUES(NULL,?,?,?,?,?,?,?,?,?,?,?)');
   for(let i=0;i<amount;i++){const row=i%1000===999?foreign:sample;insert.run(randomUUID(),row.project_key,row.repository,row.environment,row.root_hash,row.session_hash,null,'PostToolUse',null,'shell',row.received_at);}
   d.exec('COMMIT');
  }catch(e){d.exec('ROLLBACK');throw e;}finally{d.close();}
 };
 if(large){assert.equal(retained,true);seed(10000-capacity(db).active_events);a.event();seed(30);}
 const point=await a.note('saved-at-interrupt'),interrupt=a.event('Interrupt'),latest=await a.note('after-interrupt');
 const state=join(root,'transfer');
 const status=async(path=db,entry=a)=>{const app=open(path,entry);return (await app.dispatcher.call('memory_get_status',{project_id:entry.p,run_id:entry.run}));};
 const f={root,db,a,b,point,interrupt,latest,state,open,status,seed,enable};
 return f;
}

export function selectedRows(path,key){return inspectEvents(path,d=>d.prepare('SELECT * FROM events WHERE project_key=? ORDER BY seq').all(key));}
export function assertHistory(state,f){const h=state.task_recording.imported_history;assert.equal(state.task_recording.linkage,'not_linked');assert.equal(h.current_session_binding,false);assert.equal(h.interruption.observation_id,f.interrupt);assert.equal(h.interruption.saved_during_event.record_id,f.point);assert.equal(h.interruption.saved_during_event.receipt_confirmed,true);assert.equal(state.task_recording.claims_verified,false);}
