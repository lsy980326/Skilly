import { DatabaseSync } from 'node:sqlite';
import { existsSync,readFileSync,closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { D1Binding } from '../d1/binding.js';
import { rows,canonical,hashText } from '../d1/query.js';
import { d1WriteAuthority } from '../d1/authority.js';
import { storeIdentity,importD1Project,exportD1Project,openImported,transferBatch,assertSql } from '../d1/transfer-store.js';
import { validateBundle } from '../d1/transfer-format.js';
import { localToD1,d1ToLocal } from './format.js';
import { localIdentity,localAuthority,readLocalProject,setLocalAuthority,assertLocalAuthority,writeLocalProject } from './sqlite.js';
import { newDirectory,writeNew,fileDescriptor,safePath,fail } from '../transfer/files.js';
import type { AuthorityRow } from '../sqlite/project-authority.js';

const planSchema=z.strictObject({id:z.uuid(),project_id:z.uuid(),project_key:z.string(),source:z.string(),dev:z.number(),ino:z.number(),target_id:z.string(),generation:z.int().positive()});
type Plan=z.infer<typeof planSchema>;
const controlSql='CREATE TABLE operation (plan TEXT NOT NULL,phase TEXT NOT NULL) STRICT;';
const phases=['preparing','prepared','active','returning','returned'];
/** Host-only local coordinator. Bindings and paths are supplied by the caller, never by stored data. */
export class SqliteD1ProjectTransfer {
 constructor(private readonly source:string,private readonly target:D1Binding,private readonly projectId:string,private readonly directory:string){safePath(source);safePath(directory);z.uuid().parse(projectId);}
 private row(p:Plan,role:'source'|'return',state:'blocked'|'writable'):AuthorityRow{return {project_id:p.project_id,project_key:p.project_key,transfer_id:p.id,generation:p.generation+(role==='return'?1:0),role,state,updated_at:new Date().toISOString()};}
 private async control(){
  const path=join(this.directory,'operation.sqlite');closeSync(fileDescriptor(path,1024*1024));const db=new DatabaseSync(path);
  try{db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; BEGIN IMMEDIATE;');
   const schema=db.prepare('SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL').all();if(schema.length!==1||schema[0]?.['sql']!==controlSql.slice(0,-1))fail('invalid_transfer','Unsupported bridge operation schema.');
   const all=db.prepare('SELECT * FROM operation LIMIT 2').all();if(all.length!==1)fail('invalid_transfer','Invalid bridge control.');const r=all[0]!,p=planSchema.parse(JSON.parse(String(r['plan']))),actual=localIdentity(this.source);
   if(p.source!==this.source||p.project_id!==this.projectId||p.dev!==actual.dev||p.ino!==actual.ino||p.target_id!==await storeIdentity(this.target)||!phases.includes(String(r['phase'])))fail('authority_conflict','Host bindings/source identity differ. Nothing activated.');
   return {db,p,phase:String(r['phase'])};
  }catch(e){db.close();throw e;}
 }
 private selection():string|undefined {const f=join(this.directory,'return.json');if(!existsSync(f))return;closeSync(fileDescriptor(f,4096));const p=z.strictObject({directory:z.string()}).parse(JSON.parse(readFileSync(f,'utf8'))).directory;safePath(p);return p;}
 async prepare(expectedSnapshotHash?:string){
  const checkedSnapshot=async()=>{const snapshot=readLocalProject(this.source,this.projectId);if(expectedSnapshotHash && await hashText(canonical(snapshot))!==expectedSnapshotHash)fail('preview_changed','Source changed since preview. Nothing new was imported; inspect status before recovery.');return snapshot;};
  if(!existsSync(this.directory)){
   const a=localAuthority(this.source,this.projectId);if(!a['write_allowed'])fail('authority_conflict','Source is already fenced.');
   if(!(await rows(this.target,"SELECT name FROM sqlite_master WHERE name='storage_origins'",[],1)).length)fail('unsupported_capability','Explicit D1 009 schema required.');
   if((await rows(this.target,'SELECT id FROM projects LIMIT 1',[],1)).length)fail('destination_exists','D1 target must be empty.');
   const snapshot=await checkedSnapshot(),identity=localIdentity(this.source),target_id=await storeIdentity(this.target);
   await localToD1(snapshot,randomUUID().replaceAll('-','')); // Pure bounded preflight; no source fence yet.
   const p:Plan={id:randomUUID(),project_id:this.projectId,project_key:String(snapshot.tables.projects[0]!['project_key']),source:this.source,...identity,target_id,generation:Number(a['generation']??0)+1};
   newDirectory(this.directory);writeNew(join(this.directory,'operation.sqlite'),'');const init=new DatabaseSync(join(this.directory,'operation.sqlite'));try{init.exec(controlSql);init.prepare("INSERT INTO operation VALUES(?,'preparing')").run(JSON.stringify(p));}finally{init.close();}
  }
  const c=await this.control();try{
   if(c.phase==='prepared')return await this.result(c.p,c.phase);
   if(c.phase!=='preparing')fail('transfer_phase','Read status; prepare cannot be repeated after activation.');
   setLocalAuthority(this.source,this.row(c.p,'source','blocked'));assertLocalAuthority(this.source,this.row(c.p,'source','blocked'));
   const bundlePath=join(this.directory,'outbound.json');let bundle:unknown;
   if(existsSync(bundlePath)){closeSync(fileDescriptor(bundlePath,1024*1024));bundle=JSON.parse(readFileSync(bundlePath,'utf8'));}
   else{bundle=await localToD1(await checkedSnapshot(),c.p.id.replaceAll('-',''));writeNew(bundlePath,JSON.stringify(bundle));}
   const checked=await validateBundle(bundle);if(checked.project_id!==c.p.project_id||checked.source_store_id!==c.p.id.replaceAll('-','')||checked.tables.projects[0]?.['project_key']!==c.p.project_key)fail('scope_mismatch','Retained bundle differs from this bridge operation.');
   await importD1Project(this.target,checked,{transfer_id:c.p.id,generation:c.p.generation,role:'target'});
   c.db.prepare("UPDATE operation SET phase='prepared'").run();c.db.exec('COMMIT');return this.result(c.p,'prepared');
  }finally{if(c.db.isTransaction)c.db.exec('ROLLBACK');c.db.close();}
 }
 async activate(){const c=await this.control();try{
  if(this.selection())fail('transfer_phase','A return was selected; the D1 target must never reopen.');
  if(!['prepared','active'].includes(c.phase))fail('transfer_phase','Prepare first.');
  assertLocalAuthority(this.source,this.row(c.p,'source','blocked'));
  const intent=join(this.directory,'activation.json');if(!existsSync(intent))writeNew(intent,JSON.stringify({transfer_id:c.p.id}));
  await openImported(this.target,c.p.project_id,c.p.id,c.p.generation,'target');c.db.prepare("UPDATE operation SET phase='active'").run();c.db.exec('COMMIT');return this.result(c.p,'active');
 }finally{if(c.db.isTransaction)c.db.exec('ROLLBACK');c.db.close();}}
 async returnToSqlite(directory:string,roots:Readonly<Record<string,string>>={}){
  safePath(directory);const c=await this.control();try{
   const selected=this.selection();if(selected&&selected!==directory)fail('authority_conflict','Return destination is immutable; no second writer opened.');
   if(!selected){if(existsSync(directory))fail('destination_exists','Return requires a fresh output directory.');writeNew(join(this.directory,'return.json'),JSON.stringify({directory}));}
   assertLocalAuthority(this.source,this.row(c.p,'source','blocked'));
   if(!existsSync(directory))newDirectory(directory);
   const choice=join(directory,'selected-return.json');let copy:string;
   if(existsSync(choice)){closeSync(fileDescriptor(choice,4096));const v=z.strictObject({copy:z.string()}).parse(JSON.parse(readFileSync(choice,'utf8')));if(!/^copy-[1-9][0-9]{0,2}$/.test(v.copy))fail('invalid_transfer','Invalid return selection.');copy=join(directory,v.copy);}
   else{let n=1;while(n<1000&&existsSync(join(directory,`copy-${n}`)))n++;if(n===1000)fail('resource_limit','Too many retained partial copies.');copy=join(directory,`copy-${n}`);}
   const path=join(copy,'memory.sqlite');
   if(existsSync(join(copy,'portable-import.json'))){
    closeSync(fileDescriptor(join(copy,'portable-import.json'),4096));const marker=z.strictObject({project_id:z.uuid(),transfer_id:z.uuid(),generation:z.int().positive(),status:z.literal('imported_fenced'),claims_verified:z.literal(false)}).parse(JSON.parse(readFileSync(join(copy,'portable-import.json'),'utf8')));
    if(marker.transfer_id!==c.p.id||marker.project_id!==c.p.project_id||marker.generation!==c.p.generation+1)fail('authority_conflict','Return copy belongs to another transfer.');
   }else{
    const present=(await rows(this.target,'SELECT id FROM projects WHERE id=?',[c.p.project_id],1)).length>0;
    let bundle:unknown;
    if(present){
     // Monotonic epoch prevents any delayed old activation from reopening this target.
     await transferBatch(this.target,sql=>{
      assertSql(sql,"EXISTS(SELECT 1 FROM d1_project_authority WHERE project_id=? AND transfer_id=? AND role='target' AND generation IN (?,?)) AND NOT EXISTS(SELECT 1 FROM executions WHERE project_id=? AND ended_at IS NULL)",c.p.project_id,c.p.id,c.p.generation,c.p.generation+1,c.p.project_id);
      sql("UPDATE d1_project_authority SET state='blocked',generation=?,updated_at=? WHERE project_id=?",c.p.generation+1,new Date().toISOString(),c.p.project_id);
     });bundle=await exportD1Project(this.target,c.p.project_id);
    }else{
     if(existsSync(join(this.directory,'activation.json')))fail('authority_conflict','Previously activated D1 project is unavailable. Source stays fenced.');
     await transferBatch(this.target,sql=>{
      assertSql(sql,"NOT EXISTS(SELECT 1 FROM projects WHERE id=?) AND (NOT EXISTS(SELECT 1 FROM d1_project_authority WHERE project_id=?) OR EXISTS(SELECT 1 FROM d1_project_authority WHERE project_id=? AND transfer_id=? AND state='blocked' AND generation=?))",c.p.project_id,c.p.project_id,c.p.project_id,c.p.id,c.p.generation+1);
      sql("INSERT INTO d1_project_authority VALUES(?,?,?,?,'target','blocked',0,NULL,?) ON CONFLICT(project_id) DO NOTHING",c.p.project_id,c.p.project_key,c.p.id,c.p.generation+1,new Date().toISOString());
     });
     bundle=await localToD1(readLocalProject(this.source,this.projectId),c.p.id.replaceAll('-',''));
    }
    const data=await d1ToLocal(bundle,roots);writeLocalProject(data,copy,this.row(c.p,'return','blocked'));
   }
   if(!existsSync(choice))writeNew(choice,JSON.stringify({copy:copy.slice(directory.length+1)}));
   const a=await d1WriteAuthority(this.target,c.p.project_id);if(a['managed']&&a['write_allowed']!==false)fail('authority_conflict','D1 is not fenced; return stays blocked.');
   const current=localAuthority(path,c.p.project_id);if(current['transfer_id']!==c.p.id||current['generation']!==c.p.generation+1||current['current_copy']!=='return')fail('authority_conflict','Selected return ownership differs. No copy opened.');
   setLocalAuthority(path,this.row(c.p,'return','writable'));assertLocalAuthority(path,this.row(c.p,'return','writable'));
   c.db.prepare("UPDATE operation SET phase='returned'").run();c.db.exec('COMMIT');return this.result(c.p,'returned');
  }finally{if(c.db.isTransaction)c.db.exec('ROLLBACK');c.db.close();}
 }
 private async result(p:Plan,phase:string){return {phase,transfer_id:p.id,project_id:p.project_id,source:localAuthority(this.source,p.project_id),target:await d1WriteAuthority(this.target,p.project_id),return_directory:this.selection()??null,active_sqlite_db:this.returnPath(),automatic_forwarding:false,automatic_replay:false,claims_verified:false,unreceived_events:'not_observable'};}
 private returnPath(){const d=this.selection();if(!d||!existsSync(join(d,'selected-return.json')))return null;const v=z.strictObject({copy:z.string().regex(/^copy-[1-9][0-9]{0,2}$/)}).parse(JSON.parse(readFileSync(join(d,'selected-return.json'),'utf8')));return join(d,v.copy,'memory.sqlite');}
 async status(){const c=await this.control();try{return await this.result(c.p,c.phase);}finally{c.db.exec('ROLLBACK');c.db.close();}}
}
