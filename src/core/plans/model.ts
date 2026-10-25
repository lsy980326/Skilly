import { z } from "zod";
import { MemoryError } from "../memory/model.js";

export const planKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
export const planQuerySchema=z.strictObject({plan_key:planKey.optional(),version:z.int().min(1).max(100000).optional(),remaining_only:z.boolean().optional(),
  component:planKey.optional(),offset:z.int().min(0).max(100000).optional(),limit:z.int().min(1).max(10).optional()});
const text = (max: number) => z.string().trim().min(1).max(max);
export const criterionSchema = z.strictObject({ key: planKey, text: text(300) });
export const planItemSchema = z.strictObject({ key: planKey, title: text(200), required: z.boolean().default(true),
  component_key: planKey.optional(), feature_key: planKey.optional(), source_checked: z.boolean().default(false),
  criteria: z.array(criterionSchema).min(1).max(4) });
export const planItemsSchema = z.array(planItemSchema).min(1).max(20).superRefine((items, ctx) => {
  if (new Set(items.map(x => x.key)).size !== items.length) ctx.addIssue({code:"custom",message:"Duplicate item keys."});
  for (const item of items) if (new Set(item.criteria.map(x=>x.key)).size!==item.criteria.length)
    ctx.addIssue({code:"custom",message:"Duplicate criterion keys."});
});
export const criterionResultsSchema = z.array(z.strictObject({key:planKey,met:z.boolean(),detail:text(300)})).max(4);
export const planState = z.enum(["pending","in_progress","blocked","completed"]);
export type PlanItem = z.infer<typeof planItemSchema>;
export type CriterionResults = z.infer<typeof criterionResultsSchema>;
export const savePlanFields = {
  plan_key:planKey, expected_version:z.int().min(0).max(100000).default(0), title:text(200),
  source_kind:z.enum(["markdown","conversation"]), source_ref:text(300),
  source_body:z.string().min(1).max(24000).refine(x=>new TextEncoder().encode(x).byteLength<=48*1024 && x.trim().length>0),
  items:planItemsSchema.optional(),
};
export const updatePlanFields = {
  plan_key:planKey,version:z.int().min(1).max(100000),item_key:planKey,
  expected_update_id:z.uuid().nullable().default(null), record_id:z.uuid(),state:planState,note:text(800),
  criteria_results:criterionResultsSchema.default([]),execution_ids:z.array(z.uuid()).max(4).default([]),
};
export type SavePlan = z.output<z.ZodObject<typeof savePlanFields>> & {project_id:string;run_id:string;repository:string;environment:string;idempotency_key:string};
export type UpdatePlan = z.output<z.ZodObject<typeof updatePlanFields>> & {project_id:string;run_id:string;repository:string;environment:string;idempotency_key:string};
export type PlanScope = {project_id:string;repository?:string;environment?:string};

/** Parse only selected checklist text. Fenced examples are never executable plan items. */
export function markdownItems(body:string):PlanItem[] {
  let fence: {char:string;length:number}|undefined;
  const items:PlanItem[]=[];
  for(const line of body.split(/\r?\n/)) {
    const f=/^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if(f) {const mark=f[1]!;if(!fence)fence={char:mark[0]!,length:mark.length};else if(mark[0]===fence.char&&mark.length>=fence.length&&!f[2]!.trim())fence=undefined;continue;}
    if(fence)continue;
    const match=/^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if(match)items.push({key:`item-${items.length+1}`,title:match[2]!,required:true,source_checked:match[1]!.toLowerCase()==="x",criteria:[{key:"acceptance",text:match[2]!}]});
  }
  return planItemsSchema.parse(items);
}
export function completionAllowed(item:PlanItem,results:CriterionResults):void {
  if(results.length!==item.criteria.length || new Set(results.map(x=>x.key)).size!==results.length
    || item.criteria.some(x=>!results.some(r=>r.key===x.key&&r.met)))
    throw new MemoryError("completion_conditions_missing","Report each completion condition separately before reporting the item complete.");
}
export function planProgress(items:{required:boolean;state:string}[]) {
  const required=items.filter(x=>x.required),completed=required.filter(x=>x.state==="completed").length;
  return {required:required.length,completed_reported:completed,remaining:required.length-completed,
    in_progress:required.filter(x=>x.state==="in_progress").length,blocked:required.filter(x=>x.state==="blocked").length,
    optional:items.length-required.length,percent:required.length?Math.floor(completed*100/required.length):0,
    status:required.length&&completed===required.length?"completed_reported":required.some(x=>x.state==="blocked")?"blocked":required.some(x=>x.state!=="pending")?"in_progress":"not_started",
    basis:"agent_reports_and_declared_completion_conditions",claims_verified:false};
}

export const planVersionRowSchema=z.strictObject({project_id:z.uuid(),repository:text(100),environment:text(100),plan_key:planKey,version:z.int().min(1).max(100000),title:savePlanFields.title,
  source_kind:savePlanFields.source_kind,source_ref:savePlanFields.source_ref,source_body:savePlanFields.source_body,source_hash:z.string().regex(/^[a-f0-9]{64}$/),
  items_json:z.string().max(48000).refine(value=>{try{return planItemsSchema.safeParse(JSON.parse(value)).success;}catch{return false;}}),run_id:z.uuid(),created_at:z.iso.datetime()});
export const planUpdateRowSchema=z.strictObject({id:z.uuid(),project_id:z.uuid(),repository:text(100),environment:text(100),plan_key:planKey,version:z.int().min(1).max(100000),item_key:planKey,run_id:z.uuid(),record_id:z.uuid(),state:planState,note:updatePlanFields.note,
  criteria_json:z.string().max(6000).refine(value=>{try{return criterionResultsSchema.safeParse(JSON.parse(value)).success;}catch{return false;}}),created_at:z.iso.datetime()});
export const planExecutionLinkRowSchema=z.strictObject({project_id:z.uuid(),update_id:z.uuid(),execution_id:z.uuid()});
