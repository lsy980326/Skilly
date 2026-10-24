import { z } from "zod";
import { MemoryError } from "../../../core/memory/model.js";
import { executionRowSchema, type ExecutionRow } from "../../../core/execution/model.js";
import { sourceObservationSchema, type SourceObservation } from "../../../core/execution/currentness.js";
import { testDetailsSchema } from "../../../core/execution/test-details.js";
import { rows, d1ScopeSchema, type Sql } from "./query.js";
import type { D1Binding } from "./binding.js";
import type { D1Mutation } from "./plan-mutation.js";

const key=z.string().min(1).max(200),hash=z.string().regex(/^[a-f0-9]{64}$/);
export const executionStartSchema=z.strictObject({idempotency_key:key,run_id:z.uuid(),record_id:z.uuid().optional(),
  executable:z.string().regex(/^[a-zA-Z0-9._+-]{1,80}$/),command_hash:hash,source_observation:sourceObservationSchema.optional()});
// Keep the process DTO shared; command state transitions below are deliberately narrower.
const resultFields={outcome:z.enum(["exited","launch_failed","timed_out","interrupted"]),exit_code:z.int().nullable(),
  signal:z.string().max(80).nullable(),error_code:z.string().max(80).nullable(),duration_ms:z.int().nonnegative(),
  stdout_bytes:z.int().nonnegative(),stderr_bytes:z.int().nonnegative(),stdout_hash:hash.nullable(),stderr_hash:hash.nullable(),
  stdout_hashed_bytes:z.int().nonnegative(),stderr_hashed_bytes:z.int().nonnegative(),output_complete:z.union([z.literal(0),z.literal(1)])};
export const executionFinishSchema=z.strictObject({idempotency_key:key,execution_id:z.uuid(),result:z.strictObject(resultFields),
  details:testDetailsSchema.optional(),source_after:sourceObservationSchema.optional()});
const command=z.discriminatedUnion("operation",[
  z.strictObject({operation:z.literal("start"),input:executionStartSchema.extend(d1ScopeSchema.shape),id:z.uuid(),at:z.iso.datetime()}),
  z.strictObject({operation:z.literal("finish"),input:executionFinishSchema.extend(d1ScopeSchema.shape),at:z.iso.datetime()}),
]);
export type D1ExecutionChange=z.infer<typeof command>;
export const executionColumns=["id","project_id","run_id","record_id","source","executable","command_hash","started_at","ended_at","duration_ms","outcome","exit_code","signal","error_code","stdout_bytes","stderr_bytes","stdout_hash","stderr_hash","stdout_hashed_bytes","stderr_hashed_bytes","output_complete"] as const;

export async function hasExecutionSchema(db:D1Binding):Promise<boolean> {
  const result=await rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='executions'",[],1);
  return result.length===1;
}
function sameSource(a:SourceObservation,b:SourceObservation) {
  return a.root_hash===b.root_hash&&a.project_key===b.project_key&&a.repository===b.repository&&a.environment===b.environment;
}
export async function prepareD1Execution(db:D1Binding,change:D1Mutation):Promise<((sql:Sql,assertOne:()=>void)=>void)|"conflict"|undefined> {
  if(change.execution===undefined)return undefined;
  const parsed=command.safeParse(change.execution);
  if(!parsed.success)throw new MemoryError("invalid_input","Invalid host execution observation.");
  if(change.run||change.record||change.records||change.work||change.reports||change.decision||change.plan||change.lifecycle||change.skill)
    throw new MemoryError("invalid_input","Runner observations use a separate internal command, never an AI report mutation.");
  const c=parsed.data,i=c.input;
  if(i.project_id!==change.project.id||i.idempotency_key!==change.receipt.key)throw new MemoryError("scope_mismatch","Observation and receipt scope differ.");
  if(!await hasExecutionSchema(db))throw new MemoryError("unsupported_capability","Apply the explicit D1 execution schema before runner storage.");
  if(c.operation==="start") {
    const input=c.input;
    const [saved]=await rows(db,`SELECT p.revision,p.project_key,r.state,
      (? IS NULL OR EXISTS(SELECT 1 FROM records WHERE project_id=p.id AND run_id=r.id AND id=? AND repository=r.repository AND environment=r.environment)) AS record_valid
      FROM projects p JOIN runs r ON r.project_id=p.id WHERE p.id=? AND r.id=? AND r.repository=? AND r.environment=?`,
      [input.record_id??null,input.record_id??null,i.project_id,input.run_id,i.repository,i.environment],1);
    if(!saved||saved["state"]!=="active"||!saved["record_valid"])throw new MemoryError("scope_mismatch","Start requires its own active saved task and optional record.");
    if(saved["revision"]!==change.expected_revision)return "conflict";
    const source=input.source_observation;
    if(source&&(source.project_key!==saved["project_key"]||source.repository!==i.repository||source.environment!==i.environment))
      throw new MemoryError("scope_mismatch","Source observation differs from the host scope.");
    const row:ExecutionRow=executionRowSchema.parse({id:c.id,project_id:i.project_id,run_id:input.run_id,record_id:input.record_id??null,
      source:"local_runner",executable:input.executable,command_hash:input.command_hash,started_at:c.at,ended_at:null,duration_ms:null,
      outcome:"unconfirmed",exit_code:null,signal:null,error_code:null,stdout_bytes:0,stderr_bytes:0,stdout_hash:null,stderr_hash:null,
      stdout_hashed_bytes:0,stderr_hashed_bytes:0,output_complete:1});
    return (sql,assertOne)=>{
      sql(`INSERT INTO executions(${executionColumns.join(",")},test_details_json,source_before_json,source_after_json)
        SELECT ${executionColumns.map(()=>"?").join(",")},?,?,NULL WHERE EXISTS
        (SELECT 1 FROM runs WHERE project_id=? AND id=? AND repository=? AND environment=? AND state='active')
        AND (? IS NULL OR EXISTS(SELECT 1 FROM records WHERE project_id=? AND run_id=? AND id=? AND repository=? AND environment=?))`,
        ...executionColumns.map(k=>row[k]),JSON.stringify({status:"not_collected",reason:"unfinished"}),source?JSON.stringify(source):null,
        i.project_id,input.run_id,i.repository,i.environment,input.record_id??null,i.project_id,input.run_id,input.record_id??null,i.repository,i.environment);
      assertOne();
    };
  }
  const input=c.input;
  const [saved]=await rows(db,`SELECT e.*,p.revision FROM executions e JOIN projects p ON p.id=e.project_id
    JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id WHERE e.project_id=? AND e.id=? AND r.repository=? AND r.environment=?`,
    [i.project_id,input.execution_id,i.repository,i.environment],1);
  if(!saved)throw new MemoryError("scope_mismatch","Observation belongs to a different task scope.");
  if(saved["revision"]!==change.expected_revision)return "conflict";
  if(saved["ended_at"]!==null)throw new MemoryError("conflict","Observation is finalized; retry only the original finish request, never the process.");
  const identity=Object.fromEntries(executionColumns.map(k=>[k,saved[k]]));
  const complete=executionRowSchema.safeParse({...identity,...input.result,ended_at:c.at});
  if(!complete.success||c.at<String(saved["started_at"]))throw new MemoryError("invalid_input","Inconsistent final process observation.");
  const details=input.details??{status:"not_collected",reason:"unsupported_command"};
  if(details.status==="collected"&&(input.result.outcome!=="exited"||input.result.output_complete!==1))
    throw new MemoryError("invalid_input","Incomplete execution cannot have a collected final test summary.");
  if(input.source_after) {
    const before=typeof saved["source_before_json"]==="string"?sourceObservationSchema.parse(JSON.parse(saved["source_before_json"])):undefined;
    if(!before||!sameSource(before,input.source_after))throw new MemoryError("scope_mismatch","After-source observation differs from before-source scope.");
  }
  const fields=["ended_at",...Object.keys(resultFields)] as (keyof ExecutionRow)[];
  return (sql,assertOne)=>{
    sql(`UPDATE executions SET ${fields.map(k=>`${k}=?`).join(",")},test_details_json=?,source_after_json=?
      WHERE project_id=? AND id=? AND ended_at IS NULL AND EXISTS
      (SELECT 1 FROM runs WHERE project_id=executions.project_id AND id=executions.run_id AND repository=? AND environment=?)`,
      ...fields.map(k=>complete.data[k]),JSON.stringify(details),input.source_after?JSON.stringify(input.source_after):null,
      i.project_id,input.execution_id,i.repository,i.environment);
    assertOne();
  };
}
