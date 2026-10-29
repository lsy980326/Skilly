import { DatabaseSync,type SQLInputValue } from 'node:sqlite';
import { existsSync,lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tables,rowSchemas } from '../../../core/transfer/format.js';
import { eventTables,eventRowSchemas } from '../../../core/transfer/events.js';
import { putAuthority,readAuthority,type AuthorityRow,type AuthorityKind } from '../sqlite/project-authority.js';
import { lifecycleSchemaSql } from '../sqlite/lifecycle.js';
import { taskLinkSchema } from '../sqlite/task-event-storage.js';
import { eventImportSchemaSql } from '../sqlite/event-imports.js';
import { initialize,readDatabase,validateDatabase } from '../transfer/database.js';
import { validateEventPair,validateEventStore,readEvents } from '../transfer/events.js';
import { validateRecoveryPair } from '../transfer/recovery.js';
import { openSnapshots } from '../transfer/snapshot.js';
import { safePath,newDirectory,writeNew,fail } from '../transfer/files.js';
import { emptyLocal,type LocalProject } from './format.js';
import type { JsonObject } from '../../../core/memory/model.js';
import { requireLegacyEventTransfer } from '../sqlite/event-retention.js';
import { openLifecycleStore } from '../sqlite/lifecycle.js';

const parts:[AuthorityKind,string][]=[['main',''],['recovery','.recovery.sqlite'],['events','.events.sqlite']];
export function localIdentity(path:string){safePath(path);const s=lstatSync(path);if(!s.isFile())fail('invalid_file','Regular SQLite file required.');return {dev:s.dev,ino:s.ino};}
export function localAuthority(path:string,project:string){const db=readDatabase(path);try{return readAuthority(db,project);}finally{db.close();}}
/** Close main first; open main last. Existing open connections are fenced by the DB triggers. */
export function setLocalAuthority(path:string,a:AuthorityRow){
 for(const [kind,suffix] of (a.state==='blocked'?parts:[...parts.slice(1),parts[0]!])){
  const file=path+suffix;safePath(file);
  if(!existsSync(file)){if(kind==='main')fail('not_found','Source main DB absent.');writeNew(file,'');const db=new DatabaseSync(file);try{if(kind==='recovery')initialize(db,true);else db.exec(lifecycleSchemaSql+taskLinkSchema);}finally{db.close();}}
  const db=new DatabaseSync(file);
  try{db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
   try{if(kind==='main'&&a.state==='blocked'&&db.prepare('SELECT 1 FROM executions WHERE project_id=? AND ended_at IS NULL LIMIT 1').get(a.project_id))fail('execution_in_progress','Unfinished execution; nothing was closed or rerun.');
    if(kind==='main'&&existsSync(path+'.events.sqlite')){const events=openLifecycleStore(path+'.events.sqlite');try{requireLegacyEventTransfer(events);}finally{events.close();}}
    if(kind==='events')db.exec(taskLinkSchema);putAuthority(db,kind,a);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  }finally{db.close();}
 }
}
export function assertLocalAuthority(path:string,a:AuthorityRow){for(const [kind,suffix] of parts){const db=kind==='events'?readEvents(path+suffix):readDatabase(path+suffix,kind==='recovery');try{const r=db.prepare('SELECT * FROM project_authority WHERE project_id=?').get(a.project_id);if(!r||Object.keys(a).filter(k=>k!=='updated_at').some(k=>r[k]!==a[k as keyof AuthorityRow]))fail('authority_conflict','A SQLite copy has a different owner/generation/state.');}finally{db.close();}}}

export function readLocalProject(path:string,project_id:string):LocalProject {
 const s=openSnapshots(path,true),out=emptyLocal(project_id);let count=0,bytes=0;
 const collect=(rows:Iterable<unknown>)=>{const kept:JsonObject[]=[];for(const value of rows){const r=value as JsonObject;bytes+=Buffer.byteLength(JSON.stringify(r));if(++count>2000||bytes>1024*1024)fail('resource_limit','Bounded bridge snapshot exceeded; no partial data returned.');kept.push(JSON.parse(JSON.stringify(r)) as JsonObject);}return kept;};
 try {
  requireLegacyEventTransfer(s.events);
  const p=s.main.prepare('SELECT * FROM projects WHERE id=?').get(project_id);if(!p)fail('not_found','Project not found.');
  if(![15,16].includes(Number(s.main.prepare('PRAGMA user_version').get()?.['user_version'])))fail('unsupported_database','Bridge source must be explicit SQLite v15/v16; original is not migrated.');
  for(const t of tables){const db=t==='requests'?s.recovery:s.main;if(!db||!db.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(t))continue;
   const where=t==='projects'?'id=?':t==='run_actors'?'run_id IN (SELECT id FROM runs WHERE project_id=?1)':t==='receipts'?"scope=?1 OR (scope='registration' AND json_extract(result_json,'$.project.id')=?1)":'project_id=?';
   const fields=Object.keys(rowSchemas[t].shape).map(c=>'"'+c+'"').join(',')+(['records','plan_item_updates'].includes(t)?',seq':'');
   out.tables[t]=collect(db.prepare(`SELECT ${fields} FROM ${t} WHERE ${where} ORDER BY ${['records','plan_item_updates','skill_observations'].includes(t)?'seq':'rowid'} LIMIT 2001`).iterate(project_id));
  }
  if(s.events)for(const t of eventTables){if(!s.events.prepare('SELECT 1 FROM sqlite_schema WHERE name=?').get(t))continue;
   const where=t==='events'?'project_key=?2':t==='task_links'?'project_id=?1':t==='event_imports'?"(kind='event' AND id IN(SELECT id FROM events WHERE project_key=?2)) OR (kind='link' AND id IN(SELECT id FROM task_links WHERE project_id=?1))":'link_id IN(SELECT id FROM task_links WHERE project_id=?1)';
   // Bind numbered parameters explicitly even for tables whose scope uses only one.
   out.events[t]=collect(s.events.prepare(`SELECT * FROM ${t} WHERE (?1 IS NOT NULL AND ?2 IS NOT NULL) AND (${where}) ORDER BY ${['events','task_links'].includes(t)?'seq':'rowid'} LIMIT 2001`).iterate(project_id,p['project_key']!));
  }
  if(Object.values(out.tables).concat(Object.values(out.events)).some(r=>r.length>2000))fail('resource_limit','Bridge row limit exceeded; no truncated project returned.');
  return out;
 }finally{s.close();}
}

/** All three new files stay quarantined until the coordinator explicitly opens them. */
export function writeLocalProject(data:LocalProject,directory:string,a:AuthorityRow){
 newDirectory(directory);const path=join(directory,'memory.sqlite');const dbs:DatabaseSync[]=[];
 try{
  for(const [kind,suffix] of parts){writeNew(path+suffix,'');const db=new DatabaseSync(path+suffix);dbs.push(db);if(kind==='main')initialize(db,false,16);else if(kind==='recovery')initialize(db,true);else db.exec(lifecycleSchemaSql+taskLinkSchema+eventImportSchemaSql+'PRAGMA user_version=2;');db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;');}
  const [main,recovery,events]=dbs as [DatabaseSync,DatabaseSync,DatabaseSync];
  for(const t of tables)for(const r of data.tables[t]){const cols=Object.keys(r);const allowed=Object.keys(rowSchemas[t].shape).concat(['records','plan_item_updates'].includes(t)?['seq']:[]);if(cols.some(c=>!allowed.includes(c)))fail('invalid_transfer','Unexpected column.');
   (t==='requests'?recovery:main).prepare(`INSERT INTO ${t}(${cols.map(c=>'"'+c+'"').join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>r[c] as SQLInputValue));}
  for(const t of eventTables)for(const r of data.events[t]){eventRowSchemas[t].parse(r);const cols=Object.keys(r);events.prepare(`INSERT INTO ${t}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...cols.map(c=>r[c] as SQLInputValue));}
  validateRecoveryPair(main,recovery);validateEventStore(events);validateEventPair(main,events);validateDatabase(main);validateDatabase(recovery,true);
  for(let i=0;i<parts.length;i++)putAuthority(dbs[i]!,parts[i]![0],a);
  for(const db of dbs)db.exec('COMMIT');
  writeNew(join(directory,'portable-import.json'),JSON.stringify({project_id:data.project_id,transfer_id:a.transfer_id,generation:a.generation,status:'imported_fenced',claims_verified:false}));
  return path;
 }catch(e){for(const db of dbs)if(db.isTransaction)db.exec('ROLLBACK');throw e;}finally{for(const db of dbs)db.close();}
}
