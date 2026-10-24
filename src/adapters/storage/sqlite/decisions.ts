import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { assessDecisions, decisionSchema, decisionRecordSchema, MAX_DECISION_EVENTS, validateDecision, type Decision, type DecisionEvent, type DecisionQuery, type DecisionReader } from "../../../core/decisions/model.js";
import { MemoryError, parseJsonObject, type JsonObject } from "../../../core/memory/model.js";

const json = (value:unknown) => parseJsonObject(JSON.stringify(value));
export class SqliteDecisions implements DecisionReader {
  constructor(private readonly db:DatabaseSync) {}
  private supported() { return Number(this.db.prepare("PRAGMA user_version").get()?.["user_version"]) >= 13; }
  assertScope(project:string,run:string,decision:Decision) { assertDecisionScope(this.db,project,run,decision); }
  metadata(project:string,record:string) {
    if(!this.supported())return undefined;
    const row=this.db.prepare("SELECT metadata_json FROM decision_events WHERE project_id=? AND record_id=?").get(project,record);
    return row?decisionSchema.parse(JSON.parse(String(row["metadata_json"]))):undefined;
  }
  events(project:string,repository:string,environment:string,decision:Pick<Decision,"subject"|"component_key"|"feature_key">) {
    if(!this.supported())return {events:[],truncated:false};
    const rows=this.db.prepare(`SELECT r.*,d.metadata_json FROM decision_events d JOIN records r ON r.project_id=d.project_id AND r.id=d.record_id
      WHERE d.project_id=? AND r.repository=? AND r.environment=? AND d.subject_key=? AND d.component_key=? AND d.feature_key=? ORDER BY r.seq LIMIT ?`)
      .all(project,repository,environment,decision.subject,decision.component_key??"",decision.feature_key??"",MAX_DECISION_EVENTS+1);
    return {events:rows.slice(0,MAX_DECISION_EVENTS).map(row=>({record:decisionRecordSchema.parse(row),
      decision:decisionSchema.parse(JSON.parse(String(row["metadata_json"])))})),truncated:rows.length>MAX_DECISION_EVENTS};
  }
  query(input:DecisionQuery):JsonObject {
    this.db.exec("SAVEPOINT decision_read");
    try { return this.read(input); } finally { this.db.exec("RELEASE decision_read"); }
  }
  private read(input:DecisionQuery):JsonObject {
    if(!this.db.prepare("SELECT 1 FROM projects WHERE id=?").get(input.project_id))throw new MemoryError("not_found","Project not found.");
    if(!this.supported())return {items:[],next_offset:null,schema_supported:false,claims_verified:false};
    const conditions=["d.project_id=?"],params:SQLInputValue[]=[input.project_id];
    for(const key of ["repository","environment"] as const)if(input[key]){conditions.push(`r.${key}=?`);params.push(input[key]);}
    for(const [filter,col] of [[input.subject,"subject_key"],[input.component,"component_key"],[input.feature,"feature_key"]] as const)
      if(filter!==undefined){conditions.push(`d.${col}=?`);params.push(col==="component_key"&&filter==="unclassified"?"":filter);}
    if(input.query){conditions.push("(instr(lower(d.subject_key),lower(?))>0 OR instr(lower(json_extract(d.metadata_json,'$.title')),lower(?))>0)");params.push(input.query,input.query);}
    const subjects=this.db.prepare(`SELECT d.subject_key,d.component_key,d.feature_key,r.repository,r.environment,max(r.seq) AS latest,
      (SELECT name FROM components WHERE project_id=d.project_id AND key=d.component_key) AS component_name,
      (SELECT name FROM features WHERE project_id=d.project_id AND key=d.feature_key) AS feature_name
      FROM decision_events d JOIN records r ON r.project_id=d.project_id AND r.id=d.record_id WHERE ${conditions.join(" AND ")}
      GROUP BY d.subject_key,d.component_key,d.feature_key,r.repository,r.environment ORDER BY latest DESC LIMIT ? OFFSET ?`).all(...params,input.limit+1,input.offset);
    const items=subjects.slice(0,input.limit).map(row=>{
      const scope={subject:String(row["subject_key"]),...(row["component_key"]?{component_key:String(row["component_key"])}:{}),...(row["feature_key"]?{feature_key:String(row["feature_key"])}:{})};
      const {events,truncated}=this.events(input.project_id,String(row["repository"]),String(row["environment"]),scope);
      const state=assessDecisions(events,truncated),last=events.at(-1);
      const historyOffset=input.history_offset??0;
      const entries=(input.subject?[...events].reverse().slice(historyOffset,historyOffset+20):[]).map(e=>({record_id:e.record.id,run_id:e.record.run_id,seq:e.record.seq,
        body:e.record.body.slice(0,1200),body_truncated:e.record.body.length>1200,recorded_at:e.record.recorded_at,report_origin:e.record.report_origin,
        decision:Object.fromEntries(Object.entries(e.decision).filter(([key])=>key!=="expected_current_ids")),state:truncated?"unknown":state.states.get(e.record.id)??"unknown",claims_verified:false}));
      const active=[...state.active.values()];
      const item=json({...scope,repository:row["repository"],environment:row["environment"],component_name:row["component_name"]??null,feature_name:row["feature_name"]??null,title:last?.decision.title??scope.subject,status:state.status,
        active_record_ids:truncated||!input.subject?null:active.map(e=>e.record.id),active_ids_complete:!truncated&&Boolean(input.subject),active_choices:truncated?[]:active.slice(0,8).map(e=>({record_id:e.record.id,choice_key:e.decision.choice_key,summary:e.record.body.slice(0,300)})),
        active_choices_truncated:active.length>8,events_total:events.length,history:entries,history_truncated:events.length>entries.length,
        last_record_id:last?.record.id??null,updated_at:last?.record.recorded_at??null,truncated,claims_verified:false});
      while(entries.length&&Buffer.byteLength(JSON.stringify(item))>64*1024){entries.pop();item["history"]=json({entries})["entries"]!;}
      item["history_truncated"]=events.length>historyOffset+entries.length;
      item["history_next_offset"]=input.subject&&events.length>historyOffset+entries.length?historyOffset+entries.length:null;
      return item;
    });
    const bounded:JsonObject[]=[];
    for(const item of items){if(Buffer.byteLength(JSON.stringify([...bounded,item]))>80*1024)break;bounded.push(item);}
    return {items:bounded,next_offset:subjects.length>bounded.length?input.offset+bounded.length:null,schema_supported:true,claims_verified:false,
      authority:"agent_supplied_user_statement_not_authentication",currentness:"explicit_decision_links_not_fact_verification",history_limit:MAX_DECISION_EVENTS};
  }
}

/** Validate graph metadata on transfer without rewriting any record or trusting report claims. */
export function validateDecisionData(db:DatabaseSync) {
  if(Number(db.prepare("PRAGMA user_version").get()?.["user_version"])<13)return;
  const groups=new Map<string,DecisionEvent[]>();
  for(const row of db.prepare(`SELECT r.*,d.subject_key,d.component_key,d.feature_key,d.metadata_json FROM decision_events d
    JOIN records r ON r.project_id=d.project_id AND r.id=d.record_id ORDER BY r.seq`).iterate()) {
    const d=decisionSchema.parse(JSON.parse(String(row["metadata_json"])));
    if(row["kind"]!=="decision"||row["supersedes"]||row["superseded_by"]||d.subject!==row["subject_key"]
      ||(d.component_key??"")!==row["component_key"]||(d.feature_key??"")!==row["feature_key"])
      throw new MemoryError("invalid_data","Invalid decision record or scope.");
    const key=JSON.stringify([row["project_id"],row["repository"],row["environment"],d.subject,d.component_key??"",d.feature_key??""]);
    const previous=groups.get(key)??[];
    validateDecision(d,previous,false,String(row["report_origin"]));
    assertDecisionScope(db,String(row["project_id"]),String(row["run_id"]),d);
    previous.push({record:decisionRecordSchema.parse(row),decision:d});groups.set(key,previous);
  }
}

function assertDecisionScope(db:DatabaseSync,project:string,run:string,d:Decision) {
  for(const [value,table,column]of [[d.component_key,"run_components","component_key"],[d.feature_key,"run_features","feature_key"]] as const)
    if(value&&!db.prepare(`SELECT 1 FROM ${table} WHERE project_id=? AND run_id=? AND ${column}=?`).get(project,run,value))
      throw new MemoryError("scope_mismatch","Declare the decision component/feature on this task before recording.");
}
