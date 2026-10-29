import { DatabaseSync } from "node:sqlite";
import { lstatSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { newDirectory, safePath, writeNew, fileDescriptor, fail } from "./files.js";
import { closeSync } from "node:fs";
import { readDatabase, initialize } from "./database.js";
import { exportProject, importProject } from "./project.js";
import { readEvents } from "./events.js";
import { lifecycleSchemaSql } from "../sqlite/lifecycle.js";
import { taskLinkSchema } from "../sqlite/task-event-storage.js";
import { authorityRow, hasAuthority, putAuthority, readAuthority, type AuthorityRow, type AuthorityKind } from "../sqlite/project-authority.js";
import { prepareReturnCopy, returnPath } from "./return-copy.js";

const planSchema=z.strictObject({id:z.uuid(),project_id:z.uuid(),project_key:z.string().min(1).max(100),source:z.string(),
  source_dev:z.number().int(),source_ino:z.number().int(),generation:z.int().positive()});
type Plan=z.infer<typeof planSchema>;
const controlSql="CREATE TABLE operation (plan TEXT NOT NULL, phase TEXT NOT NULL) STRICT;";
const phases=["preparing","prepared","active","aborted","returned"];
const parts: [AuthorityKind,string][]=[["main",""],["recovery",".recovery.sqlite"],["events",".events.sqlite"]];
const row=(plan:Plan,role:AuthorityRow["role"],state:AuthorityRow["state"]):AuthorityRow=>({project_id:plan.project_id,project_key:plan.project_key,
  transfer_id:plan.id,generation:plan.generation+(role==="return"?1:0),role,state,updated_at:new Date().toISOString()});

function sourceIdentity(plan:Plan):void {
  safePath(plan.source);const stat=lstatSync(plan.source);
  if(!stat.isFile() || stat.dev!==plan.source_dev || stat.ino!==plan.source_ino)fail("source_changed","Original database identity changed. Nothing was activated.");
}
function validateCopy(path:string):void {
  const main=readDatabase(path);main.close();
  for(const [kind,suffix] of parts.slice(1)) {
    const file=path+suffix;if(!existsSync(file))fail("incomplete_transfer","Transfer companion missing; keep every copy closed.");
    const db=kind==="events"?readEvents(file):readDatabase(file,true);db.close();
  }
}
function provision(plan:Plan):void {
  for(const [kind,suffix] of parts.slice(1)) {
    const path=plan.source+suffix;safePath(path);
    if(existsSync(path))continue;
    writeNew(path,"");const db=new DatabaseSync(path);
    try { if(kind==="recovery")initialize(db,true);else db.exec(lifecycleSchemaSql+taskLinkSchema); } finally { db.close(); }
  }
}
function setPart(path:string,kind:AuthorityKind,a:AuthorityRow):void {
  safePath(path);closeSync(fileDescriptor(path));const db=new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;");
    try {
      if(kind==="main" && a.state==="blocked" && db.prepare("SELECT 1 FROM executions WHERE project_id=? AND ended_at IS NULL LIMIT 1").get(a.project_id))
        fail("execution_in_progress","An unfinished execution observation exists. Do not interrupt or rerun its command to force transfer.");
      if(kind==="events")db.exec(taskLinkSchema);
      putAuthority(db,kind,a);db.exec("COMMIT");
    } catch(error){db.exec("ROLLBACK");throw error;}
  } finally { db.close(); }
}
function setCopy(path:string,a:AuthorityRow):void {
  // Close main first; open main last. A work writer is never opened on both sides.
  const ordered=a.state==="blocked"?parts:[...parts.slice(1),parts[0]!];
  for(const [kind,suffix] of ordered)setPart(path+suffix,kind,a);
}
function assertCopy(path:string,plan:Plan,state:AuthorityRow["state"]|"recovering",role:AuthorityRow["role"]):void {
  validateCopy(path);
  for(const [kind,suffix] of parts) {
    const db=kind==="events"?readEvents(path+suffix):readDatabase(path+suffix,kind==="recovery");
    try {
      const a=hasAuthority(db)?db.prepare("SELECT * FROM project_authority WHERE project_id=?").get(plan.project_id):undefined;
      const actual=authorityRow.parse(a),expected=row(plan,role,state==="recovering"?actual.state:state);
      if(["transfer_id","project_key","generation","state","role"].some(k=>actual[k as keyof AuthorityRow]!==expected[k as keyof AuthorityRow]))
        fail("authority_conflict","A different generation or transfer controls this copy.");
    } finally{db.close();}
  }
}
function control(directory:string) {
  safePath(directory);const path=join(directory,"operation.sqlite");closeSync(fileDescriptor(path,1024*1024));
  const db=new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;");
    const schema=db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL").all();
    if(schema.length!==1 || schema[0]?.["name"]!=="operation" || schema[0]?.["sql"]!==controlSql.slice(0,-1))fail("invalid_transfer","Unsupported transfer state.");
    const rows=db.prepare("SELECT * FROM operation LIMIT 2").all();if(rows.length!==1 || !phases.includes(String(rows[0]?.["phase"])))fail("invalid_transfer","Invalid transfer phase.");
    const plan=planSchema.parse(JSON.parse(String(rows[0]?.["plan"])));sourceIdentity(plan);
    return {db,plan,phase:String(rows[0]?.["phase"])};
  }catch(error){db.close();throw error;}
}
function paths(directory:string){return {target:join(directory,"target","memory.sqlite"),returned:returnPath(directory)};}
function activationIntent(directory:string,p:Plan,create=false):boolean {
  const path=join(directory,"activation.json"),content=JSON.stringify({transfer_id:p.id,meaning:"target_activation_is_irreversible_to_old_source"});
  if(create) {
    try{writeNew(path,content);}catch(error){if(!(error instanceof Error && "code" in error && error.code==="EEXIST"))throw error;}
  }
  if(!existsSync(path))return false;
  const fd=fileDescriptor(path,1024);
  try{if(readFileSync(fd,"utf8")!==content)fail("invalid_transfer","Activation intent differs; neither old copy may be reopened.");}finally{closeSync(fd);}
  return true;
}
function result(directory:string,p:Plan,phase:string) {
  const active=phase==="active"?paths(directory).target:phase==="returned"?paths(directory).returned:phase==="aborted"?p.source:null;
  return {status:phase,transfer_id:p.id,project_id:p.project_id,active_db:active,automatic_forwarding:false,automatic_replay:false,claims_verified:false};
}

export async function prepareTransfer(source:string,projectId:string,directory:string) {
  safePath(source);safePath(directory);const check=readDatabase(source);
  let plan:Plan;
  try {
    if(![15,16,17].includes(Number(check.prepare("PRAGMA user_version").get()?.["user_version"])))fail("unsupported_database","Transfer activation requires a current v15–v17 database; original was not migrated.");
    const project=check.prepare("SELECT project_key FROM projects WHERE id=?").get(projectId);if(!project)fail("not_found","Project absent.");
    const authority=readAuthority(check,projectId);if(authority["write_allowed"]!==true)fail("authority_conflict","Source is already fenced.");
    const stat=lstatSync(source);plan={id:randomUUID(),project_id:projectId,project_key:String(project["project_key"]),source,
      source_dev:stat.dev,source_ino:stat.ino,generation:Number(authority["generation"]??0)+1};
  } finally{check.close();}
  newDirectory(directory);writeNew(join(directory,"operation.sqlite"),"");const init=new DatabaseSync(join(directory,"operation.sqlite"));
  try{init.exec(controlSql);init.prepare("INSERT INTO operation VALUES(?,'preparing')").run(JSON.stringify(plan));}finally{init.close();}
  const c=control(directory);
  try {
    provision(plan);validateCopy(source);setCopy(source,row(plan,"source","blocked"));assertCopy(source,plan,"blocked","source");
    exportProject(source,projectId,join(directory,"export"));
    await importProject(join(directory,"export"),join(directory,"target"),undefined,row(plan,"target","blocked"));
    assertCopy(paths(directory).target,plan,"blocked","target");
    c.db.prepare("UPDATE operation SET phase='prepared'").run();c.db.exec("COMMIT");return result(directory,plan,"prepared");
  }catch(error){if(c.db.isTransaction)c.db.exec("ROLLBACK");throw error;}finally{c.db.close();}
}

export function transferStatus(directory:string) {
  const c=control(directory);
  try {
    const copies:Record<string,unknown>={};
    for(const [role,path] of Object.entries({source:c.plan.source,...paths(directory)})) {
      if(!existsSync(path)){copies[role]={status:"absent",write_allowed:false};continue;}
      let db:DatabaseSync|undefined;
      try{db=readDatabase(path);copies[role]=readAuthority(db,c.plan.project_id);}catch{copies[role]={status:"unavailable",write_allowed:false};}finally{db?.close();}
    }
    return {...result(directory,c.plan,c.phase),activation_intent:activationIntent(directory,c.plan),copies};
  }finally{c.db.exec("ROLLBACK");c.db.close();}
}
export function activateTransfer(directory:string) {
  const c=control(directory);
  try {
    if(c.phase==="active"){assertCopy(paths(directory).target,c.plan,"writable","target");return result(directory,c.plan,c.phase);}
    if(c.phase!=="prepared")fail("transfer_phase","Prepare or recover this operation first.");
    assertCopy(c.plan.source,c.plan,"blocked","source");assertCopy(paths(directory).target,c.plan,"blocked","target");
    // Durable before the first target sidecar opens. A later crash must never
    // turn a formerly writable target into permission to reopen an old source.
    activationIntent(directory,c.plan,true);
    setCopy(paths(directory).target,row(c.plan,"target","writable"));
    c.db.prepare("UPDATE operation SET phase='active'").run();c.db.exec("COMMIT");return result(directory,c.plan,"active");
  }finally{if(c.db.isTransaction)c.db.exec("ROLLBACK");c.db.close();}
}
export async function recoverTransfer(directory:string,backup?:string) {
  const c=control(directory),p=c.plan,{target,returned}=paths(directory);
  try {
    if(backup!==undefined && !activationIntent(directory,p))fail("transfer_phase","Backup activation requires an existing target activation intent; the source was not reopened.");
    if(c.phase==="aborted"){assertCopy(p.source,p,"writable","source");return result(directory,p,c.phase);}
    if(c.phase==="returned"){
      assertCopy(p.source,p,"blocked","source");assertCopy(target,p,"blocked","target");
      if(existsSync(join(directory,"return-selection.json")))await prepareReturnCopy(directory,target,row(p,"return","blocked"),backup);
      else if(backup!==undefined)fail("transfer_phase","A legacy return is already active; do not select another backup.");
      assertCopy(returned,p,"writable","return");return result(directory,p,c.phase);
    }
    // An active target may contain writes even if a crash left control.phase=prepared.
    let targetWasWritable=false;
    if(existsSync(target)) {
      assertCopy(target,p,"recovering","target");
      const read=readDatabase(target);
      try{const a=readAuthority(read,p.project_id);targetWasWritable=a["write_allowed"]===true;
        if(a["transfer_id"]!==p.id)fail("authority_conflict","Target is incomplete or owned by another transfer.");}finally{read.close();}
      if(targetWasWritable)activationIntent(directory,p,true);
      setCopy(target,row(p,"target","blocked"));assertCopy(target,p,"blocked","target");
    }
    if(c.phase!=="active" && !targetWasWritable && !activationIntent(directory,p) && !existsSync(returned)) {
      provision(p);setCopy(p.source,row(p,"source","writable"));assertCopy(p.source,p,"writable","source");
      c.db.prepare("UPDATE operation SET phase='aborted'").run();c.db.exec("COMMIT");return result(directory,p,"aborted");
    }
    assertCopy(p.source,p,"blocked","source");assertCopy(target,p,"blocked","target");
    // Legacy completed returns remain authoritative after a lost coordinator
    // commit. Never create another writer merely because phase is still active.
    const legacy=existsSync(join(directory,"return","import.json")) && !existsSync(join(directory,"return-selection.json"));
    if(legacy && backup!==undefined)fail("transfer_phase","A completed legacy return must be recovered before selecting a backup.");
    const copy=legacy?returned:await prepareReturnCopy(directory,target,row(p,"return","blocked"),backup);
    assertCopy(copy,p,"recovering","return");
    setCopy(copy,row(p,"return","writable"));
    c.db.prepare("UPDATE operation SET phase='returned'").run();c.db.exec("COMMIT");return result(directory,p,"returned");
  }finally{if(c.db.isTransaction)c.db.exec("ROLLBACK");c.db.close();}
}
