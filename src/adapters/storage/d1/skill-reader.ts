import { z } from "zod";
import { MemoryError,type JsonObject,parseJsonObject } from "../../../core/memory/model.js";
import { skillKey } from "../../../core/skills/schema.js";
import { hasSkillSchema,installation,skillVersion } from "./skill-mutation.js";
import { skillScopeSchema,skillEvidence,decodeVersion,type D1SkillScope } from "./skill-model.js";
import { rows,bounded,json,bytes } from "./query.js";
import type { D1Binding } from "./binding.js";

const page=(n:number)=>{if(!Number.isSafeInteger(n)||n<0||n>100000)throw new MemoryError("invalid_input","Invalid skill page.");return n;};
function paged(items:JsonObject[],offset:number,size:number,extra:JsonObject={}) {
  const visible:JsonObject[]=[];
  for(const item of items.slice(0,size)){if(bytes([...visible,item])>56*1024)break;visible.push(item);}
  if(items.length&&!visible.length)throw new MemoryError("resource_limit","One skill projection exceeds the bounded page.");
  const next=offset+visible.length,more=items.length>visible.length;
  return bounded(json({items:visible,next_offset:more&&next<=100000?next:null,pagination_truncated:more&&next>100000,
    projection_truncated:visible.length<Math.min(size,items.length),pagination:"live_offset",schema_supported:true,...skillEvidence,...extra}),64*1024);
}
export class D1SkillReader {
  protected readonly scope:D1SkillScope;
  constructor(protected readonly db:D1Binding,s:D1SkillScope){this.scope=skillScopeSchema.parse(s);}
  protected async supported() {
    if(!(await rows(this.db,"SELECT id FROM projects WHERE id=?",[this.scope.project_id],1)).length)throw new MemoryError("not_found","Project not found.");
    return hasSkillSchema(this.db);
  }
  async list(query="",offset=0):Promise<JsonObject> {
    page(offset);if(typeof query!=="string"||query.length>200)throw new MemoryError("invalid_input","Invalid skill query.");
    if(!await this.supported())return {status:"unsupported",schema_supported:false,...skillEvidence};
    const s=this.scope,data=await rows(this.db,`SELECT v.skill_key,v.name,v.source,v.version,v.content_hash,v.created_at,
      (SELECT count(*) FROM skill_versions WHERE project_id=v.project_id AND skill_key=v.skill_key) AS versions,
      (SELECT count(*) FROM skill_installations i WHERE i.project_id=v.project_id AND i.skill_key=v.skill_key AND i.repository=? AND i.environment=? AND i.root_hash=?) AS installations
      FROM skill_versions v WHERE v.project_id=? AND v.seq=(SELECT max(seq) FROM skill_versions WHERE project_id=v.project_id AND skill_key=v.skill_key)
      AND (instr(lower(v.name),lower(?))>0 OR instr(lower(v.skill_key),lower(?))>0) ORDER BY v.seq DESC LIMIT 11 OFFSET ?`,
      [s.repository,s.environment,s.root_hash,s.project_id,query,query,offset],11);
    return paged(data,offset,10,{catalog_scope:"project",installation_scope:"host_repository_environment_root"});
  }
  async detail(key:string,version?:string,offset=0):Promise<JsonObject> {
    page(offset);if(!skillKey.safeParse(key).success||version!==undefined&&(!version||version.length>80))throw new MemoryError("invalid_input","Invalid skill version.");
    if(!await this.supported())throw new MemoryError("unsupported_capability","D1 skill schema is not installed.");
    const s=this.scope,[raw]=await rows(this.db,`SELECT * FROM skill_versions WHERE project_id=? AND skill_key=? ${version===undefined?"":"AND version=?"} ORDER BY seq DESC LIMIT 1`,
      [s.project_id,key,...(version===undefined?[]:[version])],1);
    if(!raw)throw new MemoryError("not_found","Skill version not found.");
    const {idempotency_key:_key,...skill}=await decodeVersion(raw);
    const versions=await rows(this.db,"SELECT version,content_hash,created_at FROM skill_versions WHERE project_id=? AND skill_key=? ORDER BY seq DESC LIMIT 101",[s.project_id,key],101);
    const installs=await rows(this.db,`SELECT i.*,a.id AS assignment_id,a.version,a.assigned_at,o.id AS observation_id,o.state AS file_state,o.observed_at,o.expected_hash,o.files_json
      FROM skill_installations i JOIN skill_assignments a ON a.id=(SELECT id FROM skill_assignments WHERE project_id=i.project_id AND installation_id=i.id ORDER BY seq DESC LIMIT 1)
      LEFT JOIN skill_observations o ON o.id=(SELECT id FROM skill_observations WHERE project_id=a.project_id AND assignment_id=a.id ORDER BY seq DESC LIMIT 1)
      WHERE i.project_id=? AND i.skill_key=? AND i.repository=? AND i.environment=? AND i.root_hash=? ORDER BY i.tool,i.folder,i.id LIMIT 7 OFFSET ?`,
      [s.project_id,key,s.repository,s.environment,s.root_hash,offset],7);
    return bounded(json({skill,versions:versions.slice(0,100),versions_truncated:versions.length>100,installations:installs.slice(0,6).map(row=>{
      const {files_json,...rest}=row;return {...rest,state:row["file_state"]??"not_checked",files:typeof files_json==="string"?JSON.parse(files_json):[],evidence:"last_saved_host_file_observation",...skillEvidence};}),
      installation_offset:offset,next_installation_offset:installs.length>6&&offset+6<=100000?offset+6:null,pagination_truncated:installs.length>6&&offset+6>100000,
      schema_supported:true,content_is_untrusted:true,...skillEvidence}));
  }
  async package(key:string,version:string):Promise<JsonObject> {
    if(!skillKey.safeParse(key).success||typeof version!=="string"||!version||version.length>80)throw new MemoryError("invalid_input","Select an exact skill package version.");
    if(!await this.supported())throw new MemoryError("unsupported_capability","D1 skill schema is not installed.");
    const skill=parseJsonObject(JSON.stringify(await skillVersion(this.db,this.scope.project_id,key,version)));
    return bounded({format:"skilly-skill",format_version:1,skill_key:skill["skill_key"]!,version:skill["version"]!,source:skill["source"]!,
      name:skill["name"]!,description:skill["description"]!,body:skill["body"]!,files:skill["files"]!,install_instructions:skill["install_instructions"]!,content_hash:skill["content_hash"]!});
  }
  async history(installationId:string,kind:"assignments"|"observations",offset=0):Promise<JsonObject> {
    page(offset);if(!z.uuid().safeParse(installationId).success||!["assignments","observations"].includes(kind))throw new MemoryError("invalid_input","Invalid installation history.");
    if(!await this.supported())return {status:"unsupported",schema_supported:false,...skillEvidence};
    await installation(this.db,this.scope,installationId);
    const data=kind==="assignments"?await rows(this.db,"SELECT id,version,assigned_at FROM skill_assignments WHERE project_id=? AND installation_id=? ORDER BY seq DESC LIMIT 11 OFFSET ?",
      [this.scope.project_id,installationId,offset],11):await rows(this.db,`SELECT o.id,o.assignment_id,a.version,o.expected_hash,o.observed_at,o.state,o.files_json
      FROM skill_observations o JOIN skill_assignments a ON a.project_id=o.project_id AND a.id=o.assignment_id
      WHERE a.project_id=? AND a.installation_id=? ORDER BY o.seq DESC LIMIT 11 OFFSET ?`,[this.scope.project_id,installationId,offset],11);
    return paged(data.map(row=>{const {files_json,...rest}=row;return {...rest,...(typeof files_json==="string"?{files:JSON.parse(files_json)}:{})};}),offset,10);
  }
  async taskSkills(runId:string,offset=0):Promise<JsonObject> {
    page(offset);if(!z.uuid().safeParse(runId).success)throw new MemoryError("invalid_input","Invalid task ID.");
    const s=this.scope;
    if(!(await rows(this.db,"SELECT id FROM runs WHERE project_id=? AND id=? AND repository=? AND environment=?",[s.project_id,runId,s.repository,s.environment],1)).length)
      throw new MemoryError("not_found","Task not found in this exact scope.");
    if(!await this.supported())return {status:"unsupported",schema_supported:false,...skillEvidence};
    const data=await rows(this.db,`SELECT u.*,v.name,r.report_origin,r.recorded_at,r.superseded_by,o.state,o.observed_at,o.expected_hash,o.files_json,
      i.tool,i.folder,i.root_hash,a.version AS observed_version FROM task_skill_usage u
      JOIN records r ON r.project_id=u.project_id AND r.id=u.record_id
      JOIN skill_versions v ON v.project_id=u.project_id AND v.skill_key=u.skill_key AND v.version=u.version
      LEFT JOIN skill_observations o ON o.project_id=u.project_id AND o.id=u.observation_id
      LEFT JOIN skill_assignments a ON a.project_id=o.project_id AND a.id=o.assignment_id
      LEFT JOIN skill_installations i ON i.project_id=a.project_id AND i.id=a.installation_id
      WHERE u.project_id=? AND u.run_id=? AND r.repository=? AND r.environment=? ORDER BY r.seq DESC,u.skill_key,u.version LIMIT 9 OFFSET ?`,
      [s.project_id,runId,s.repository,s.environment,offset],9);
    return paged(data.map(row=>({skill_key:row["skill_key"]!,version:row["version"]!,content_hash:row["content_hash"]!,name:row["name"]!,purpose:row["purpose"]!,
      run_id:runId,record_id:row["record_id"]!,report_origin:row["report_origin"]!,recorded_at:row["recorded_at"]!,report_state:row["superseded_by"]?"superseded":"reported",
      provenance:"agent_report",...skillEvidence,
      file_observation_status:!row["observation_id"]?"not_collected":row["root_hash"]===s.root_hash?"attached":"outside_host_root",
      file_observation:row["observation_id"]&&row["root_hash"]===s.root_hash?{id:row["observation_id"],state:row["state"]!,observed_at:row["observed_at"]!,
        version:row["observed_version"]!,expected_hash:row["expected_hash"]!,files:JSON.parse(String(row["files_json"])),root_hash:row["root_hash"]!,tool:row["tool"]!,folder:row["folder"]!,
        evidence:"host_files_at_observation_time",authenticity:"not_attested",current_machine_verified:false,loading_status:"unknown"}:null})),offset,8,{coverage:"explicit_checkpoint_reports_only"});
  }
}
