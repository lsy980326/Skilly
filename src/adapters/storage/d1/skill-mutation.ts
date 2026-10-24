import { MemoryError, type JsonObject } from "../../../core/memory/model.js";
import { skillContentText } from "../../../core/skills/schema.js";
import { skillCommandSchema,decodeVersion,validateFiles,type D1Installation,type D1SkillScope } from "./skill-model.js";
import { rows,hashText,type Sql } from "./query.js";
import type { D1Binding } from "./binding.js";
import type { D1Mutation } from "./plan-mutation.js";

export async function hasSkillSchema(db:D1Binding) {
  return (await rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='skill_versions'",[],1)).length===1;
}
export async function skillVersion(db:D1Binding,project:string,key:string,version:string) {
  const [row]=await rows(db,"SELECT * FROM skill_versions WHERE project_id=? AND skill_key=? AND version=?",[project,key,version],1);
  if(!row)throw new MemoryError("not_found","Register the exact skill version first.");
  return decodeVersion(row);
}
export async function installation(db:D1Binding,s:D1SkillScope,id:string):Promise<D1Installation> {
  const [row]=await rows(db,`SELECT i.*,a.id AS assignment_id,a.version FROM skill_installations i JOIN skill_assignments a
    ON a.id=(SELECT id FROM skill_assignments WHERE project_id=i.project_id AND installation_id=i.id ORDER BY seq DESC LIMIT 1)
    WHERE i.project_id=? AND i.id=? AND i.repository=? AND i.environment=? AND i.root_hash=?`,
    [s.project_id,id,s.repository,s.environment,s.root_hash],1);
  if(!row)throw new MemoryError("scope_mismatch","Installation must belong to this exact host project/root/scope.");
  if(row["tool"]!=="codex"&&row["tool"]!=="cursor")throw new MemoryError("invalid_data","Invalid saved installation tool.");
  return {id,project_id:s.project_id,skill_key:String(row["skill_key"]),repository:s.repository,environment:s.environment,root_hash:s.root_hash,
    tool:row["tool"],folder:String(row["folder"]),assignment_id:String(row["assignment_id"]),version:String(row["version"])};
}
type Append=(sql:Sql,assertOne:()=>void)=>void;
export async function prepareD1Skill(db:D1Binding,change:D1Mutation):Promise<Append|"conflict"|undefined> {
  if(change.skill===undefined)return undefined;
  const parsed=skillCommandSchema.safeParse(change.skill);
  if(!parsed.success)throw new MemoryError("invalid_input","Invalid D1 skill command.");
  const c=parsed.data,i=c.input;
  if(i.project_id!==change.project.id||i.idempotency_key!==change.receipt.key)throw new MemoryError("scope_mismatch","Skill and receipt scope differ.");
  if(change.run||change.records||change.reports||change.decision||change.plan||change.execution||change.lifecycle||change.skill_usage
    ||c.operation!=="report"&&(change.record||change.work))
    throw new MemoryError("invalid_input","Skill commands cannot mix unrelated work mutations.");
  if(!await hasSkillSchema(db))throw new MemoryError("unsupported_capability","Apply the explicit D1 skill schema first.");
  const [project]=await rows(db,"SELECT revision FROM projects WHERE id=?",[i.project_id],1);
  if(!project)throw new MemoryError("not_found","Project not found.");
  if(project["revision"]!==change.expected_revision)return "conflict";
  if(c.operation==="register") {
    const input=c.input,hash=await hashText(skillContentText(input.body,input.files));
    const [total]=await rows(db,"SELECT count(*) AS n FROM skill_versions WHERE project_id=?",[i.project_id],1);
    // Source identity is checked independently of the bounded version list.
    const [owner]=await rows(db,"SELECT source FROM skill_versions WHERE project_id=? AND skill_key=? LIMIT 1",[i.project_id,input.skill_key],1);
    if(owner&&owner["source"]!==input.source)throw new MemoryError("source_conflict","Use another key for a different source.");
    const [prior]=await rows(db,"SELECT * FROM skill_versions WHERE project_id=? AND skill_key=? AND version=?",[i.project_id,input.skill_key,input.version],1);
    if(prior) {
      const v=await decodeVersion(prior);
      if(v.content_hash!==hash||v.source!==input.source||v.name!==input.name||v.description!==input.description||v.install_instructions!==input.install_instructions)
        throw new MemoryError("version_conflict","Skill content and metadata are immutable; use a new version.");
      return ()=>{};
    }
    if(Number(total?.["n"])>=10000)throw new MemoryError("resource_limit","D1 project skill-version capacity reached; existing history is retained.");
    return (sql,assertOne)=>{
      sql("INSERT INTO skill_versions(project_id,skill_key,version,source,name,description,body,files_json,content_hash,install_instructions,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        i.project_id,input.skill_key,input.version,input.source,input.name,input.description,input.body,JSON.stringify(input.files),hash,input.install_instructions,c.at);
      assertOne();
    };
  }
  if(c.operation==="assign") {
    const input=c.input;await skillVersion(db,i.project_id,input.skill_key,input.version);
    const [prior]=await rows(db,`SELECT i.id,a.id AS assignment_id FROM skill_installations i LEFT JOIN skill_assignments a
      ON a.id=(SELECT id FROM skill_assignments WHERE project_id=i.project_id AND installation_id=i.id ORDER BY seq DESC LIMIT 1)
      WHERE i.project_id=? AND i.skill_key=? AND i.repository=? AND i.environment=? AND i.root_hash=? AND i.tool=? AND i.folder=?`,
      [i.project_id,input.skill_key,i.repository,i.environment,i.root_hash,input.tool,input.folder],1);
    if((prior?.["assignment_id"]??null)!==input.expected_assignment_id)throw new MemoryError("assignment_conflict","Read the current assignment; do not overwrite a newer choice.");
    if(prior&&prior["id"]!==c.installation_id)return "conflict";
    return (sql,assertOne)=>{
      if(!prior){sql("INSERT INTO skill_installations VALUES(?,?,?,?,?,?,?,?)",c.installation_id,i.project_id,input.skill_key,i.repository,i.environment,i.root_hash,input.tool,input.folder);assertOne();}
      sql("INSERT INTO skill_assignments(id,project_id,installation_id,skill_key,version,assigned_at) VALUES(?,?,?,?,?,?)",c.assignment_id,i.project_id,c.installation_id,input.skill_key,input.version,c.at);
      assertOne();
    };
  }
  if(c.operation==="observe") {
    const target=await installation(db,i,c.input.installation_id);
    if(target.assignment_id!==c.assignment_id)throw new MemoryError("assignment_conflict","Assignment changed during inspection; original observation was not saved.");
    const v=await skillVersion(db,i.project_id,target.skill_key,target.version);
    if(v.content_hash!==c.expected_hash)throw new MemoryError("invalid_data","Observation version hash differs.");
    const observed=await validateFiles(v,c.files);
    return (sql,assertOne)=>{
      sql("INSERT INTO skill_observations(id,project_id,assignment_id,expected_hash,observed_at,state,files_json) VALUES(?,?,?,?,?,?,?)",
        c.id,i.project_id,c.assignment_id,c.expected_hash,c.at,observed.state,JSON.stringify(observed.files));assertOne();
    };
  }
  const input=c.input,r=change.record;
  if(!r||r.id!==input.record_id||r.run_id!==input.run_id||r.project_id!==i.project_id||r.repository!==i.repository||r.environment!==i.environment)
    throw new MemoryError("scope_mismatch","Use reports require their own new record and exact task scope.");
  const [active]=await rows(db,"SELECT id FROM runs WHERE project_id=? AND id=? AND repository=? AND environment=? AND state='active'",[i.project_id,input.run_id,i.repository,i.environment],1);
  if(!active)throw new MemoryError("run_closed","Use reports require an active saved task.");
  const prepared:JsonObject[]=[];
  for(const usage of input.skill_usage) {
    const v=await skillVersion(db,i.project_id,usage.skill_key,usage.version);
    if(usage.observation_id) {
      const [o]=await rows(db,`SELECT o.*,a.version,a.skill_key,i.repository,i.environment,i.root_hash FROM skill_observations o
        JOIN skill_assignments a ON a.project_id=o.project_id AND a.id=o.assignment_id
        JOIN skill_installations i ON i.project_id=a.project_id AND i.id=a.installation_id WHERE o.project_id=? AND o.id=?`,[i.project_id,usage.observation_id],1);
      if(!o||o["version"]!==usage.version||o["skill_key"]!==usage.skill_key||o["expected_hash"]!==v.content_hash
        ||o["repository"]!==i.repository||o["environment"]!==i.environment||o["root_hash"]!==i.root_hash)
        throw new MemoryError("scope_mismatch","Observation must match this exact project/root/task scope and reported version.");
    }
    prepared.push({...usage,observation_id:usage.observation_id??null,content_hash:v.content_hash});
  }
  return (sql,assertOne)=>{
    for(const u of prepared) {
      sql(`INSERT INTO task_skill_usage SELECT ?,?,?,?,?,?,?,? WHERE EXISTS
        (SELECT 1 FROM runs WHERE project_id=? AND id=? AND state='active' AND repository=? AND environment=?)`,
        i.project_id,input.record_id,input.run_id,String(u["skill_key"]),String(u["version"]),String(u["content_hash"]),String(u["purpose"]),
        typeof u["observation_id"]==="string"?u["observation_id"]:null,i.project_id,input.run_id,i.repository,i.environment);assertOne();
    }
  };
}
