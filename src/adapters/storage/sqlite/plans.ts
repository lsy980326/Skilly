import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync, SQLInputValue, SQLOutputValue } from "node:sqlite";
import { MemoryError, parseJsonObject, type JsonObject } from "../../../core/memory/model.js";
import { completionAllowed, criterionResultsSchema, markdownItems, planItemsSchema, planProgress,
  planVersionRowSchema,planUpdateRowSchema,planExecutionLinkRowSchema, type PlanScope, type SavePlan, type UpdatePlan, type PlanItem } from "../../../core/plans/model.js";
import { assessFeatureKnowledge, type KnowledgeObservation } from "../../../core/work/knowledge.js";
import { sourceObservationSchema, type SourceProvider, type SourceObservation } from "../../../core/execution/currentness.js";
import { testDetailsSchema } from "../../../core/execution/test-details.js";

type Row=Record<string,SQLOutputValue>;
const hash=(text:string)=>createHash("sha256").update(text).digest("hex");
const json=(value:unknown)=>parseJsonObject(JSON.stringify(value));
function validateLinks(db:DatabaseSync,input:Pick<UpdatePlan,"project_id"|"repository"|"environment"|"run_id"|"record_id"|"execution_ids"|"state">,item:PlanItem,historical=false) {
    const record=db.prepare("SELECT * FROM records WHERE project_id=? AND id=? AND run_id=? AND repository=? AND environment=?")
      .get(input.project_id,input.record_id,input.run_id,input.repository,input.environment);
    if(!record)throw new MemoryError("scope_mismatch","The progress report must belong to the linked task and plan scope.");
    if(input.state==="completed"&&(record["report_origin"]!=="contemporaneous"||(!historical&&record["superseded_by"]!==null)))
      throw new MemoryError("invalid_evidence","Retrospective or superseded reports cannot establish a new completion report.");
    for(const [key,table,column] of [[item.component_key,"run_components","component_key"],[item.feature_key,"run_features","feature_key"]] as const)
      if(key&&!db.prepare(`SELECT 1 FROM ${table} WHERE project_id=? AND run_id=? AND ${column}=?`).get(input.project_id,input.run_id,key))
        throw new MemoryError("scope_mismatch","The task is not linked to this item's component or feature.");
    for(const id of input.execution_ids)if(!db.prepare("SELECT 1 FROM executions WHERE id=? AND project_id=? AND run_id=?").get(id,input.project_id,input.run_id))
      throw new MemoryError("scope_mismatch","Execution evidence must belong to this exact task.");
}
export class SqlitePlans {
  constructor(private readonly db:DatabaseSync,private readonly sources?:SourceProvider) {}
  private supported(){return Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"])>=11;}
  private project(id:string){if(!this.db.prepare("SELECT 1 FROM projects WHERE id=?").get(id))throw new MemoryError("not_found","Project not found.");}
  private task(input:PlanScope&{run_id:string}) {
    const r=this.db.prepare("SELECT * FROM runs WHERE project_id=? AND id=?").get(input.project_id,input.run_id);
    if(!r||r["repository"]!==input.repository||r["environment"]!==input.environment)throw new MemoryError("scope_mismatch","Plan task scope differs.");
    if(r["state"]!=="active")throw new MemoryError("run_closed","A plan write requires an active task.");
  }
  private write(input:{project_id:string;idempotency_key:string},operation:string,work:()=>JsonObject):JsonObject {
    const digest=hash(JSON.stringify({operation,input}));
    try{this.db.exec("BEGIN IMMEDIATE");}catch{throw new MemoryError("busy","Plan storage is busy. Retry the identical request; it is not queued.",true);}
    try {
      const receipt=this.db.prepare("SELECT payload_hash,result_json FROM receipts WHERE scope=? AND idempotency_key=?").get(input.project_id,input.idempotency_key);
      if(receipt){if(receipt["payload_hash"]!==digest)throw new MemoryError("idempotency_conflict","This key belongs to different input.");this.db.exec("COMMIT");return parseJsonObject(String(receipt["result_json"]));}
      this.project(input.project_id);
      const result=work();
      this.db.prepare("UPDATE projects SET revision=revision+1 WHERE id=?").run(input.project_id);
      this.db.prepare("INSERT INTO receipts VALUES(?,?,?,?)").run(input.project_id,input.idempotency_key,digest,JSON.stringify(result));
      this.db.exec("COMMIT");return result;
    }catch(error){if(this.db.isTransaction)this.db.exec("ROLLBACK");throw error;}
  }
  save(input:SavePlan):JsonObject {
    return this.write(input,"save-plan",()=>{
      this.task(input);
      const current=this.db.prepare("SELECT MAX(version) AS version FROM plan_versions WHERE project_id=? AND repository=? AND environment=? AND plan_key=?")
        .get(input.project_id,input.repository,input.environment,input.plan_key)?.["version"]??0;
      if(current!==input.expected_version)throw new MemoryError("plan_conflict","Read the latest plan version before saving a new version.");
      const items=input.items??(input.source_kind==="markdown"?markdownItems(input.source_body):undefined);
      if(!items)throw new MemoryError("invalid_input","Conversation plans require explicit items and completion conditions.");
      planItemsSchema.parse(items);
      for(const item of items)for(const [key,table] of [[item.component_key,"components"],[item.feature_key,"features"]] as const)
        if(key&&!this.db.prepare(`SELECT 1 FROM ${table} WHERE project_id=? AND key=?`).get(input.project_id,key))
          throw new MemoryError("not_found","Register the item's component or feature before linking it.");
      const version=Number(current)+1,sourceHash=hash(input.source_body),at=new Date().toISOString();
      if(!planVersionRowSchema.safeParse({project_id:input.project_id,repository:input.repository,environment:input.environment,plan_key:input.plan_key,version,title:input.title,source_kind:input.source_kind,source_ref:input.source_ref,source_body:input.source_body,source_hash:sourceHash,items_json:JSON.stringify(items),run_id:input.run_id,created_at:at}).success)
        throw new MemoryError("invalid_input","Encoded plan data exceeds the supported storage limit.");

      this.db.prepare("INSERT INTO plan_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run(input.project_id,input.repository,input.environment,input.plan_key,version,input.title,
        input.source_kind,input.source_ref,input.source_body,sourceHash,JSON.stringify(items),input.run_id,at);
      return {status:"persisted",plan_key:input.plan_key,version,source_hash:sourceHash,item_count:items.length,
        progress:json(planProgress(items.map(x=>({...x,state:"pending"})))),source_path_verified:false,claims_verified:false,recovery_queued:false};
    });
  }
  private version(scope:PlanScope,key:string,version?:number):Row {
    const params:SQLInputValue[]=[scope.project_id,key];
    const filters=["project_id=?","plan_key=?"];
    if(scope.repository!==undefined){filters.push("repository=?");params.push(scope.repository);}
    if(scope.environment!==undefined){filters.push("environment=?");params.push(scope.environment);}
    if(version!==undefined){filters.push("version=?");params.push(version);}
    const rows=this.db.prepare(`SELECT * FROM plan_versions WHERE ${filters.join(" AND ")} ORDER BY version DESC LIMIT 2`).all(...params);
    if(!rows.length)throw new MemoryError("not_found","Plan version not found in this scope.");
    // The viewer must select an exact repository/environment, never merge duplicate plan keys.
    return rows[0]!;
  }
  update(input:UpdatePlan):JsonObject {
    return this.write(input,"update-plan-item",()=>{
      this.task(input);
      const row=this.version(input,input.plan_key,input.version),items=planItemsSchema.parse(JSON.parse(String(row["items_json"])));
      const latest=this.version(input,input.plan_key);
      if(latest["version"]!==input.version)throw new MemoryError("plan_conflict","Only the latest plan version accepts new updates.");
      const item=items.find(x=>x.key===input.item_key);
      if(!item)throw new MemoryError("not_found","Plan item does not exist in this version.");
      if(new Set(input.criteria_results.map(x=>x.key)).size!==input.criteria_results.length||input.criteria_results.some(x=>!item.criteria.some(c=>c.key===x.key)))
        throw new MemoryError("invalid_input","Completion condition keys differ from this plan version.");
      const prior=this.db.prepare("SELECT id FROM plan_item_updates WHERE project_id=? AND repository=? AND environment=? AND plan_key=? AND version=? AND item_key=? ORDER BY seq DESC LIMIT 1")
        .get(input.project_id,input.repository,input.environment,input.plan_key,input.version,input.item_key);
      if((prior?.["id"]??null)!==input.expected_update_id)throw new MemoryError("plan_conflict","The item changed. Read it again before writing.");
      validateLinks(this.db,input,item);
      if(input.state==="completed")completionAllowed(item,input.criteria_results);
      const id=randomUUID(),at=new Date().toISOString();
      if(!planUpdateRowSchema.safeParse({id,project_id:input.project_id,repository:input.repository,environment:input.environment,plan_key:input.plan_key,version:input.version,item_key:input.item_key,run_id:input.run_id,record_id:input.record_id,state:input.state,note:input.note,criteria_json:JSON.stringify(input.criteria_results),created_at:at}).success)
        throw new MemoryError("invalid_input","Encoded condition reports exceed the supported storage limit.");
      this.db.prepare(`INSERT INTO plan_item_updates(id,project_id,repository,environment,plan_key,version,item_key,run_id,record_id,state,note,criteria_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,input.project_id,input.repository,input.environment,input.plan_key,input.version,input.item_key,input.run_id,input.record_id,input.state,input.note,JSON.stringify(input.criteria_results),at);
      for(const execution of new Set(input.execution_ids))this.db.prepare("INSERT INTO plan_update_executions VALUES(?,?,?)").run(input.project_id,id,execution);
      return {status:"persisted",update_id:id,plan_key:input.plan_key,version:input.version,item_key:input.item_key,state:input.state,claims_verified:false,recovery_queued:false};
    });
  }
  private item(row:Row,item:PlanItem,withEvidence:boolean,current=new Map<string,SourceObservation|undefined>()) {
    const update=this.db.prepare(`SELECT u.*,r.superseded_by,coalesce(d.title,t.goal) AS task_title,t.state AS task_state,a.actor AS task_actor,t.updated_at AS task_updated_at
      FROM plan_item_updates u JOIN records r ON r.project_id=u.project_id AND r.id=u.record_id
      JOIN runs t ON t.project_id=u.project_id AND t.id=u.run_id AND t.repository=u.repository AND t.environment=u.environment
      LEFT JOIN run_details d ON d.project_id=t.project_id AND d.run_id=t.id LEFT JOIN run_actors a ON a.run_id=t.id
      WHERE u.project_id=? AND u.repository=? AND u.environment=? AND u.plan_key=? AND u.version=? AND u.item_key=? ORDER BY u.seq DESC LIMIT 1`)
      .get(row["project_id"]!,row["repository"]!,row["environment"]!,row["plan_key"]!,row["version"]!,item.key);
    const state=update?.["state"]==="completed"&&update["superseded_by"]!==null?"needs_review":String(update?.["state"]??"pending");
    return { ...item,state,update_id:update?.["id"]??null,run_id:update?.["run_id"]??null,record_id:update?.["record_id"]??null,
      note:update?.["note"]??null,updated_at:update?.["created_at"]??null,
      criteria_results:update?criterionResultsSchema.parse(JSON.parse(String(update["criteria_json"]))):[],
      ...(withEvidence?{task:update?{id:update["run_id"],title:String(update["task_title"]).slice(0,200),state:update["task_state"],actor:update["task_actor"]??null,updated_at:update["task_updated_at"]}:null,
        evidence:this.evidence(update?String(update["id"]):undefined,current)}:{}),claims_verified:false };
  }
  private linkedTasks(row:Row) {
    const args=[row["project_id"]!,row["repository"]!,row["environment"]!,row["plan_key"]!,row["version"]!];
    // Include earlier contributors even when a later task replaces an item's latest report.
    const rows=this.db.prepare(`SELECT t.id,coalesce(d.title,t.goal) AS title,t.state,a.actor,t.updated_at,u.item_keys,u.report_count,u.linked_at,
      count(*) OVER () AS total FROM (
        SELECT run_id,MAX(seq) AS last_seq,MAX(created_at) AS linked_at,group_concat(DISTINCT item_key) AS item_keys,count(DISTINCT record_id) AS report_count
        FROM plan_item_updates WHERE project_id=? AND repository=? AND environment=? AND plan_key=? AND version=? GROUP BY run_id
      ) u JOIN runs t ON t.id=u.run_id AND t.project_id=? AND t.repository=? AND t.environment=?
      LEFT JOIN run_details d ON d.project_id=t.project_id AND d.run_id=t.id LEFT JOIN run_actors a ON a.run_id=t.id
      ORDER BY u.last_seq DESC,t.id LIMIT 20`).all(...args,row["project_id"]!,row["repository"]!,row["environment"]!);
    return {items:rows.map(r=>({id:r["id"],title:String(r["title"]).slice(0,200),state:r["state"],actor:r["actor"]??null,updated_at:r["updated_at"],
      item_keys:String(r["item_keys"]).split(","),report_count:Number(r["report_count"]),linked_at:r["linked_at"]})),
      total:Number(rows[0]?.["total"]??0),truncated:Number(rows[0]?.["total"]??0)>rows.length};
  }
  private evidence(updateId:string|undefined,current:Map<string,SourceObservation|undefined>) {
    const rows=updateId?this.db.prepare(`SELECT e.*,r.repository,r.environment FROM plan_update_executions l JOIN executions e ON e.id=l.execution_id AND e.project_id=l.project_id
      JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id WHERE l.update_id=? ORDER BY e.started_at,e.id LIMIT 4`).all(updateId):[];
    const observations:KnowledgeObservation[]=rows.map(row=>{
      const source=this.db.prepare("SELECT before_json,after_json FROM execution_sources WHERE project_id=? AND execution_id=?").get(row["project_id"]!,row["id"]!);
      const before=source?sourceObservationSchema.parse(JSON.parse(String(source["before_json"]))):undefined;
      const after=source?.["after_json"]?sourceObservationSchema.parse(JSON.parse(String(source["after_json"]))):undefined;
      if(before&&!current.has(before.root_hash))current.set(before.root_hash,this.sources?.(before));
      const detail=this.db.prepare("SELECT details_json FROM execution_test_details WHERE project_id=? AND execution_id=?").get(row["project_id"]!,row["id"]!);
      return {id:String(row["id"]),run_id:String(row["run_id"]),record_id:row["record_id"]===null?null:String(row["record_id"]),repository:String(row["repository"]),environment:String(row["environment"]),command_hash:String(row["command_hash"]),outcome:String(row["outcome"]),exit_code:row["exit_code"]===null?null:Number(row["exit_code"]),output_complete:Number(row["output_complete"]),
        ...(before?{before}:{}),...(after?{after}:{}),...(before&&current.get(before.root_hash)?{current:current.get(before.root_hash)!}:{}),test_details:detail?testDetailsSchema.parse(JSON.parse(String(detail["details_json"]))):{status:"not_collected",reason:"legacy"}};
    });
    const verdict=assessFeatureKnowledge(observations);
    return {linked:rows.length,status:verdict.status,reason:verdict.reason,counts:verdict.counts,
      observations:verdict.evidence.map(e=>({execution_id:e.execution_id,run_id:e.run_id,result:e.result,status:e.status,reason:e.reason,counts:e.counts})),claims_verified:false};
  }
  query(scope:PlanScope,options:{plan_key?:string|undefined;version?:number|undefined;query?:string|undefined;offset?:number|undefined;limit?:number|undefined;remaining_only?:boolean|undefined;sort?:ListSort|undefined}={}):JsonObject {
    this.project(scope.project_id);
    if(options.version!==undefined&&!options.plan_key)throw new MemoryError("invalid_input","A plan key is required for a version.");
    if(!Number.isSafeInteger(options.offset??0)||(options.offset??0)<0||(options.offset??0)>1000000||(options.query??"").length>200)throw new MemoryError("invalid_input","Invalid plan query.");
    if(!this.supported())return {items:[],next_offset:null,schema_supported:false,claims_verified:false};
    const filters=["p.project_id=?"],params:SQLInputValue[]=[scope.project_id];
    for(const field of ["repository","environment"] as const)if(scope[field]!==undefined){filters.push(`p.${field}=?`);params.push(scope[field]!);}
    if(options.plan_key) {
      if(!scope.repository||!scope.environment)throw new MemoryError("invalid_input","Select the plan's exact repository and environment.");
      const row=this.version(scope,options.plan_key,options.version),definitions=planItemsSchema.parse(JSON.parse(String(row["items_json"])));
      const current=new Map<string,SourceObservation|undefined>();
      const all=definitions.map(i=>this.item(row,i,true,current));
      const versions=this.db.prepare("SELECT version,title,source_hash,created_at FROM plan_versions WHERE project_id=? AND repository=? AND environment=? AND plan_key=? ORDER BY version DESC LIMIT 21")
        .all(scope.project_id,scope.repository,scope.environment,options.plan_key);
      return json({plan:{...row,items_json:undefined},items:options.remaining_only?all.filter(i=>i.state!=="completed"):all,
        progress:planProgress(all),linked_tasks:this.linkedTasks(row),versions:versions.slice(0,20),versions_truncated:versions.length>20,
        source_path_verified:false,claims_verified:false,completion_meaning:"Reported completion of this version's declared conditions, not verified feature correctness."});
    }
    const term=options.query??"",offset=options.offset??0,limit=options.limit??12;
    filters.push("p.version=(SELECT MAX(v.version) FROM plan_versions v WHERE v.project_id=p.project_id AND v.repository=p.repository AND v.environment=p.environment AND v.plan_key=p.plan_key)");
    filters.push("(instr(lower(p.title),lower(?))>0 OR instr(lower(p.plan_key),lower(?))>0 OR instr(lower(p.items_json),lower(?))>0)");params.push(term,term,term,limit+1,offset);
    const updateScope="u.project_id=p.project_id AND u.repository=p.repository AND u.environment=p.environment AND u.plan_key=p.plan_key AND u.version=p.version";
    const itemState=`coalesce((SELECT CASE WHEN u.state='completed' AND r.superseded_by IS NOT NULL THEN 'needs_review' ELSE u.state END
      FROM plan_item_updates u JOIN records r ON r.project_id=u.project_id AND r.id=u.record_id WHERE ${updateScope} AND u.item_key=json_extract(j.value,'$.key') ORDER BY u.seq DESC LIMIT 1),'pending')`;
    const required="coalesce(json_extract(j.value,'$.required'),1)=1";
    const active=`EXISTS(SELECT 1 FROM json_each(p.items_json) j WHERE ${required} AND ${itemState}<>'pending')
      AND EXISTS(SELECT 1 FROM json_each(p.items_json) j WHERE ${required} AND ${itemState}<>'completed')`;
    const order=listOrder(options.sort,{name:"p.title",date:`max(p.created_at,coalesce((SELECT max(u.created_at) FROM plan_item_updates u WHERE ${updateScope}),p.created_at))`,active,
      tie:"p.repository,p.environment,p.plan_key",fallback:`COALESCE((SELECT MAX(seq) FROM plan_item_updates u WHERE ${updateScope}),0) DESC,p.created_at DESC,p.repository,p.environment,p.plan_key`});
    const rows=this.db.prepare(`SELECT p.* FROM plan_versions p WHERE ${filters.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...params);
    return json({items:rows.slice(0,limit).map(row=>({plan_key:row["plan_key"],version:row["version"],title:row["title"],repository:row["repository"],environment:row["environment"],source_kind:row["source_kind"],created_at:row["created_at"],progress:planProgress(planItemsSchema.parse(JSON.parse(String(row["items_json"]))).map(i=>this.item(row,i,false)))})),next_offset:rows.length>limit?offset+limit:null,schema_supported:true,claims_verified:false});
  }
}

/** Validate imported rows without accepting imported commands or filesystem paths. */
export function validatePlanData(db:DatabaseSync):void {
  if(Number(db.prepare("PRAGMA user_version").get()?.["user_version"])<11)return;
  for(const row of db.prepare("SELECT * FROM plan_versions").iterate()) {
    planVersionRowSchema.parse(row);
    const definitions=planItemsSchema.parse(JSON.parse(String(row["items_json"])));
    for(const item of definitions)for(const [key,table] of [[item.component_key,"components"],[item.feature_key,"features"]] as const)if(key&&!db.prepare(`SELECT 1 FROM ${table} WHERE project_id=? AND key=?`).get(row["project_id"]!,key))throw new MemoryError("scope_mismatch","Imported plan classification missing.");
    if(hash(String(row["source_body"]))!==row["source_hash"])throw new MemoryError("invalid_data","Plan source hash mismatch.");
    const run=db.prepare("SELECT repository,environment FROM runs WHERE project_id=? AND id=?").get(row["project_id"]!,row["run_id"]!);
    if(!run||run["repository"]!==row["repository"]||run["environment"]!==row["environment"])throw new MemoryError("scope_mismatch","Plan source task scope mismatch.");
  }
  for(const raw of db.prepare("SELECT * FROM plan_item_updates").iterate()) {
    const {seq:_seq,...row}=raw;planUpdateRowSchema.parse(row);
    const plan=db.prepare("SELECT items_json FROM plan_versions WHERE project_id=? AND repository=? AND environment=? AND plan_key=? AND version=?").get(row["project_id"]!,row["repository"]!,row["environment"]!,row["plan_key"]!,row["version"]!);
    const item=plan?planItemsSchema.parse(JSON.parse(String(plan["items_json"]))).find(i=>i.key===row["item_key"]):undefined;
    if(!item)throw new MemoryError("invalid_data","Update references an absent plan item.");
    const results=criterionResultsSchema.parse(JSON.parse(String(row["criteria_json"])));
    if(results.some(x=>!item.criteria.some(c=>c.key===x.key))||new Set(results.map(x=>x.key)).size!==results.length)throw new MemoryError("invalid_data","Invalid completion condition references.");
    if(row["state"]==="completed")completionAllowed(item,results);
    const links=db.prepare("SELECT * FROM plan_update_executions WHERE update_id=?").all(row["id"]!);
    if(links.length>4)throw new MemoryError("invalid_data","Too many linked executions.");
    for(const link of links)planExecutionLinkRowSchema.parse(link);
    validateLinks(db,{project_id:String(row["project_id"]),repository:String(row["repository"]),environment:String(row["environment"]),run_id:String(row["run_id"]),record_id:String(row["record_id"]),execution_ids:links.map(x=>String(x["execution_id"])),state:row["state"] as UpdatePlan["state"]},item,true);
  }
  if(db.prepare(`SELECT 1 FROM plan_update_executions l JOIN plan_item_updates u ON u.id=l.update_id JOIN executions e ON e.id=l.execution_id
    WHERE l.project_id!=u.project_id OR l.project_id!=e.project_id OR u.run_id!=e.run_id LIMIT 1`).get())throw new MemoryError("scope_mismatch","Imported execution evidence scope mismatch.");
}
import { listOrder } from "./list-sort.js";
import type { ListSort } from "../../../core/viewer/sorting.js";
