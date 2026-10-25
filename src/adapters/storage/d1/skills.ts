import { z } from "zod";
import { MemoryError,type JsonObject,type Project } from "../../../core/memory/model.js";
import { commitWithReceipt } from "../../../core/memory/atomic-commit.js";
import { registerSkillSchema,skillContentText } from "../../../core/skills/schema.js";
import { D1AtomicCommitStore } from "./atomic-store.js";
import { D1SkillReader } from "./skill-reader.js";
import { assignSkillSchema,inspectSkillSchema,skillCheckpointSchema,skillEvidence,validateFiles,type D1SkillChange,type D1SkillScope,type D1SkillObserver } from "./skill-model.js";
import { hasSkillSchema,installation,skillVersion } from "./skill-mutation.js";
import { rows,canonical,hashText } from "./query.js";
import type { D1Mutation } from "./plan-mutation.js";
import type { D1Binding } from "./binding.js";

type Change=Omit<D1Mutation,"project"|"expected_revision"|"receipt"> & {result:JsonObject};
/** Async business boundary only. No filesystem, installation, remote request or model execution. */
export class D1Skills extends D1SkillReader {
  private readonly store:D1AtomicCommitStore;
  constructor(db:D1Binding,s:D1SkillScope,private readonly observer?:D1SkillObserver) {
    super(db,s);this.store=new D1AtomicCommitStore(db,s.project_id);
    if(observer&&observer.root_hash!==s.root_hash)throw new MemoryError("scope_mismatch","Observer must be bound to this exact host root.");
  }
  private async write(operation:string,input:unknown,key:string,build:()=>Promise<Change>):Promise<JsonObject> {
    const digest=await hashText(canonical({operation,input,scope:this.scope}));
    return commitWithReceipt(this.store,this.scope.project_id,key,digest,async()=>{
      // Never adopt a revision fetched after domain/observation preparation.
      const [p]=await rows(this.db,"SELECT id,project_key AS key,name,revision,created_at FROM projects WHERE id=?",[this.scope.project_id],1);
      if(!p)throw new MemoryError("not_found","Project not found.");
      const project:Project=z.strictObject({id:z.uuid(),key:z.string(),name:z.string(),revision:z.int().nonnegative(),created_at:z.string()}).parse(p);
      const change=await build();
      return {project:{...project,revision:project.revision+1},expected_revision:project.revision,...change,result:{...change.result,scope:{...this.scope}}};
    });
  }
  async register(input:z.input<typeof registerSkillSchema>):Promise<JsonObject> {
    const parsed=registerSkillSchema.safeParse(input);if(!parsed.success)throw new MemoryError("invalid_input","Invalid skill registration.");
    const i=parsed.data;if(i.project_id!==this.scope.project_id)throw new MemoryError("scope_mismatch","Register only in the host-bound project.");
    const c:D1SkillChange={operation:"register",input:{...i,...this.scope},at:new Date().toISOString()};
    const content_hash=await hashText(skillContentText(i.body,i.files));
    return this.write("register",i,i.idempotency_key,async()=>({skill:c,result:{status:"persisted",skill_key:i.skill_key,version:i.version,content_hash,
      evidence:"supplied_content",...skillEvidence}}));
  }
  async assign(input:z.input<typeof assignSkillSchema>):Promise<JsonObject> {
    const parsed=assignSkillSchema.safeParse(input);if(!parsed.success)throw new MemoryError("invalid_input","Invalid installation assignment.");
    const i=parsed.data,s=this.scope,assignment_id=crypto.randomUUID(),at=new Date().toISOString();
    return this.write("assign",i,i.idempotency_key,async()=>{
      if(!await hasSkillSchema(this.db))throw new MemoryError("unsupported_capability","D1 skill schema is not installed.");
      const [prior]=await rows(this.db,`SELECT id FROM skill_installations WHERE project_id=? AND skill_key=? AND repository=? AND environment=? AND root_hash=? AND tool=? AND folder=?`,
        [s.project_id,i.skill_key,s.repository,s.environment,s.root_hash,i.tool,i.folder],1);
      const installation_id=prior?String(prior["id"]):crypto.randomUUID();
      return {skill:{operation:"assign",input:{...i,...s},installation_id,assignment_id,at},result:{status:"persisted",installation_id,assignment_id,version:i.version,observation:"not_checked",...skillEvidence}};
    });
  }
  async inspect(input:z.input<typeof inspectSkillSchema>):Promise<JsonObject> {
    const parsed=inspectSkillSchema.safeParse(input);if(!parsed.success)throw new MemoryError("invalid_input","Invalid inspection request.");
    const i=parsed.data,s=this.scope;
    let captured:Change|undefined;
    return this.write("inspect",i,i.idempotency_key,async()=>{
      if(captured)return captured; // CAS retry must not silently sample a different filesystem state.
      if(!await hasSkillSchema(this.db))throw new MemoryError("unsupported_capability","D1 skill schema is not installed.");
      if(!this.observer)throw new MemoryError("observation_provider_required","Only an explicit host observer can collect file evidence.");
      const target=await installation(this.db,s,i.installation_id),version=await skillVersion(this.db,s.project_id,target.skill_key,target.version);
      const files=await this.observer.observe(Object.freeze({...target}),Object.freeze({...version})),observed=await validateFiles(version,files);
      const id=crypto.randomUUID(),at=new Date().toISOString();
      captured={skill:{operation:"observe",input:{...i,...s},id,assignment_id:target.assignment_id,expected_hash:version.content_hash,files:observed.files,at},
        result:{status:"persisted",observation_id:id,installation_id:target.id,assignment_id:target.assignment_id,version:target.version,state:observed.state,observed_at:at,
          evidence:"host_files_at_observation_time",authenticity:"not_attested",...skillEvidence}};
      return captured;
    });
  }
  async checkpoint(input:z.input<typeof skillCheckpointSchema>):Promise<JsonObject> {
    const parsed=skillCheckpointSchema.safeParse(input);if(!parsed.success)throw new MemoryError("invalid_input","Invalid skill use report.");
    const i=parsed.data,s=this.scope,id=crypto.randomUUID(),at=new Date().toISOString();
    return this.write("report",i,i.idempotency_key,async()=>({
      skill:{operation:"report",input:{...s,run_id:i.run_id,record_id:id,skill_usage:i.skill_usage,idempotency_key:i.idempotency_key}},
      record:{id,project_id:s.project_id,run_id:i.run_id,topic:i.topic,kind:i.kind,body:i.body,repository:s.repository,environment:s.environment,
        observed_at:at,recorded_at:at,source_fingerprint:null,supersedes:i.supersedes??null,superseded_by:null,report_origin:i.report_origin},
      ...(i.report?{work:{run_id:i.run_id,record_id:id,report:i.report}}:{}),
      result:{status:"persisted",record_id:id,provenance:"agent_report",report_origin:i.report_origin,...skillEvidence},
    }));
  }
}
