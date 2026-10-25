import { createHash } from 'node:crypto';
import { rowSchemas,tables,type Table } from '../../../core/transfer/format.js';
import { eventRowSchemas,eventTables,type EventTable } from '../../../core/transfer/events.js';
import { storageOriginSchema } from '../../../core/transfer/origins.js';
import { MemoryError,type JsonObject } from '../../../core/memory/model.js';
import { validateBundle,transferSchemas,transferTables,type D1ProjectBundle,type TransferRows } from '../d1/transfer-format.js';
import { validateTransferOrigins } from '../d1/transfer-origins.js';
import { canonical,hashText } from '../d1/query.js';

export type LocalProject={project_id:string;tables:Record<Table,JsonObject[]>;events:Record<EventTable,JsonObject[]>};
const parse=(value:unknown)=>JSON.parse(String(value)) as JsonObject;
const key=(r:JsonObject)=>String(r['id']??r['execution_id']??r['record_id']??r['run_id']??canonical(r));
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const stableId=(s:string)=>{const h=hash(s);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export const emptyLocal=(project_id:string):LocalProject=>({project_id,tables:Object.fromEntries(tables.map(t=>[t,[] as JsonObject[]])) as LocalProject['tables'],events:Object.fromEntries(eventTables.map(t=>[t,[] as JsonObject[]])) as LocalProject['events']});
function archive(project:string,origin:'sqlite'|'d1',table:string,row:JsonObject):JsonObject {
 if(Buffer.byteLength(JSON.stringify(row))>60*1024)throw new MemoryError('resource_limit','Archived row exceeds portability capacity; no truncation.');
 return storageOriginSchema.parse({project_id:project,origin,table_name:table,row_key:hash(canonical(row)),row_json:JSON.stringify(row)});
}
function origins(rows:JsonObject[],origin:string,table:string){return rows.filter(r=>r['origin']===origin&&r['table_name']===table).map(r=>parse(r['row_json']));}
function restore(originals:JsonObject[],current:JsonObject):JsonObject {
 const normalize=(r:JsonObject)=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,k.endsWith('_json')&&typeof v==='string'?JSON.parse(v):v]));
 const old=originals.find(r=>key(r)===key(current));return old&&canonical(normalize(old))===canonical(normalize(current))?old:current;
}
/** Whitelisted data only; archive paths, scripts and commands are never opened or executed. */
export async function localToD1(local:LocalProject,storeId:string):Promise<D1ProjectBundle> {
 await validateTransferOrigins(local.tables.storage_origins,local.project_id,String(local.tables.projects[0]?.['project_key']),transferSchemas);
 const t=Object.fromEntries(transferTables.map(t=>[t,[] as JsonObject[]])) as TransferRows,origin=local.tables.storage_origins;
 const shared=['projects','runs','run_actors','components','features','run_components','run_features','run_details','records','record_reports','decision_events','plan_versions','plan_item_updates','plan_update_executions','task_skill_usage','feature_aliases'] as const;
 for(const name of shared)t[name]=local.tables[name].map(r=>({...r}));
 t.feature_code_paths=local.tables.feature_code_paths.map(r=>({...r,normalized_path:String(r['path']).toLowerCase()}));
 t.receipts=local.tables.receipts.filter(r=>r['scope']===local.project_id).map(r=>({...r,commit_token:origins(origin,'d1','receipts').find(x=>x['idempotency_key']===r['idempotency_key']&&x['payload_hash']===r['payload_hash'])?.['commit_token']??`sqlite-import:${hash(canonical(r)).slice(0,40)}`}));
 const extra=(table:Table,id:unknown)=>local.tables[table].find(r=>r['execution_id']===id);
 t.executions=local.tables.executions.map(r=>{
  const source=extra('execution_sources',r['id']),work=extra('execution_worktrees',r['id']);
  const point=(side:'before'|'after')=>{if(!source?.[`${side}_json`])return null;const p=parse(source[`${side}_json`]);if(work?.[`${side}_json`])p['worktree']=parse(work[`${side}_json`]);return JSON.stringify(p);};
  return {...r,test_details_json:extra('execution_test_details',r['id'])?.['details_json']??JSON.stringify({status:'not_collected',reason:'legacy'}),source_before_json:point('before'),source_after_json:point('after')};
 });
 const priorVersions=origins(origin,'d1','skill_versions');let versionSeq=Math.max(0,...priorVersions.map(r=>Number(r['seq'])));
 t.skill_versions=local.tables.skill_versions.map(r=>({...r,seq:priorVersions.find(v=>v['skill_key']===r['skill_key']&&v['version']===r['version'])?.['seq']??++versionSeq}));
 const oldAssignments=origins(origin,'d1','skill_assignments');t.skill_assignments=oldAssignments;
 const assignment=(installation:JsonObject,version:unknown,at:unknown):JsonObject=>{
  if(typeof version!=='string'||typeof at!=='string')throw new MemoryError('invalid_transfer','Invalid assignment version/time.');
  let a=t.skill_assignments.find(r=>r['installation_id']===installation['id']&&r['version']===version);
  if(!a){a={seq:Math.max(0,...t.skill_assignments.map(r=>Number(r['seq'])))+1,id:stableId(canonical([local.project_id,installation['id'],version])),project_id:local.project_id,installation_id:installation['id']!,skill_key:installation['skill_key']!,version:version!,assigned_at:at!};t.skill_assignments.push(a);}return a;
 };
 t.skill_installations=local.tables.skill_installations.map(i=>{
  const {version,project_root,assigned_at,...r}=i;
  return {...r,root_hash:hash(String(project_root))};
 });
 const previousObservations=origins(origin,'d1','skill_observations');let observationSeq=Math.max(0,...previousObservations.map(r=>Number(r['seq'])));
 t.skill_observations=local.tables.skill_observations.map(o=>{
  const install=local.tables.skill_installations.find(r=>r['id']===o['installation_id']);if(!install)throw new MemoryError('invalid_transfer','Skill installation missing.');
  const {version,installation_id,...rest}=o;const old=origins(origin,'d1','skill_observations').find(r=>r['id']===o['id']);
  const a=old?t.skill_assignments.find(r=>r['id']===old['assignment_id']):assignment(install,version,o['observed_at']);if(!a)throw new MemoryError('invalid_transfer','Assignment missing.');
  return {...rest,seq:old?.['seq']??++observationSeq,assignment_id:a['id']!};
 });
 // Current assignments must sort after observations of older versions.
 for(const i of local.tables.skill_installations){const latest=t.skill_assignments.filter(a=>a['installation_id']===i['id']).sort((a,b)=>Number(b['seq'])-Number(a['seq']))[0];
  if(latest?.['version']!==i['version']||latest?.['assigned_at']!==i['assigned_at'])t.skill_assignments.push({seq:Math.max(0,...t.skill_assignments.map(a=>Number(a['seq'])))+1,id:stableId(canonical([local.project_id,i['id'],i['version'],'current',i['assigned_at'],Math.max(0,...t.skill_assignments.map(a=>Number(a['seq'])))+1])),project_id:local.project_id,installation_id:i['id']!,skill_key:i['skill_key']!,version:i['version']!,assigned_at:i['assigned_at']!});
 }
 t.task_event_links=local.events.task_links.map(r=>{const {project_key,...v}=r;return v;});
 t.event_task_snapshots=local.events.event_task_links.map(r=>({...r,project_id:local.project_id}));
 t.lifecycle_events=local.events.events.map(e=>{
  const prior=origins(origin,'d1','lifecycle_events').find(r=>r['id']===e['id']);
  return prior??{...e,project_id:local.project_id,observed_at:e['received_at']!,payload_hash:hash(canonical(e)),association_status:local.events.event_task_links.some(x=>x['event_id']===e['id'])?'linked':'not_linked'};
 });
 // Keep source rows and opposite-storage extras in the same project bundle; never recursively archive the archive.
 t.storage_origins=origin.filter(r=>r['origin']==='d1');
 for(const table of tables.filter(t=>t!=='storage_origins'))for(const row of local.tables[table])t.storage_origins.push(archive(local.project_id,'sqlite',table,row));
 for(const table of eventTables)for(const row of local.events[table])t.storage_origins.push(archive(local.project_id,'sqlite',`event_${table}`,row));
 // SQLite source snapshots retain their original non-atomic meaning and read time.
 const body={format:'skilly-d1-project' as const,version:1 as const,schema:9 as const,source_store_id:storeId,project_id:local.project_id,project_revision:Number(t.projects[0]?.['revision']),tables:t};
 return validateBundle({...body,sha256:await hashText(canonical(body))});
}

export async function d1ToLocal(raw:unknown,roots:Readonly<Record<string,string>>={}):Promise<LocalProject> {
 const b=await validateBundle(raw),t=b.tables,out=emptyLocal(b.project_id),archiveRows=t.storage_origins??[];
 await validateTransferOrigins(archiveRows,b.project_id,String(t.projects[0]?.['project_key']),transferSchemas);
 const old=(table:string)=>origins(archiveRows,'sqlite',table);
 const shared=['projects','runs','run_actors','components','features','run_components','run_features','run_details','records','record_reports','decision_events','plan_versions','plan_item_updates','plan_update_executions','task_skill_usage','feature_aliases'] as const;
 for(const name of shared)out.tables[name]=t[name].map(r=>restore(old(name),{...r}));
 out.tables.feature_code_paths=t.feature_code_paths.map(r=>{const {normalized_path,...v}=r;return restore(old('feature_code_paths'),v);});
 out.tables.receipts=[...old('receipts').filter(r=>r['scope']==='registration'),...t.receipts.map(r=>{const {commit_token,...v}=r;return v;})];
 out.tables.run_acknowledgements=old('run_acknowledgements');out.tables.requests=old('requests');
 out.tables.executions=t.executions.map(r=>{
  const {test_details_json,source_before_json,source_after_json,...v}=r,id=r['id']!;
  const details={execution_id:id,project_id:b.project_id,details_json:test_details_json!};
  const previous=old('execution_test_details').find(x=>x['execution_id']===id);
  if(previous||canonical(parse(test_details_json))!==canonical({status:'not_collected',reason:'legacy'}))out.tables.execution_test_details.push(restore(old('execution_test_details'),details));
  if(source_before_json){const split=(s:unknown)=>{if(!s)return {meta:null,work:null};const {worktree,...meta}=parse(s);return {meta:JSON.stringify(meta),work:worktree?JSON.stringify(worktree):null};};
   const before=split(source_before_json),after=split(source_after_json);
   out.tables.execution_sources.push(restore(old('execution_sources'),{execution_id:id,project_id:b.project_id,before_json:before.meta,after_json:after.meta}));
   if(before.work||after.work)out.tables.execution_worktrees.push(restore(old('execution_worktrees'),{execution_id:id,project_id:b.project_id,before_json:before.work,after_json:after.work}));
  }return restore(old('executions'),v);
 });
 out.tables.skill_versions=t.skill_versions.map(r=>{const {seq,...v}=r;return restore(old('skill_versions'),v);});
 out.tables.skill_installations=t.skill_installations.map(i=>{
  const assigned=t.skill_assignments.filter(a=>a['installation_id']===i['id']).sort((a,b)=>Number(b['seq'])-Number(a['seq']))[0];
  if(!assigned)throw new MemoryError('invalid_transfer','Installation assignment missing.');
  const prior=old('skill_installations').find(r=>r['id']===i['id']),root=prior?.['project_root']??roots[String(i['root_hash'])];
  if(typeof root!=='string'||hash(root)!==i['root_hash'])throw new MemoryError('root_mapping_required','Supply an explicit matching host root for this D1 installation; no path was guessed.');
  const {root_hash,...v}=i;return {...v,project_root:root,version:assigned['version']!,assigned_at:assigned['assigned_at']!};
 });
 out.tables.skill_observations=t.skill_observations.map(o=>{
  const a=t.skill_assignments.find(r=>r['id']===o['assignment_id']);if(!a)throw new MemoryError('invalid_transfer','Skill observation assignment missing.');
  const {seq,assignment_id,...v}=o;return restore(old('skill_observations'),{...v,installation_id:a['installation_id']!,version:a['version']!});
 });
 out.events.events=t.lifecycle_events.map(e=>{
  const original=old('event_events').find(r=>r['id']===e['id']);if(original)return original;
  const {project_id,observed_at,payload_hash,association_status,...v}=e;return eventRowSchemas.events.parse(v);
 });
 out.events.task_links=t.task_event_links.map(l=>({...l,project_key:t.projects[0]!['project_key']!}));
 out.events.event_task_links=t.event_task_snapshots.map(x=>{const {project_id,...v}=x;return v;});
 out.events.event_link_failures=old('event_event_link_failures');
 out.events.event_imports=old('event_event_imports');
 for(const [kind,data] of [['event',out.events.events],['link',out.events.task_links]] as const)for(const r of data)if(!out.events.event_imports.some(o=>o['kind']===kind&&o['id']===r['id']))out.events.event_imports.push({kind,id:r['id']!,source_seq:r['seq']!,source_from_seq:kind==='link'?r['from_seq']!:null,source_bundle_hash:b.sha256});
 out.tables.storage_origins=archiveRows.filter(r=>r['origin']==='sqlite');
 for(const table of transferTables)for(const row of t[table])out.tables.storage_origins.push(archive(b.project_id,'d1',table,row));
 // Validate table names and columns before any INSERT is assembled by the host endpoint.
 for(const table of tables)for(const r of out.tables[table]){const schema=table==='records'||table==='plan_item_updates'?rowSchemas[table].extend({seq:rowSchemas.projects.shape.revision.positive()}):rowSchemas[table];schema.parse(r);}
 for(const table of eventTables)for(const r of out.events[table])eventRowSchemas[table].parse(r);
 return out;
}
