import { z } from "zod";
import { assessDecisions, decisionSchema, decisionRecordSchema, decisionSubjectSchema, validateDecision, MAX_DECISION_EVENTS, type Decision, type DecisionEvent } from "../../../core/decisions/model.js";
import { MemoryError, type Mutation, type JsonObject } from "../../../core/memory/model.js";
import type { D1Binding } from "./binding.js";
import { array, bounded, json, rows, scope, type D1Scope, type Sql } from "./query.js";
type Subject = z.infer<typeof decisionSubjectSchema>;

/** One primary SQL snapshot, including revision. Never pair old history with a later revision. */
async function snapshot(db: D1Binding, s: D1Scope, d: Pick<Decision,"subject"|"component_key"|"feature_key">) {
  const data = await rows(db, `SELECT p.revision,
      (SELECT CASE WHEN coalesce(sum(length(CAST(metadata_json AS BLOB))),0)<=100000 THEN
        json_group_array(json_object('id',id,'run_id',run_id,'seq',seq,'body',body,'recorded_at',recorded_at,
          'report_origin',report_origin,'decision',json(metadata_json))) ELSE NULL END FROM (
    SELECT r.id,r.run_id,r.seq,substr(r.body,1,1200) AS body,r.recorded_at,r.report_origin,d.metadata_json
    FROM decision_events d JOIN records r ON r.project_id=d.project_id AND r.id=d.record_id
    WHERE d.project_id=? AND r.repository=? AND r.environment=? AND d.subject_key=? AND d.component_key=? AND d.feature_key=?
    ORDER BY r.seq LIMIT 201)) AS events_json
    FROM projects p WHERE p.id=?`, [s.project_id,s.repository,s.environment,d.subject,d.component_key??"",d.feature_key??"",s.project_id],1);
  if (!data[0]) throw new MemoryError("not_found", "Project not found.");
  const events: DecisionEvent[] = array(data[0]["events_json"]).map(row=>({ record: decisionRecordSchema.parse(row), decision:decisionSchema.parse(row["decision"]) }));
  return { revision: data[0]["revision"], events:events.slice(0,MAX_DECISION_EVENTS), truncated:events.length>MAX_DECISION_EVENTS };
}

export async function prepareD1Decision(db: D1Binding, change: Mutation): Promise<((sql: Sql,assertOne:()=>void)=>void)|"conflict"|undefined> {
  if (change.decision === undefined) return undefined;
  const parsed=decisionSchema.safeParse(change.decision), r=change.record;
  if (!parsed.success || !r || r.kind!=="decision" || r.supersedes!==null || r.superseded_by!==null || r.source_fingerprint!==null || r.observed_at!==r.recorded_at
    || change.records?.some(extra=>extra.supersedes===r.id)) {
    throw new MemoryError("invalid_input", "Structured decisions require a new decision original without generic correction or supplied version/time.");
  }
  const d=parsed.data,s={project_id:r.project_id,repository:r.repository,environment:r.environment};
  const history=await snapshot(db,s,d);
  if (history.revision!==change.expected_revision) return "conflict";
  validateDecision(d,history.events,history.truncated,r.report_origin);
  const tasks=await rows(db, `SELECT state,
    EXISTS(SELECT 1 FROM run_components c WHERE c.project_id=r.project_id AND c.run_id=r.id AND c.component_key=?) AS component_link,
    EXISTS(SELECT 1 FROM run_features f WHERE f.project_id=r.project_id AND f.run_id=r.id AND f.feature_key=?) AS feature_link
    FROM runs r WHERE project_id=? AND id=? AND repository=? AND environment=?`,[d.component_key??"",d.feature_key??"",r.project_id,r.run_id,r.repository,r.environment],1);
  if (tasks[0]?.["state"]!=="active" || (change.run && change.run.state!=="active")
    || (d.component_key && !tasks[0]?.["component_link"]) || (d.feature_key && !tasks[0]?.["feature_link"])) {
    throw new MemoryError("scope_mismatch", "Declare decision scope on an active saved task first.");
  }
  return (sql,assertOne)=>{
    sql(`INSERT INTO decision_events SELECT ?,?,?,?,?,? WHERE EXISTS
      (SELECT 1 FROM records WHERE project_id=? AND id=? AND run_id=? AND kind='decision' AND supersedes IS NULL AND superseded_by IS NULL)`,
    r.project_id,r.id,d.subject,d.component_key??"",d.feature_key??"",JSON.stringify(d),r.project_id,r.id,r.run_id);
    assertOne();
  };
}

/** Exact-subject detail, not the synchronous SQLite reader or an authenticated HTTP route. */
export class D1Decisions {
  private readonly scope: D1Scope;
  constructor(private readonly db:D1Binding, s:D1Scope) { this.scope=scope(s); }
  async query(input:Subject):Promise<JsonObject> {
    const parsed=decisionSubjectSchema.safeParse(input);
    if (!parsed.success) throw new MemoryError("invalid_input","Select an exact decision subject and scope.");
    const d=parsed.data, history=await snapshot(this.db,this.scope,d), state=assessDecisions(history.events,history.truncated);
    const offset=d.history_offset??0, active=[...state.active.values()];
    const entries=[...history.events].reverse().slice(offset,offset+20).map(e=>({record_id:e.record.id,run_id:e.record.run_id,
      body:e.record.body,body_truncated:e.record.body.length>=1200,recorded_at:e.record.recorded_at,report_origin:e.record.report_origin,
      decision:Object.fromEntries(Object.entries(e.decision).filter(([key])=>key!=="expected_current_ids")),
      state:history.truncated?"unknown":state.states.get(e.record.id)??"unknown",claims_verified:false}));
    return bounded(json({scope:this.scope,subject:d.subject,component_key:d.component_key??null,feature_key:d.feature_key??null,
      project_revision:history.revision,status:state.status,active_record_ids:history.truncated?null:active.map(e=>e.record.id),active_ids_complete:!history.truncated,
      active_choices:history.truncated?[]:active.slice(0,8).map(e=>({record_id:e.record.id,choice_key:e.decision.choice_key})),active_choices_truncated:active.length>8,
      events_total:history.events.length,events_total_is_bounded:history.truncated,history_limit:MAX_DECISION_EVENTS,
      truncated:history.truncated,history:entries,history_next_offset:offset+entries.length<history.events.length?offset+entries.length:null,
      claims_verified:false,authority:"agent_supplied_user_statement_not_authentication",currentness:"explicit_decision_links_not_fact_verification"}));
  }
}
