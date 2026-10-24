import { z } from "zod";
import { MemoryError, type JsonObject } from "../../../core/memory/model.js";
import { executionRowSchema, executionProjection } from "../../../core/execution/model.js";
import { sourceObservationSchema, sourceProjection, compareExecutionSource, type SourceProvider, type SourceObservation } from "../../../core/execution/currentness.js";
import { testDetailsSchema } from "../../../core/execution/test-details.js";
import { assessFeatureKnowledge, type KnowledgeObservation } from "../../../core/work/knowledge.js";
import { bounded, bytes, json, rows, scope, type D1Scope } from "./query.js";
import { executionColumns, hasExecutionSchema } from "./execution-mutation.js";
import type { D1Binding } from "./binding.js";

export type CurrentSources=Map<string,SourceObservation|undefined>;
export type ExecutionDetails={items:JsonObject[];omitted_execution_ids:string[];truncated:boolean};
export function projectExecution(raw:JsonObject,sources?:SourceProvider,current:CurrentSources=new Map()) {
  const {test_details_json,source_before_json,source_after_json,repository,environment,project_key,detail_projection_truncated,...rest}=raw;
  const row=executionRowSchema.parse(rest),details=testDetailsSchema.parse(
    typeof test_details_json==="string"?JSON.parse(test_details_json):test_details_json);
  const before=typeof source_before_json==="string"?sourceObservationSchema.parse(JSON.parse(source_before_json)):undefined;
  const after=typeof source_after_json==="string"?sourceObservationSchema.parse(JSON.parse(source_after_json)):undefined;
  if((before&&(before.repository!==repository||before.environment!==environment||before.project_key!==project_key))
    ||(after&&(!before||after.root_hash!==before.root_hash||after.project_key!==before.project_key||after.repository!==before.repository||after.environment!==before.environment)))
    throw new MemoryError("invalid_data","Saved execution source scope is inconsistent.");
  if(before&&!current.has(before.root_hash)) {
    const value=sources?.(before);
    current.set(before.root_hash,value?sourceObservationSchema.parse(value):undefined);
  }
  const now=before?current.get(before.root_hash):undefined;
  const observation:KnowledgeObservation={...row,repository:String(repository),environment:String(environment),test_details:details,
    ...(before?{before}:{}),...(after?{after}:{}),...(now?{current:now}:{})};
  return {item:json({...executionProjection(row),test_details:details,...(detail_projection_truncated?{detail_projection_truncated:true}:{}),
    code_version:{before:sourceProjection(before),after:sourceProjection(after),current:sourceProjection(now),comparison:compareExecutionSource(before,after,now)}}),observation};
}

/** Embed exact linked observations in the plan's ONE business snapshot, not later replica reads. */
export function planExecutionIds():string {
  return `(SELECT json_group_array(execution_id) FROM (SELECT l.execution_id FROM plan_update_executions l
    JOIN executions e ON e.project_id=l.project_id AND e.id=l.execution_id WHERE l.project_id=u.project_id
    AND l.update_id=u.id AND e.run_id=u.run_id ORDER BY e.started_at,e.id LIMIT 5))`;
}
export function planExecutionProjection():string {
  // Bound intermediate SQL JSON too: a 20×4 join must not multiply escaped failure names.
  const limited=`length(CAST(e.test_details_json AS BLOB))>4096`;
  const summary=`CASE WHEN ${limited} AND json_extract(e.test_details_json,'$.status')='collected' THEN
    json_object('status','collected','framework',json_extract(e.test_details_json,'$.framework'),
    'counts',json_extract(e.test_details_json,'$.counts'),'suite_success',json(CASE WHEN json_extract(e.test_details_json,'$.suite_success') THEN 'true' ELSE 'false' END),
    'failures',json('[]'),'failures_truncated',json('true')) ELSE e.test_details_json END`;
  return `(SELECT json_group_array(json(v)) FROM (SELECT json_object(
    ${executionColumns.map(k=>`'${k}',e.${k}`).join(",")},
    'test_details_json',${summary},'detail_projection_truncated',${limited},'source_before_json',e.source_before_json,'source_after_json',e.source_after_json,
    'repository',t.repository,'environment',t.environment,'project_key',(SELECT project_key FROM projects WHERE id=e.project_id)) AS v
    FROM executions e JOIN runs t ON t.project_id=e.project_id AND t.id=e.run_id WHERE e.project_id=p.project_id
    AND t.repository=p.repository AND t.environment=p.environment AND EXISTS
      (SELECT 1 FROM plan_update_executions l JOIN plan_item_updates u ON u.project_id=l.project_id AND u.id=l.update_id
      WHERE l.execution_id=e.id AND l.project_id=p.project_id AND u.run_id=e.run_id AND u.repository=p.repository
      AND u.environment=p.environment AND u.plan_key=p.plan_key AND u.version=p.version
      AND EXISTS(SELECT 1 FROM json_each(p.items_json) j WHERE json_extract(j.value,'$.key')=u.item_key)
      AND u.seq=(SELECT MAX(last.seq) FROM plan_item_updates last WHERE last.project_id=u.project_id AND last.repository=u.repository
        AND last.environment=u.environment AND last.plan_key=u.plan_key AND last.version=u.version AND last.item_key=u.item_key))
    ORDER BY e.started_at,e.id LIMIT 81))`;
}
export function planEvidence(raw:JsonObject[],pool:ExecutionDetails,sources?:SourceProvider,current:CurrentSources=new Map(),missing=false) {
  const projections=raw.slice(0,4).map(x=>projectExecution(x,sources,current));
  const verdict=assessFeatureKnowledge(projections.map(x=>x.observation),raw.length>4||missing);
  for(const {item} of projections) {
    const id=String(item["id"]);
    if(pool.items.some(x=>x["id"]===id)||pool.omitted_execution_ids.includes(id))continue;
    pool.items.push(item);
    if(bytes(pool.items)>32*1024){pool.items.pop();pool.omitted_execution_ids.push(id);pool.truncated=true;}
    else if(item["detail_projection_truncated"]){pool.omitted_execution_ids.push(id);pool.truncated=true;}
  }
  // Repeated evidence on 20 plan items must not replicate source/details 80 times.
  const observations=verdict.evidence.map((e,index)=>({execution_id:e.execution_id,run_id:e.run_id,result:e.result,status:e.status,
    reason:e.reason,counts:e.counts,outcome:projections[index]!.observation.outcome,exit_code:projections[index]!.observation.exit_code}));
  return {linked:projections.length,status:verdict.status,reason:verdict.reason,counts:verdict.counts,
    conflicts:verdict.conflicts,observations,truncated:verdict.truncated,claims_verified:false,
    meaning:verdict.meaning,agent_reports_promoted:false};
}

/** Read-only host-scoped evidence. Current source comes only from a host provider, never query input. */
export class D1ExecutionReader {
  protected readonly scope:D1Scope;
  constructor(protected readonly db:D1Binding,s:D1Scope,private readonly sources?:SourceProvider){this.scope=scope(s);}
  async list(runId:string,offset=0):Promise<JsonObject> {
    if(!z.uuid().safeParse(runId).success||!Number.isSafeInteger(offset)||offset<0||offset>100000)
      throw new MemoryError("invalid_input","Invalid execution page.");
    if(!await hasExecutionSchema(this.db))return {items:[],schema_supported:false,coverage:"explicit_runner_only",claims_verified:false};
    const s=this.scope;
    const data=await rows(this.db,`SELECT e.*,r.repository,r.environment,p.project_key FROM executions e
      JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id JOIN projects p ON p.id=e.project_id
      WHERE e.project_id=? AND e.run_id=? AND r.repository=? AND r.environment=? ORDER BY e.started_at DESC,e.id DESC LIMIT 11 OFFSET ?`,
      [s.project_id,runId,s.repository,s.environment,offset],11);
    const current:CurrentSources=new Map(),items:JsonObject[]=[];
    const result:JsonObject={scope:json(s),items,next_offset:null,pagination:"live_offset",schema_supported:true,coverage:"explicit_runner_only",claims_verified:false};
    for(const row of data.slice(0,10)) {
      const item=projectExecution(row,this.sources,current).item;items.push(item);
      if(bytes(result)>64*1024-200){items.pop();if(!items.length)items.push({id:row["id"]!,projection_truncated:true,claims_verified:false});break;}
    }
    if(data.length>items.length){const next=offset+items.length;if(next<=100000)result["next_offset"]=next;
      else{result["pagination_truncated"]=true;result["pagination_reason"]="offset_limit";}}
    return bounded(result,64*1024);
  }
}
