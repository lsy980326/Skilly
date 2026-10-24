import { z } from "zod";
import { MemoryError, type JsonObject } from "../../../core/memory/model.js";
import { registerSkillSchema, skillKey, observationFilesSchema, skillContentText } from "../../../core/skills/schema.js";
import { skillUsagesSchema } from "../../../core/skills/usage.js";
import { reportSchema } from "../../../core/work/schema.js";
import { d1ScopeSchema, hashText } from "./query.js";

const key=z.string().min(1).max(128),digest=z.string().regex(/^[a-f0-9]{64}$/);
export const skillScopeSchema=d1ScopeSchema.extend({root_hash:digest});
export type D1SkillScope=z.infer<typeof skillScopeSchema>;
export const assignSkillSchema=z.strictObject({skill_key:skillKey,version:z.string().min(1).max(80),tool:z.enum(["codex","cursor"]),
  folder:skillKey,expected_assignment_id:z.uuid().nullable(),idempotency_key:key});
export const inspectSkillSchema=z.strictObject({installation_id:z.uuid(),idempotency_key:key});
export const skillCheckpointSchema=z.strictObject({run_id:z.uuid(),topic:z.string().min(1).max(160),
  kind:z.enum(["note","decision","change","issue","summary"]),body:z.string().min(1).max(48000),
  report_origin:z.enum(["unspecified","contemporaneous","retrospective"]).default("contemporaneous"),
  supersedes:z.uuid().optional(),report:reportSchema.optional(),skill_usage:skillUsagesSchema,idempotency_key:key});
const registerCommand=z.strictObject({operation:z.literal("register"),input:registerSkillSchema.safeExtend(skillScopeSchema.shape),at:z.iso.datetime()});
const assignCommand=z.strictObject({operation:z.literal("assign"),input:assignSkillSchema.extend(skillScopeSchema.shape),
  installation_id:z.uuid(),assignment_id:z.uuid(),at:z.iso.datetime()});
const observeCommand=z.strictObject({operation:z.literal("observe"),input:inspectSkillSchema.extend(skillScopeSchema.shape),
  id:z.uuid(),assignment_id:z.uuid(),expected_hash:digest,files:observationFilesSchema,at:z.iso.datetime()});
const reportCommand=z.strictObject({operation:z.literal("report"),input:z.strictObject({...skillScopeSchema.shape,
  run_id:z.uuid(),record_id:z.uuid(),skill_usage:skillUsagesSchema,idempotency_key:key})});
export const skillCommandSchema=z.discriminatedUnion("operation",[registerCommand,assignCommand,observeCommand,reportCommand]);
export type D1SkillChange=z.infer<typeof skillCommandSchema>;
export type D1SkillVersion=z.output<typeof registerSkillSchema> & {content_hash:string;created_at:string};
export type D1Installation={id:string;project_id:string;skill_key:string;repository:string;environment:string;root_hash:string;
  tool:"codex"|"cursor";folder:string;assignment_id:string;version:string};
export interface D1SkillObserver {
  readonly root_hash:string;
  observe(installation:D1Installation,version:D1SkillVersion):Promise<z.infer<typeof observationFilesSchema>>;
}
export const skillEvidence=Object.freeze({claims_verified:false,loading_status:"unknown",current_machine_verified:false,
  automatic_install:false,recovery_queued:false});
export async function decodeVersion(row:JsonObject):Promise<D1SkillVersion> {
  const {seq:_seq,content_hash,created_at,files_json,...fields}=row;
  const input=registerSkillSchema.safeParse({...fields,files:JSON.parse(String(files_json)),idempotency_key:"stored"});
  if(!input.success||typeof content_hash!=="string"||typeof created_at!=="string"
    ||await hashText(skillContentText(input.data.body,input.data.files))!==content_hash)
    throw new MemoryError("invalid_data","Stored skill content does not match its immutable version.");
  return {...input.data,content_hash,created_at};
}
export async function validateFiles(version:D1SkillVersion,raw:unknown) {
  const parsed=observationFilesSchema.safeParse(raw);
  if(!parsed.success)throw new MemoryError("invalid_data","Invalid bounded host file observations.");
  const files=parsed.data,expected=[{path:"SKILL.md",content:version.body},...version.files];
  if(JSON.stringify(files.map(f=>f.path).sort())!==JSON.stringify(expected.map(f=>f.path).sort()))
    throw new MemoryError("invalid_data","File observations must cover exactly the registered package.");
  for(const f of files) {
    const content=expected.find(e=>e.path===f.path)!.content,hash=await hashText(content);
    if(["matches","modified"].includes(f.state)?f.hash===null||f.bytes===null:f.hash!==null||f.bytes!==null)
      throw new MemoryError("invalid_data","File state and observed hash/size disagree.");
    if(f.state==="matches"&&(f.hash!==hash||f.bytes!==new TextEncoder().encode(content).length)
      ||f.state==="modified"&&f.hash===hash)throw new MemoryError("invalid_data","Observed status contradicts the package content.");
  }
  const state=files.some(f=>f.state==="unavailable")?"unavailable":files.some(f=>f.state==="missing")?"missing":files.some(f=>f.state==="modified")?"modified":"matches";
  return {files,state};
}
