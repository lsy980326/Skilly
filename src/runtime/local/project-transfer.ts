import { DatabaseSync } from 'node:sqlite';
import { closeSync,existsSync,lstatSync,readFileSync } from 'node:fs';
import { dirname,join,sep } from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { SqliteD1ProjectTransfer } from '../../adapters/storage/portable/transfer.js';
import { localAuthority,localIdentity,readLocalProject } from '../../adapters/storage/portable/sqlite.js';
import { localToD1 } from '../../adapters/storage/portable/format.js';
import { canonical } from '../../adapters/storage/d1/query.js';
import { safePath,newDirectory,writeNew,fileDescriptor,fail } from '../../adapters/storage/transfer/files.js';
import { openTransferD1,transferMigrations } from './transfer-d1.js';

const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
const hex=z.string().regex(/^[a-f0-9]{64}$/);
const intentSchema=z.strictObject({version:z.literal(1),id:z.uuid(),source:z.string(),project_id:z.uuid(),d1:z.string(),state:z.string(),
 source_identity:z.strictObject({dev:z.number(),ino:z.number()}),snapshot_hash:hex,schema_hash:hex,expected_hash:hex});
type Intent=z.infer<typeof intentSchema>;
type Options={db:string;projectId:string;d1:string;state:string};
function readJson(path:string,max=16384):unknown {const fd=fileDescriptor(path,max);try{return JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}}
function disjoint(paths:string[]){
 paths.forEach(safePath);const normalized=paths.map(p=>process.platform==='darwin'?p.toLowerCase():p);
 for(let i=0;i<paths.length;i++)for(let j=i+1;j<paths.length;j++)if(normalized[i]===normalized[j]||normalized[i]!.startsWith(normalized[j]+sep)||normalized[j]!.startsWith(normalized[i]+sep))fail('invalid_path','Source, D1, operation and return paths must be separate; nothing was changed.');
}
function paths(o:Options,output?:string){disjoint([o.db,o.db+'.recovery.sqlite',o.db+'.events.sqlite',o.d1,o.state,...(output?[output]:[])]);}
function fresh(path:string){safePath(path);if(existsSync(path))fail('destination_exists','Use a new destination; existing files are preserved.');if(!lstatSync(dirname(path)).isDirectory())fail('invalid_path','Destination parent must be an existing directory.');}
export async function previewProjectTransfer(o:Options){
 paths(o);fresh(o.d1);fresh(o.state);
 const authority=localAuthority(o.db,o.projectId);if(authority['write_allowed']!==true)fail('authority_conflict','Source is already fenced; inspect its existing operation.');
 const snapshot=readLocalProject(o.db,o.projectId);
 if(snapshot.tables.executions.some(e=>e['ended_at']===null))fail('execution_in_progress','An unfinished execution exists. Nothing was closed or rerun.');
 const bundle=await localToD1(snapshot,'0'.repeat(32)),schemaHash=transferMigrations().hash;
 const plan={version:1 as const,source:o.db,project_id:o.projectId,d1:o.d1,state:o.state,source_identity:localIdentity(o.db),snapshot_hash:hash(snapshot),schema_hash:schemaHash};
 return {status:'preview',...plan,expected_hash:hash(plan),project_key:snapshot.tables.projects[0]!['project_key'],
  tables:Object.fromEntries(Object.entries(bundle.tables).map(([k,v])=>[k,v?.length??0])),rows:Object.values(bundle.tables).reduce((n,v)=>n+(v?.length??0),0),bytes:Buffer.byteLength(JSON.stringify(bundle)),
  effects:['Fence only the selected source project.','Activate the explicitly selected local D1.','Return into a new SQLite copy; never reopen the original.'],
  target_status:'new_local_directory_required',remote:false,files_changed:false,claims_verified:false,limits:{bytes:1048576,rows:2000}};
}
function existing(o:Options):Intent {
 const i=intentSchema.parse(readJson(join(o.state,'intent.json')));
 if(i.source!==o.db||i.project_id!==o.projectId||i.d1!==o.d1||i.state!==o.state||canonical(i.source_identity)!==canonical(localIdentity(o.db)))fail('authority_conflict','Explicit paths/project/source identity differ from the selected operation.');
 const {id,expected_hash,...approved}=i;void id;if(hash(approved)!==expected_hash)fail('invalid_transfer','Operation approval data is incomplete.');
 return i;
}
function returnSelection(bridge:string){const f=join(bridge,'return.json');if(!existsSync(f))return;return z.strictObject({directory:z.string()}).parse(readJson(f,4096)).directory;}
async function inspect(bridge:SqliteD1ProjectTransfer,db:Awaited<ReturnType<typeof openTransferD1>>['db'],o:Options){
 const result=await bridge.status();
 const snapshot=result.phase==='returned'&&result.active_sqlite_db?readLocalProject(result.active_sqlite_db,o.projectId):result.phase==='preparing'?readLocalProject(o.db,o.projectId):null;
 const latest=snapshot?snapshot.tables.records.toSorted((a,b)=>Number(b['seq'])-Number(a['seq']))[0]
  :(await db.withSession('first-primary').prepare('SELECT id,run_id,seq,recorded_at FROM records WHERE project_id=? ORDER BY seq DESC LIMIT 1').bind(o.projectId).all()).results[0];
 const interruption=snapshot?snapshot.events.events.filter(e=>e['event']==='Interrupt').toSorted((a,b)=>Number(b['seq'])-Number(a['seq']))[0]
  :(await db.withSession('first-primary').prepare("SELECT id,seq FROM lifecycle_events WHERE project_id=? AND event='Interrupt' ORDER BY seq DESC LIMIT 1").bind(o.projectId).all()).results[0];
 const saved=interruption?(snapshot?snapshot.events.event_task_links.find(x=>x['event_id']===interruption['id'])
  :(await db.withSession('first-primary').prepare('SELECT saved_json FROM event_task_snapshots WHERE project_id=? AND event_id=? LIMIT 1').bind(o.projectId,String(interruption['id'])).all()).results[0]):null;
 return {...result,latest_saved_record:latest?{id:latest['id'],run_id:latest['run_id'],seq:latest['seq'],recorded_at:latest['recorded_at']}:null,
  last_interruption:interruption?{observation_id:interruption['id'],saved_during_event:saved?JSON.parse(String(saved['saved_json'])):null,claims_verified:false}:null,
  remote:false,settings_changed:false,execution_status:'not_observed',next_action:result.phase==='returned'?'Select the returned SQLite explicitly; client settings are unchanged.':'Use resume for this operation, or return --output with a fresh directory.'};
}
/** Local-only host command. All endpoints are explicit arguments, not paths followed from records. */
export async function projectTransferCommand(args:string[]){
 const {values:v,positionals:p}=parseArgs({args,allowPositionals:true,options:{db:{type:'string'},'project-id':{type:'string'},d1:{type:'string'},state:{type:'string'},expect:{type:'string'},output:{type:'string'}}});
 const command=p[0];
 if(p.length!==1||!command||!['preview','execute','status','resume','return'].includes(command)||!v.db||!v['project-id']||!v.d1||!v.state
  ||(command==='execute'?!v.expect:v.expect!==undefined)||(command==='return'?!v.output:v.output!==undefined))fail('invalid_input','Use project-transfer preview|execute|status|resume|return with explicit --db --project-id --d1 --state; execute also needs --expect, return needs --output.');
 const o:Options={db:v.db,projectId:z.uuid().parse(v['project-id']),d1:v.d1,state:v.state};paths(o,v.output);
 if(command==='preview')return previewProjectTransfer(o);
 let i:Intent;
 if(command==='execute'&&!existsSync(o.state)){
  const preview=await previewProjectTransfer(o);if(preview.expected_hash!==v.expect)fail('preview_changed','Preview changed or approval hash differs; no source was fenced.');
  i={version:1,id:randomUUID(),source:o.db,project_id:o.projectId,d1:o.d1,state:o.state,source_identity:preview.source_identity,snapshot_hash:preview.snapshot_hash,schema_hash:preview.schema_hash,expected_hash:preview.expected_hash};
  newDirectory(o.state);writeNew(join(o.state,'intent.json'),JSON.stringify(i));writeNew(join(o.state,'command.sqlite'),'');
  const init=new DatabaseSync(join(o.state,'command.sqlite'));try{init.exec('CREATE TABLE command_lock(id INTEGER PRIMARY KEY) STRICT;');}finally{init.close();}
 }else i=existing(o);
 if(command==='execute'&&v.expect!==i.expected_hash)fail('preview_changed','Use the original approval for the same operation.');
 const lockFile=join(o.state,'command.sqlite');closeSync(fileDescriptor(lockFile,1024*1024));const lock=new DatabaseSync(lockFile);
 let runtime:Awaited<ReturnType<typeof openTransferD1>>|undefined;
 try{
  lock.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
  if(lock.prepare("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL").all().map(r=>r['sql']).join()!=='CREATE TABLE command_lock(id INTEGER PRIMARY KEY) STRICT')fail('invalid_transfer','Unsupported command lock.');
  const directory=join(o.state,'bridge'),hasBridge=existsSync(join(directory,'operation.sqlite')),selected=returnSelection(directory);
  if(selected){paths(o,selected);if(v.output&&v.output!==selected)fail('authority_conflict','Return destination was already selected.');}
  if(command==='return'&&!selected)fresh(v.output!);
  if(!hasBridge&&command==='execute'&&hash(readLocalProject(o.db,o.projectId))!==i.snapshot_hash)fail('preview_changed','Source changed; no source was fenced.');
  if(!hasBridge&&command==='status')return {phase:'initializing',source:localAuthority(o.db,o.projectId),target:{status:'not_confirmed'},remote:false,claims_verified:false,next_action:'Retry execute with the original --expect. Preparation has not started.'};
  if(!hasBridge&&command!=='execute')fail('not_found','Preparation has not started. Retry execute with the original --expect; no replacement target was created.');
  runtime=await openTransferD1(o.d1,i.id,i.schema_hash,command==='execute'&&!hasBridge);
  const bridge=new SqliteD1ProjectTransfer(o.db,runtime.db,o.projectId,directory);
  if(command==='return')await bridge.returnToSqlite(v.output!);
  else if(command==='execute'||command==='resume'){
   if(selected)await bridge.returnToSqlite(selected);
   else{const phase=hasBridge?(await bridge.status()).phase:'preparing';if(phase==='preparing')await bridge.prepare(i.snapshot_hash);if(phase==='preparing'||phase==='prepared')await bridge.activate();}
  }
  return await inspect(bridge,runtime.db,o);
 }finally{if(runtime)await runtime.close();if(lock.isTransaction)lock.exec('ROLLBACK');lock.close();}
}
