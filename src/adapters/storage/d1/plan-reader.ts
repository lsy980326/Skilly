import { z } from "zod";
import { MemoryError, type JsonObject } from "../../../core/memory/model.js";
import { planItemsSchema, planProgress, planKey, criterionResultsSchema } from "../../../core/plans/model.js";
import type { D1Binding } from "./binding.js";
import { array, bounded, bytes, json, rows, scope, type D1Scope } from "./query.js";

const querySchema=z.strictObject({plan_key:planKey.optional(),version:z.int().min(1).max(100000).optional(),remaining_only:z.boolean().optional(),
  component:planKey.optional(),offset:z.int().min(0).max(100000).optional(),limit:z.int().min(1).max(10).optional()});
const updateProjection=`(SELECT json_group_array(json_object('key',json_extract(j.value,'$.key'),'update',json((
  SELECT json_object('id',u.id,'run_id',u.run_id,'record_id',u.record_id,'state',u.state,'note',u.note,'criteria_json',u.criteria_json,
    'created_at',u.created_at,'superseded_by',r.superseded_by,'task_title',substr(coalesce(d.title,t.goal),1,200),
    'task_title_truncated',length(coalesce(d.title,t.goal))>200,'task_state',t.state,'actor',a.actor)
  FROM plan_item_updates u JOIN records r ON r.project_id=u.project_id AND r.id=u.record_id
  JOIN runs t ON t.project_id=u.project_id AND t.id=u.run_id AND t.repository=u.repository AND t.environment=u.environment
  LEFT JOIN run_details d ON d.project_id=t.project_id AND d.run_id=t.id LEFT JOIN run_actors a ON a.run_id=t.id
  WHERE u.project_id=p.project_id AND u.repository=p.repository AND u.environment=p.environment AND u.plan_key=p.plan_key
    AND u.version=p.version AND u.item_key=json_extract(j.value,'$.key') ORDER BY u.seq DESC LIMIT 1))))
  FROM json_each(p.items_json) j) AS updates_json`;

function items(row:JsonObject) {
  if(typeof row["items_json"]!=="string")throw new MemoryError("invalid_data","Invalid plan definition.");
  const definitions=planItemsSchema.parse(JSON.parse(row["items_json"])),updates=array(row["updates_json"]);
  return definitions.map(item=>{
    const raw=updates.find(x=>x["key"]===item.key)?.["update"];
    const u=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw:null;
    const state=u?.["state"]==="completed"&&u["superseded_by"]!==null?"needs_review":String(u?.["state"]??"pending");
    return {...item,state,update_id:u?.["id"]??null,run_id:u?.["run_id"]??null,record_id:u?.["record_id"]??null,note:u?.["note"]??null,
      criteria_results:typeof u?.["criteria_json"]==="string"?criterionResultsSchema.parse(JSON.parse(u["criteria_json"])):[],
      task:u?{id:u["run_id"],title:u["task_title"],title_truncated:Boolean(u["task_title_truncated"]),state:u["task_state"],actor:u["actor"]}:null,
      evidence:{status:"unsupported",reason:"d1_execution_observations_not_implemented",claims_verified:false},claims_verified:false};
  });
}

/** One SQL per page/detail; originals and progress belong to the same read snapshot. */
export class D1PlanReader {
  private readonly scope:D1Scope;
  constructor(private readonly db:D1Binding,s:D1Scope){this.scope=scope(s);}
  async query(options:z.infer<typeof querySchema>={}):Promise<JsonObject> {
    const parsed=querySchema.safeParse(options);
    if(!parsed.success||(parsed.data.version!==undefined&&!parsed.data.plan_key))throw new MemoryError("invalid_input","Invalid bounded plan query.");
    const o=parsed.data,s=this.scope,values:(string|number|null)[]=[s.project_id,s.repository,s.environment];
    const filters=["p.project_id=?","p.repository=?","p.environment=?"];
    if(o.plan_key){filters.push("p.plan_key=?");values.push(o.plan_key);}
    if(o.version!==undefined){filters.push("p.version=?");values.push(o.version);}
    else filters.push("p.version=(SELECT MAX(v.version) FROM plan_versions v WHERE v.project_id=p.project_id AND v.repository=p.repository AND v.environment=p.environment AND v.plan_key=p.plan_key)");
    if(o.component==="unclassified")filters.push("NOT EXISTS(SELECT 1 FROM json_each(p.items_json) j WHERE json_extract(j.value,'$.component_key') IS NOT NULL)");
    else if(o.component){filters.push("EXISTS(SELECT 1 FROM json_each(p.items_json) j WHERE json_extract(j.value,'$.component_key')=?)");values.push(o.component);}
    const offset=o.plan_key?0:o.offset??0,limit=o.plan_key?1:o.limit??5;
    const detail=o.plan_key?`,(SELECT json_group_array(json(v)) FROM (SELECT json_object('version',version,'title',title,'source_hash',source_hash,'created_at',created_at) AS v
      FROM plan_versions v WHERE v.project_id=p.project_id AND v.repository=p.repository AND v.environment=p.environment AND v.plan_key=p.plan_key ORDER BY version DESC LIMIT 21)) AS versions_json,
      (SELECT json_group_array(json(v)) FROM (SELECT json_object('run_id',u.run_id,'report_count',count(DISTINCT u.record_id),'last_seq',max(u.seq)) AS v
        FROM plan_item_updates u WHERE u.project_id=p.project_id AND u.repository=p.repository AND u.environment=p.environment AND u.plan_key=p.plan_key AND u.version=p.version
        GROUP BY u.run_id ORDER BY max(u.seq) DESC LIMIT 21)) AS tasks_json`:"";
    const data=await rows(this.db,`SELECT p.*,${updateProjection},(SELECT revision FROM projects WHERE id=p.project_id) AS project_revision ${detail}
      FROM plan_versions p WHERE ${filters.join(" AND ")} ORDER BY p.created_at DESC,p.plan_key,p.version DESC LIMIT ? OFFSET ?`,[...values,limit+1,offset],limit+1);
    if(o.plan_key) {
      const row=data[0];if(!row)throw new MemoryError("not_found","Plan not found in this exact scope.");
      const all=items(row),versions=array(row["versions_json"]),tasks=array(row["tasks_json"]);
      const {items_json:_items,updates_json:_updates,versions_json:_versions,tasks_json:_tasks,project_revision,...plan}=row;
      return bounded(json({scope:s,project_revision,plan,items:o.remaining_only?all.filter(i=>i.state!=="completed"):all,progress:planProgress(all),
        versions:versions.slice(0,20),versions_truncated:versions.length>20,linked_tasks:{items:tasks.slice(0,20),truncated:tasks.length>20},
        source_path_verified:false,claims_verified:false,completion_meaning:"Reported conditions, not verified correctness."}));
    }
    const selected:JsonObject[]=[];
    const result:JsonObject={scope:json(s),items:selected,next_offset:null,pagination:"live_offset",claims_verified:false};
    for(const row of data.slice(0,limit)) {
      selected.push(json({plan_key:row["plan_key"],version:row["version"],title:row["title"],source_kind:row["source_kind"],source_hash:row["source_hash"],created_at:row["created_at"],progress:planProgress(items(row)),claims_verified:false}));
      if(bytes(result)>32*1024-200){selected.pop();if(!selected.length)selected.push({plan_key:row["plan_key"]!,version:row["version"]!,projection_truncated:true});break;}
    }
    if(data.length>selected.length){const next=offset+selected.length;if(next<=100000)result["next_offset"]=next;else {result["pagination_truncated"]=true;result["pagination_reason"]="offset_limit";}}
    return bounded(result,32*1024);
  }
}
