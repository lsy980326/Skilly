import { nativeOnly,hasTransferSchema } from "./authority.js";
import { z } from "zod";
import { MemoryError,type JsonObject,parseJsonObject } from "../../../core/memory/model.js";
import { d1EventScopeSchema,eventCoverage,lastSavedSql,type D1EventScope } from "./event-model.js";
import { hasEventSchema } from "./event-mutation.js";
import { rows,array,bounded,json } from "./query.js";
import type { D1Binding } from "./binding.js";

function event(row:JsonObject):JsonObject {
  const {saved_json,...original}=row;
  return {...original,saved_during_event:typeof saved_json==="string"?parseJsonObject(saved_json):null,claims_verified:false};
}
async function sqliteHistory(db:D1Binding){
 const supported=(await rows(db,"SELECT name FROM sqlite_master WHERE name='storage_origins'",[],1)).length>0;
 return supported?{source:`CASE WHEN EXISTS(SELECT 1 FROM storage_origins o WHERE o.project_id=e.project_id AND o.origin='sqlite' AND o.table_name='event_events' AND json_extract(o.row_json,'$.id')=e.id) THEN 'sqlite_hook_history' ELSE 'd1_receive' END`,
 association:`coalesce((SELECT json_extract(o.row_json,'$.status') FROM storage_origins o WHERE o.project_id=e.project_id AND o.origin='sqlite' AND o.table_name='event_event_link_failures' AND json_extract(o.row_json,'$.event_id')=e.id LIMIT 1),e.association_status)`}:{source:"'d1_receive'",association:'e.association_status'};
}
const fields="e.id AS observation_id,e.seq,e.event,e.session_hash,e.turn_hash,e.source,e.tool_group,e.observed_at,e.received_at,e.association_status";
export class D1EventReader {
  protected readonly scope:D1EventScope;
  constructor(protected readonly db:D1Binding,s:D1EventScope){this.scope=d1EventScopeSchema.parse(s);}
  async observations(offset=0):Promise<JsonObject> {
    if(!Number.isSafeInteger(offset)||offset<0||offset>100000)throw new MemoryError("invalid_input","Invalid event page.");
    if(!await hasEventSchema(this.db))return {schema_supported:false,status:"unsupported",...eventCoverage};
    const native=await nativeOnly(this.db,"e","event"),history=await sqliteHistory(this.db);
    const s=this.scope,data=await rows(this.db,`SELECT ${fields},${history.source} AS snapshot_origin,${history.association} AS source_association_status,NOT (${native}) AS imported_history FROM lifecycle_events e
      WHERE project_id=? AND repository=? AND environment=? AND root_hash=? AND session_hash=? ORDER BY seq DESC LIMIT 21 OFFSET ?`,
      [s.project_id,s.repository,s.environment,s.root_hash,s.session_hash,offset],21);
    const next=offset+20;
    return bounded(json({schema_supported:true,status:data.length?"observations_available":"not_observed",items:data.slice(0,20).map(r=>({...r,imported_history:Boolean(r["imported_history"])})),
      next_offset:data.length>20&&next<=100000?next:null,pagination_truncated:data.length>20&&next>100000,
      pagination:"live_offset",work_record_saved:false,...eventCoverage}),64*1024);
  }
  async status(runId:string):Promise<JsonObject> {
    if(!z.uuid().safeParse(runId).success)throw new MemoryError("invalid_input","Invalid task ID.");
    const s=this.scope,supported=await hasEventSchema(this.db),native=await nativeOnly(this.db,"l","link"),imported=await hasTransferSchema(this.db);
    // All work/association/snapshot fields come from one business read, even across reconnects.
    const relation=`FROM lifecycle_events e JOIN event_task_snapshots x ON x.project_id=e.project_id AND x.event_id=e.id
      JOIN task_event_links l ON l.project_id=x.project_id AND l.id=x.link_id
      WHERE l.project_id=r.project_id AND l.run_id=r.id AND l.repository=r.repository AND l.environment=r.environment AND l.root_hash=?`;
    const history=await sqliteHistory(this.db);
    const projection=`json_object('snapshot_origin',${history.source},'source_association_status',${history.association},'observation_id',e.id,'seq',e.seq,'event',e.event,'session_hash',e.session_hash,'observed_at',e.observed_at,
      'received_at',e.received_at,'association_status',e.association_status,'saved_json',x.saved_json,'imported_history',json(CASE WHEN ${native} THEN 'false' ELSE 'true' END))`;
    const details=supported?`,(SELECT json_group_array(json(v)) FROM (SELECT ${projection} AS v ${relation} ORDER BY e.seq DESC LIMIT 21)) AS events_json,
      (SELECT ${projection} ${relation} AND e.event='Interrupt' ORDER BY e.seq DESC LIMIT 1) AS interruption_json,
      EXISTS(SELECT 1 FROM task_event_links l WHERE l.project_id=r.project_id AND l.run_id=r.id AND l.repository=r.repository
        AND l.environment=r.environment AND l.root_hash=?) AS has_history,
      EXISTS(SELECT 1 FROM task_event_links l WHERE l.project_id=r.project_id AND l.run_id=r.id AND l.repository=r.repository AND l.environment=r.environment AND l.root_hash=? AND ${native}) AS has_native_history,
      ((SELECT run_id FROM task_event_links l WHERE l.project_id=r.project_id AND l.repository=r.repository AND l.environment=r.environment
        AND l.root_hash=? AND l.session_hash=? AND ${native} ORDER BY seq DESC LIMIT 1)=r.id) AS current_binding`:"";
    const data=await rows(this.db,`SELECT r.id,r.state,
      ${lastSavedSql("r.project_id","r.id","context.read_at")} AS last_saved_json ${details}
      FROM runs r CROSS JOIN (SELECT ? AS read_at) context WHERE r.project_id=? AND r.id=? AND r.repository=? AND r.environment=?`,
      [...(supported?[s.root_hash,s.root_hash,s.root_hash,s.root_hash,s.root_hash,s.session_hash]:[]),new Date().toISOString(),s.project_id,runId,s.repository,s.environment],1);
    const row=data[0];if(!row)throw new MemoryError("not_found","Task not found in this exact scope.");
    const entries=supported?array(row["events_json"]):[];
    return bounded(json({run_id:runId,task_state:row["state"],last_saved:parseJsonObject(String(row["last_saved_json"])),
      schema_supported:supported,linkage:!supported?"unsupported":row["has_history"]&&!row["has_native_history"]?"imported_history":row["has_history"]?"explicit_agent_binding":"not_linked",
      imported_history_supported:imported,
      current_session_binding:Boolean(row["current_binding"]),events:entries.slice(0,20).map(event),
      latest_event:entries[0]?event(entries[0]):null,
      interruption:typeof row["interruption_json"]==="string"?event(parseJsonObject(row["interruption_json"])):null,
      history_truncated:entries.length>20,...eventCoverage,
      limitation:"Only received future events on an explicit active-task link are associated. Server receipt order is not physical event time or proof of completeness."}));
  }
}
