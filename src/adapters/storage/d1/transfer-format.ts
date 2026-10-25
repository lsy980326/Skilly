import { validateTransferOrigins } from "./transfer-origins.js";
import { z } from "zod";
import { storageOriginSchema } from "../../../core/transfer/origins.js";
import { eventRowSchemas, savedPointSchema as sqliteSavedPoint } from "../../../core/transfer/events.js";
import { rowSchemas as local } from "../../../core/transfer/format.js";
import { executionRowSchema } from "../../../core/execution/model.js";
import { sourceObservationSchema } from "../../../core/execution/currentness.js";
import { testDetailsSchema } from "../../../core/execution/test-details.js";
import { reportSchema } from "../../../core/work/schema.js";
import { normalizeAlias,normalizeCodePath } from "../../../core/work/discovery.js";
import { decisionSchema,validateDecision,type DecisionEvent } from "../../../core/decisions/model.js";
import { planItemsSchema,criterionResultsSchema,completionAllowed } from "../../../core/plans/model.js";
import { MemoryError,type JsonObject } from "../../../core/memory/model.js";
import { decodeVersion,validateFiles } from "./skill-model.js";
import { hashText,canonical,json,bytes } from "./query.js";

const id=z.uuid(),text=z.string(),nullable=text.nullable(),seq=z.int().positive(),hash=text.regex(/^[a-f0-9]{64}$/);
const encoded=<T>(schema:z.ZodType<T>)=>text.refine(v=>{try{return schema.safeParse(JSON.parse(v)).success;}catch{return false;}},"Invalid stored JSON.");
const nativeSavedPoint=z.strictObject({stage:z.enum(['record','start','unknown']),record_id:id.nullable(),seq:seq.optional(),recorded_at:z.iso.datetime().optional(),
 record_visible:z.boolean(),receipt_confirmed:z.boolean(),read_at:z.iso.datetime(),meaning:z.literal('Server receive transaction snapshot; not the physical interruption time.')}).superRefine((v,c)=>{
 if(v.stage==='record'?(!v.record_id||!v.seq||!v.recorded_at||!v.record_visible):(v.record_id!==null||v.seq!==undefined||v.recorded_at!==undefined||v.record_visible||v.receipt_confirmed!==(v.stage==='start')))
  c.addIssue({code:'custom',message:'Saved checkpoint stage differs from its fields.'});
});
const savedPoint=z.union([nativeSavedPoint,sqliteSavedPoint.extend({meaning:z.literal("Record visible during hook processing; not an atomic cutoff across databases.")})]).superRefine((v,c)=>{
 if(v.stage==='record'?(!v.record_id||!v.seq||!v.recorded_at||!v.record_visible):(v.record_id!==null||v.seq!==undefined||v.recorded_at!==undefined||v.record_visible||v.receipt_confirmed!==(v.stage==='start')))
 c.addIssue({code:'custom',message:'Checkpoint stage differs from its fields.'});
});
export const transferSchemas={
 projects:local.projects,runs:local.runs,run_actors:local.run_actors,components:local.components,features:local.features,
 run_components:local.run_components,run_features:local.run_features,run_details:local.run_details,
 records:local.records.extend({seq}),record_reports:local.record_reports.extend({report_json:encoded(reportSchema)}),
 decision_events:local.decision_events.extend({metadata_json:encoded(decisionSchema)}),
 plan_versions:local.plan_versions,plan_item_updates:local.plan_item_updates.extend({seq}),
 executions:executionRowSchema.safeExtend({test_details_json:encoded(testDetailsSchema),source_before_json:encoded(sourceObservationSchema).nullable(),source_after_json:encoded(sourceObservationSchema).nullable()}),
 plan_update_executions:local.plan_update_executions,
 lifecycle_events:z.strictObject({seq,id:eventRowSchemas.events.shape.id,project_id:id,project_key:text,repository:text,environment:text,root_hash:hash,session_hash:hash,turn_hash:hash.nullable(),
  event:z.enum(['SessionStart','PostToolUse','PreCompact','Stop','Interrupt','SessionEnd']),source:nullable,tool_group:nullable,observed_at:z.iso.datetime(),received_at:z.iso.datetime(),payload_hash:hash,association_status:z.enum(['linked','not_linked','run_closed'])}),
 task_event_links:z.strictObject({seq,id,project_id:id,run_id:id,repository:text,environment:text,root_hash:hash,session_hash:hash,anchor_id:eventRowSchemas.events.shape.id,from_seq:seq,linked_at:z.iso.datetime()}),
 event_task_snapshots:z.strictObject({project_id:id,event_id:eventRowSchemas.events.shape.id,link_id:id,saved_json:encoded(savedPoint)}),
 skill_versions:local.skill_versions.extend({seq}),
 skill_installations:z.strictObject({id,project_id:id,skill_key:text,repository:text,environment:text,root_hash:hash,tool:z.enum(['codex','cursor']),folder:text}),
 skill_assignments:z.strictObject({seq,id,project_id:id,installation_id:id,skill_key:text,version:text,assigned_at:z.iso.datetime()}),
 skill_observations:z.strictObject({seq,id,project_id:id,assignment_id:id,expected_hash:hash,observed_at:z.iso.datetime(),state:z.enum(['matches','modified','missing','unavailable']),files_json:text}),
 task_skill_usage:local.task_skill_usage,feature_aliases:local.feature_aliases,feature_code_paths:local.feature_code_paths.extend({normalized_path:text}),
 receipts:local.receipts.extend({commit_token:text.min(1).max(100)})
};
export type TransferTable=keyof typeof transferSchemas;
export const transferTables=Object.keys(transferSchemas) as TransferTable[];
export type TransferRows=Record<TransferTable,JsonObject[]> & {storage_origins?:JsonObject[]};
export const D1_TRANSFER_LIMITS=Object.freeze({bytes:1024*1024,rows:2000,table_bytes:256*1024,row_bytes:64*1024});
const header=z.strictObject({format:z.literal('skilly-d1-project'),version:z.literal(1),schema:z.union([z.literal(8),z.literal(9)]),source_store_id:text.regex(/^[a-f0-9]{32}$/),project_id:id,
 project_revision:z.int().nonnegative(),tables:z.record(text,z.array(z.record(text,z.json()))),sha256:hash});
export type D1ProjectBundle=Omit<z.infer<typeof header>,'tables'> & {tables:TransferRows};
function fail(message:string):never {throw new MemoryError('invalid_transfer',message);}
const same=(a:JsonObject,b:JsonObject,fields=['repository','environment'])=>fields.every(k=>a[k]===b[k]);
export async function validateBundle(raw:unknown):Promise<D1ProjectBundle> {
 if(bytes(raw)>D1_TRANSFER_LIMITS.bytes)throw new MemoryError('resource_limit','D1 project bundle exceeds its byte limit; nothing imported.');
 const parsed=header.safeParse(raw);if(!parsed.success)fail('Invalid D1 project bundle header.');const b=parsed.data;
 if(JSON.stringify(Object.keys(b.tables).sort())!==JSON.stringify([...transferTables,...(b.schema===9?["storage_origins"]:[])].sort()))fail('Exact D1 business table catalog required.');
 const {sha256,...body}=b;if(await hashText(canonical(body))!==sha256)fail('Bundle content hash differs.');
 let count=0;for(const table of transferTables){const data=b.tables[table]!;count+=data.length;
  if(bytes(data)>D1_TRANSFER_LIMITS.table_bytes||data.some(r=>bytes(r)>D1_TRANSFER_LIMITS.row_bytes)||count>D1_TRANSFER_LIMITS.rows)throw new MemoryError('resource_limit','Bounded D1 bundle capacity exceeded.');
  for(const row of data){if(!transferSchemas[table].safeParse(row).success)fail('Invalid row in '+table);
   if(table==='projects'?row['id']!==b.project_id:table==='receipts'?row['scope']!==b.project_id:table!=='run_actors'&&row['project_id']!==b.project_id)fail('Foreign project row.');}}
 const origins=b.tables["storage_origins"]??[];count+=origins.length;
 if(count>D1_TRANSFER_LIMITS.rows||bytes(origins)>D1_TRANSFER_LIMITS.table_bytes)throw new MemoryError("resource_limit","Origin archive limit exceeded.");
 for(const row of origins){storageOriginSchema.parse(row);if(row['project_id']!==b.project_id||bytes(row)>D1_TRANSFER_LIMITS.row_bytes)fail('Foreign or oversized archive row.');}
 const t=b.tables as TransferRows;if(t.projects.length!==1||t.projects[0]!['revision']!==b.project_revision)fail('Missing project/revision.');
 await validateTransferOrigins(origins as JsonObject[],b.project_id,String(t.projects[0]!['project_key']),transferSchemas);
 const find=(table:TransferTable,id:unknown,field='id')=>t[table].find(r=>r[field]===id)??fail('Missing '+table+' reference.');
 const task=(row:JsonObject)=>{const r=find('runs',row['run_id']);if(!same(r,row))fail('Task scope differs.');return r;};
 const record=(row:JsonObject)=>{const r=find('records',row['record_id']);if(r['run_id']!==row['run_id']||!same(r,row))fail('Record/task scope differs.');return r;};
 for(const a of t.run_actors)find('runs',a['run_id']);
 for(const r of t.records){task(r);for(const [field,reverse] of [['supersedes','superseded_by'],['superseded_by','supersedes']])if(r[field!]){
   const other=find('records',r[field!]);if(other[reverse!]!==r['id']||!same(r,other,['topic','kind','repository','environment'])||((field==='supersedes')?Number(other['seq'])>=Number(r['seq']):Number(other['seq'])<=Number(r['seq'])))fail('Invalid correction chain.');}}
 for(const r of t.executions){const run=find('runs',r['run_id']);if(r['record_id']&&find('records',r['record_id'])['run_id']!==run['id'])fail('Execution record belongs to another task.');if(r['ended_at']===null)fail('Unfinished execution observations cannot be transferred.');
  const before=r['source_before_json']?JSON.parse(String(r['source_before_json'])):null;
  for(const field of ['source_before_json','source_after_json'])if(r[field]){const s=JSON.parse(String(r[field]));if(s.project_key!==t.projects[0]!['project_key']||!same(run,s)||!before||s.root_hash!==before.root_hash)fail('Execution source scope differs.');}}
 const groups=new Map<string,DecisionEvent[]>();for(const d of t.decision_events){const r=find('records',d['record_id']),v=decisionSchema.parse(JSON.parse(String(d['metadata_json'])));
  if(r['kind']!=='decision'||r['supersedes']||r['superseded_by']||v.subject!==d['subject_key']||(v.component_key??'')!==d['component_key']||(v.feature_key??'')!==d['feature_key'])fail('Decision scope differs.');
  for(const [field,table,link] of [['component_key','run_components','component_key'],['feature_key','run_features','feature_key']] as const)if(d[field]&&!t[table].some(x=>x['run_id']===r['run_id']&&x[link]===d[field]))fail('Decision classification was not declared on its task.');
  const key=canonical([r['repository'],r['environment'],d['subject_key'],d['component_key'],d['feature_key']]);const g=groups.get(key)??[];
  g.push({record:{id:String(r['id']),run_id:String(r['run_id']),seq:Number(r['seq']),body:String(r['body']),recorded_at:String(r['recorded_at']),report_origin:r['report_origin'] as 'contemporaneous'},decision:v});groups.set(key,g);}
 for(const group of groups.values()){group.sort((a,b)=>a.record.seq-b.record.seq);for(let n=0;n<group.length;n++)validateDecision(group[n]!.decision,group.slice(0,n),false,group[n]!.record.report_origin);}
 for(const p of t.plan_versions){task(p);if(await hashText(String(p['source_body']))!==p['source_hash'])fail('Plan source hash differs.');planItemsSchema.parse(JSON.parse(String(p['items_json'])));}
 for(const u of t.plan_item_updates){task(u);record(u);const p=t.plan_versions.find(p=>same(p,u,['plan_key','version','repository','environment']))??fail('Missing plan version.');
  const item=planItemsSchema.parse(JSON.parse(String(p['items_json']))).find(i=>i.key===u['item_key'])??fail('Missing plan item.');const results=criterionResultsSchema.parse(JSON.parse(String(u['criteria_json'])));
  if(results.some(c=>!item.criteria.some(i=>i.key===c.key))||new Set(results.map(c=>c.key)).size!==results.length)fail('Foreign plan criterion.');if(u['state']==='completed')completionAllowed(item,results);}
 for(const l of t.plan_update_executions){const u=find('plan_item_updates',l['update_id']),e=find('executions',l['execution_id']);if(e['run_id']!==u['run_id']||!same(find('runs',e['run_id']),u))fail('Foreign plan execution.');}
 for(const a of t.feature_aliases)if(normalizeAlias(String(a['alias']))!==a['normalized_alias'])fail('Alias normalization differs.');
 for(const p of t.feature_code_paths)if(normalizeCodePath(String(p['path']))!==p['path']||String(p['path']).toLowerCase()!==p['normalized_path'])fail('Path normalization differs.');
 for(const table of ['feature_aliases','feature_code_paths'] as const)for(const m of t[table]){const r=find('runs',m['source_run_id']);if(!same(r,m))fail('Discovery scope differs.');}
 for(const l of t.task_event_links){task(l);const e=find('lifecycle_events',l['anchor_id']);if(!same(l,e,['repository','environment','root_hash','session_hash'])||Number(l['from_seq'])<=Number(e['seq']))fail('Event anchor scope differs.');}
 for(const e of t.lifecycle_events)if(e['project_key']!==t.projects[0]!['project_key'])fail('Event project key differs.');
 for(const x of t.event_task_snapshots){const e=find('lifecycle_events',x['event_id']),l=find('task_event_links',x['link_id']);
  if(!same(e,l,['repository','environment','root_hash','session_hash'])||e['association_status']!=='linked'||Number(e['seq'])<Number(l['from_seq']))fail('Event snapshot scope differs.');
  const saved=savedPoint.parse(JSON.parse(String(x['saved_json'])));if(saved.meaning.startsWith('Server receive')&&saved.read_at!==e['received_at'])fail('Checkpoint receive time differs.');if(saved.record_id){const r=find('records',saved.record_id);if(r['run_id']!==l['run_id']||saved.seq!==r['seq']||saved.recorded_at!==r['recorded_at'])fail('Saved checkpoint differs.');
   if(saved.receipt_confirmed&&!t.receipts.some(q=>{const v=JSON.parse(String(q['result_json']));return v.record_id===r['id']||Array.isArray(v.record_ids)&&v.record_ids.includes(r['id']);}))fail('Checkpoint receipt was not saved.');
  }else if(saved.stage==='start'&&!t.receipts.some(q=>JSON.parse(String(q['result_json'])).run?.id===l['run_id']))fail('Task start receipt missing.');}
 for(const e of t.lifecycle_events)if((e['association_status']==='linked')!==t.event_task_snapshots.some(x=>x['event_id']===e['id']))fail('Linked event checkpoint is missing or unassociated.');
 const versions=new Map<string,Awaited<ReturnType<typeof decodeVersion>>>();for(const v of t.skill_versions)versions.set(canonical([v['skill_key'],v['version']]),await decodeVersion(v));
 for(const a of t.skill_assignments){const i=find('skill_installations',a['installation_id']);if(i['skill_key']!==a['skill_key']||!versions.has(canonical([a['skill_key'],a['version']])))fail('Assignment version differs.');}
 for(const o of t.skill_observations){const a=find('skill_assignments',o['assignment_id']),v=versions.get(canonical([a['skill_key'],a['version']]))!;
  if(o['expected_hash']!==v.content_hash||(await validateFiles(v,JSON.parse(String(o['files_json'])))).state!==o['state'])fail('Skill observation differs.');}
 for(const u of t.task_skill_usage){const r=find('records',u['record_id']),run=find('runs',u['run_id']),v=versions.get(canonical([u['skill_key'],u['version']]));if(r['run_id']!==run['id']||v?.content_hash!==u['content_hash'])fail('Skill use scope differs.');
  if(u['observation_id']){const o=find('skill_observations',u['observation_id']),a=find('skill_assignments',o['assignment_id']),i=find('skill_installations',a['installation_id']);if(!same(a,u,['skill_key','version'])||!same(i,run)||o['expected_hash']!==u['content_hash'])fail('Skill file observation differs.');}}
 return json(b) as D1ProjectBundle;
}
