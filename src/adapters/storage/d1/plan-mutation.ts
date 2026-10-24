import { z } from "zod";
import { MemoryError, type Mutation } from "../../../core/memory/model.js";
import { savePlanFields, updatePlanFields, markdownItems, planItemsSchema, completionAllowed,
  planVersionRowSchema, planUpdateRowSchema } from "../../../core/plans/model.js";
import { d1ScopeSchema, hashText, rows, type Sql } from "./query.js";
import type { D1Binding } from "./binding.js";
import type { D1ExecutionChange } from "./execution-mutation.js";
import { hasExecutionSchema } from "./execution-mutation.js";

const task = { run_id:z.uuid(), idempotency_key:z.string().min(1).max(200) };
export const d1SavePlanSchema=z.strictObject({...savePlanFields,...task});
export const d1UpdatePlanSchema=z.strictObject({...updatePlanFields,...task});
const saveCommand=z.strictObject({operation:z.literal("save"),input:d1SavePlanSchema.extend(d1ScopeSchema.shape),created_at:z.iso.datetime()});
const updateCommand=z.strictObject({operation:z.literal("update"),input:d1UpdatePlanSchema.extend(d1ScopeSchema.shape),id:z.uuid(),created_at:z.iso.datetime()});
const command=z.discriminatedUnion("operation",[saveCommand,updateCommand]);
export type D1PlanChange=z.infer<typeof command>;
export type D1Mutation=Mutation & {plan?:D1PlanChange;execution?:D1ExecutionChange};

/** Sidecar preparation is pure validation/read. Only the caller's original project CAS can commit it. */
export async function prepareD1Plan(db:D1Binding,change:D1Mutation):Promise<((sql:Sql,assertOne:()=>void)=>void)|"conflict"|undefined> {
  if(change.plan===undefined)return undefined;
  const parsed=command.safeParse(change.plan);
  if(!parsed.success)throw new MemoryError("invalid_input","Invalid D1 plan command.");
  if(change.run||change.record||change.records||change.work||change.reports||change.decision||change.skill_usage||change.execution)
    throw new MemoryError("invalid_input","Plan commands use their own atomic mutation and a previously saved task/report.");
  const c=parsed.data,i=c.input;
  if(i.project_id!==change.project.id||i.idempotency_key!==change.receipt.key)throw new MemoryError("scope_mismatch","Plan command and receipt scope differ.");
  const scope=[i.project_id,i.repository,i.environment,i.plan_key];
  if(c.operation==="save") {
    const input=c.input,items=input.items??(input.source_kind==="markdown"?markdownItems(input.source_body):undefined);
    if(!items)throw new MemoryError("invalid_input","Conversation plans require explicit items and criteria.");
    const itemsJson=JSON.stringify(items);
    const [saved]=await rows(db,`SELECT revision,
      coalesce((SELECT MAX(version) FROM plan_versions WHERE project_id=? AND repository=? AND environment=? AND plan_key=?),0) AS version,
      EXISTS(SELECT 1 FROM runs WHERE project_id=? AND id=? AND repository=? AND environment=? AND state='active') AS task_active,
      EXISTS(SELECT 1 FROM json_each(?) j WHERE
        (json_extract(j.value,'$.component_key') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM components WHERE project_id=p.id AND key=json_extract(j.value,'$.component_key')))
        OR (json_extract(j.value,'$.feature_key') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM features WHERE project_id=p.id AND key=json_extract(j.value,'$.feature_key')))) AS missing_links
      FROM projects p WHERE id=?`,[...scope,i.project_id,i.run_id,i.repository,i.environment,itemsJson,i.project_id],1);
    if(!saved)throw new MemoryError("not_found","Project not found.");
    if(saved["revision"]!==change.expected_revision)return "conflict";
    if(saved["version"]!==input.expected_version)throw new MemoryError("plan_conflict","Read the latest plan version; the expected version is unchanged.");
    if(!saved["task_active"]||saved["missing_links"])throw new MemoryError("scope_mismatch","An active task and registered plan classifications are required.");
    const version=input.expected_version+1,sourceHash=await hashText(input.source_body);
    const row={project_id:i.project_id,repository:i.repository,environment:i.environment,plan_key:i.plan_key,version,title:input.title,
      source_kind:input.source_kind,source_ref:input.source_ref,source_body:input.source_body,source_hash:sourceHash,items_json:itemsJson,run_id:i.run_id,created_at:c.created_at};
    if(!planVersionRowSchema.safeParse(row).success)throw new MemoryError("invalid_input","Encoded plan exceeds its storage limit.");
    return (sql,assertOne)=>{
      sql(`INSERT INTO plan_versions SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE
        coalesce((SELECT MAX(version) FROM plan_versions WHERE project_id=? AND repository=? AND environment=? AND plan_key=?),0)=?
        AND EXISTS(SELECT 1 FROM runs WHERE project_id=? AND id=? AND repository=? AND environment=? AND state='active')`,
      row.project_id,row.repository,row.environment,row.plan_key,row.version,row.title,row.source_kind,row.source_ref,row.source_body,row.source_hash,row.items_json,row.run_id,row.created_at,
      ...scope,input.expected_version,i.project_id,i.run_id,i.repository,i.environment);
      assertOne();
    };
  }
  const input=c.input;
  const [saved]=await rows(db,`SELECT revision,
    (SELECT MAX(version) FROM plan_versions WHERE project_id=? AND repository=? AND environment=? AND plan_key=?) AS latest,
    (SELECT items_json FROM plan_versions WHERE project_id=? AND repository=? AND environment=? AND plan_key=? AND version=?) AS items_json,
    (SELECT id FROM plan_item_updates WHERE project_id=? AND repository=? AND environment=? AND plan_key=? AND version=? AND item_key=? ORDER BY seq DESC LIMIT 1) AS previous,
    EXISTS(SELECT 1 FROM runs WHERE project_id=? AND id=? AND repository=? AND environment=? AND state='active') AS task_active,
    (SELECT report_origin FROM records WHERE project_id=? AND id=? AND run_id=? AND repository=? AND environment=?) AS origin,
    (SELECT superseded_by FROM records WHERE project_id=? AND id=?) AS superseded_by
    FROM projects WHERE id=?`,[...scope,...scope,input.version,...scope,input.version,input.item_key,
    i.project_id,i.run_id,i.repository,i.environment,i.project_id,input.record_id,i.run_id,i.repository,i.environment,i.project_id,input.record_id,i.project_id],1);
  if(!saved)throw new MemoryError("not_found","Project not found.");
  if(saved["revision"]!==change.expected_revision)return "conflict";
  if(saved["latest"]!==input.version)throw new MemoryError("plan_conflict","Only the latest plan version accepts progress.");
  if(saved["previous"]!==input.expected_update_id)throw new MemoryError("plan_conflict","The item changed; preserve the original expected update ID.");
  if(!saved["task_active"]||!saved["origin"])throw new MemoryError("scope_mismatch","Progress requires its own active task and saved report in the same scope.");
  const item=typeof saved["items_json"]==="string"?planItemsSchema.parse(JSON.parse(saved["items_json"])).find(x=>x.key===input.item_key):undefined;
  if(!item)throw new MemoryError("not_found","Plan item not found in this version.");
  if(new Set(input.criteria_results.map(x=>x.key)).size!==input.criteria_results.length||input.criteria_results.some(x=>!item.criteria.some(y=>y.key===x.key)))
    throw new MemoryError("invalid_input","Criteria must belong to this exact plan item.");
  if(input.state==="completed") {
    completionAllowed(item,input.criteria_results);
    if(saved["origin"]!=="contemporaneous"||saved["superseded_by"]!==null)throw new MemoryError("invalid_evidence","Historical or superseded reports cannot establish completion.");
  }
  const executionIds=[...new Set(input.execution_ids)];
  if(executionIds.length&&!await hasExecutionSchema(db))throw new MemoryError("unsupported_capability","D1 execution schema is not installed.");
  for(const id of executionIds) {
    const linked=await rows(db,`SELECT e.id FROM executions e JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id
      WHERE e.project_id=? AND e.id=? AND e.run_id=? AND r.repository=? AND r.environment=?`,
      [i.project_id,id,i.run_id,i.repository,i.environment],1);
    if(!linked.length)throw new MemoryError("scope_mismatch","Execution evidence must belong to this exact task and plan scope.");
  }
  const row={id:c.id,project_id:i.project_id,repository:i.repository,environment:i.environment,plan_key:i.plan_key,version:input.version,item_key:input.item_key,
    run_id:i.run_id,record_id:input.record_id,state:input.state,note:input.note,criteria_json:JSON.stringify(input.criteria_results),created_at:c.created_at};
  if(!planUpdateRowSchema.safeParse(row).success)throw new MemoryError("invalid_input","Encoded progress exceeds its storage limit.");
  return (sql,assertOne)=>{
    // Repeat mutable storage predicates INSIDE the receipt batch, even after snapshot validation.
    sql(`INSERT INTO plan_item_updates(id,project_id,repository,environment,plan_key,version,item_key,run_id,record_id,state,note,criteria_json,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE
      (SELECT MAX(version) FROM plan_versions WHERE project_id=? AND repository=? AND environment=? AND plan_key=?)=?
      AND (SELECT id FROM plan_item_updates WHERE project_id=? AND repository=? AND environment=? AND plan_key=? AND version=? AND item_key=? ORDER BY seq DESC LIMIT 1) IS ?
      AND EXISTS(SELECT 1 FROM runs WHERE project_id=? AND id=? AND repository=? AND environment=? AND state='active')
      AND EXISTS(SELECT 1 FROM records WHERE project_id=? AND id=? AND run_id=? AND repository=? AND environment=?
        AND (?<>'completed' OR (report_origin='contemporaneous' AND superseded_by IS NULL)))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM run_components WHERE project_id=? AND run_id=? AND component_key=?))
      AND (? IS NULL OR EXISTS(SELECT 1 FROM run_features WHERE project_id=? AND run_id=? AND feature_key=?))`,
    row.id,row.project_id,row.repository,row.environment,row.plan_key,row.version,row.item_key,row.run_id,row.record_id,row.state,row.note,row.criteria_json,row.created_at,
    ...scope,input.version,...scope,input.version,input.item_key,input.expected_update_id,
    i.project_id,i.run_id,i.repository,i.environment,i.project_id,input.record_id,i.run_id,i.repository,i.environment,input.state,
    item.component_key??null,i.project_id,i.run_id,item.component_key??null,item.feature_key??null,i.project_id,i.run_id,item.feature_key??null);
    assertOne();
    for(const id of executionIds) {
      sql(`INSERT INTO plan_update_executions SELECT ?,?,? WHERE EXISTS
        (SELECT 1 FROM executions e JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id
        WHERE e.project_id=? AND e.id=? AND e.run_id=? AND r.repository=? AND r.environment=?)`,
        i.project_id,c.id,id,i.project_id,id,i.run_id,i.repository,i.environment);
      assertOne();
    }
  };
}
