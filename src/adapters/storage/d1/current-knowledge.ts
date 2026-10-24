import { z } from "zod";
import { MemoryError,type JsonObject } from "../../../core/memory/model.js";
import { workKey } from "../../../core/work/schema.js";
import { planProgress } from "../../../core/plans/model.js";
import type { SourceProvider,SourceObservation } from "../../../core/execution/currentness.js";
import { D1Decisions } from "./decisions.js";
import { D1PlanReader } from "./plan-reader.js";
import { D1FeatureReader } from "./feature-reader.js";
import { objects,pick,readPage } from "./read-page.js";
import { rows,bounded,json,scope,type D1Scope } from "./query.js";
import type { D1Binding } from "./binding.js";

const offset=z.int().min(0).max(100000).default(0);
const query=z.strictObject({component:workKey.optional(),limit:z.int().min(1).max(6).default(4),decisions_offset:offset,plans_offset:offset,features_offset:offset});
const clipped=(value:unknown,max:number)=>typeof value==="string"?value.slice(0,max):null;

/** Multi-read composition checked against monotonic project revisions, not a cross-query D1 transaction. */
export class D1CurrentKnowledge {
  private readonly scope:D1Scope;
  constructor(private readonly db:D1Binding,s:D1Scope,private readonly sources?:SourceProvider){this.scope=scope(s);}
  async query(raw:z.input<typeof query>={}):Promise<JsonObject> {
    const parsed=query.safeParse(raw);if(!parsed.success)throw new MemoryError("invalid_input","Invalid bounded current-context query.");
    const input=parsed.data,s=this.scope;
    // Cache actual host samples for the whole invocation, including revision retries.
    const samples=new Map<string,SourceObservation|undefined>();
    const provider:SourceProvider=before=>{
      const key=JSON.stringify([before.project_key,before.repository,before.environment,before.root_hash]);
      if(!samples.has(key))samples.set(key,this.sources?.(before));return samples.get(key);
    };
    for(let attempt=0;attempt<3;attempt++) {
      const p=await this.project();
      try {
        const sections=await this.read(input,provider);
        const after=await this.project();
        if(after["revision"]!==p["revision"])continue;
        return bounded({project_id:s.project_id,project_name:p["name"]!,project_revision:p["revision"]!,scope:json({...s,component:input.component??null}),...sections,
          snapshot:"revision_checked_multi_read",source_snapshot:"host_observation_per_root_not_database_atomic",completeness:"bounded_sections",
          claims_verified:false,agent_reports_promoted:false,
          meaning:"Decision applicability, reported plan progress and direct check compatibility are separate. Unreceived or unlinked work is unknown."});
      }catch(error) {
        // An old plan can disappear from the latest-only view while composition is in flight.
        const after=await this.project();if(after["revision"]!==p["revision"])continue;throw error;
      }
    }
    throw new MemoryError("conflict","Project changed during the bounded context read; no consistent context was returned.",true);
  }
  private async project() {
    const [p]=await rows(this.db,"SELECT name,revision FROM projects WHERE id=?",[this.scope.project_id],1);
    if(!p)throw new MemoryError("not_found","Project not found.");return p;
  }
  private async read(input:z.output<typeof query>,provider:SourceProvider):Promise<JsonObject> {
    const s=this.scope,tables=await rows(this.db,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('features','decision_events','plan_versions')",[],3);
    const has=(name:string)=>tables.some(t=>t["name"]===name),unsupported={status:"unsupported",schema_supported:false,claims_verified:false};
    let decisions:JsonObject=unsupported,plans:JsonObject=unsupported,checks:JsonObject=unsupported;
    if(has("decision_events")) {
      const filtered=input.component==="unclassified"?"AND d.component_key=''":input.component?"AND d.component_key=?":"";
      const subjects=await rows(this.db,`SELECT d.subject_key,d.component_key,d.feature_key,max(r.seq) AS last_seq FROM decision_events d
        JOIN records r ON r.project_id=d.project_id AND r.id=d.record_id WHERE d.project_id=? AND r.repository=? AND r.environment=? ${filtered}
        GROUP BY d.subject_key,d.component_key,d.feature_key ORDER BY last_seq DESC,d.subject_key,d.component_key,d.feature_key LIMIT ? OFFSET ?`,
        [s.project_id,s.repository,s.environment,...(input.component&&input.component!=="unclassified"?[input.component]:[]),input.limit+1,input.decisions_offset],input.limit+1);
      const items:JsonObject[]=[];
      for(const subject of subjects.slice(0,input.limit)) {
        const detail=await new D1Decisions(this.db,s).query({subject:String(subject["subject_key"]),
          ...(subject["component_key"]?{component_key:String(subject["component_key"])}:{}),...(subject["feature_key"]?{feature_key:String(subject["feature_key"])}:{})});
        items.push(pick(detail,["subject","component_key","feature_key","status","active_record_ids","active_ids_complete","active_choices","active_choices_truncated","events_total","truncated","claims_verified"]));
      }
      if(subjects.length>input.limit)items.push({subject:String(subjects[input.limit]!["subject_key"])});
      decisions=readPage(items,input.decisions_offset,input.limit,{schema_supported:true,authority:"agent_supplied_user_statement_not_authentication"});
    }
    if(has("plan_versions")) {
      const reader=new D1PlanReader(this.db,s,provider),page=await reader.query({offset:input.plans_offset,limit:input.limit,...(input.component?{component:input.component}:{})});
      const items:JsonObject[]=[];
      for(const plan of objects(page["items"])) {
        if(plan["projection_truncated"]){items.push(plan);continue;}
        const detail=await reader.query({plan_key:String(plan["plan_key"]),version:Number(plan["version"])}),all=objects(detail["items"]);
        const selected=input.component?all.filter(i=>input.component==="unclassified"?!i["component_key"]:i["component_key"]===input.component):all;
        const remaining=selected.filter(i=>i["state"]!=="completed");
        items.push({...plan,progress_scope:"whole_plan",selected_progress:json(planProgress(selected.map(i=>({required:i["required"]!==false,state:String(i["state"])})))),
          item_evidence:selected.slice(0,8).map(i=>pick(i,["key","state","run_id","record_id","evidence"])),item_evidence_truncated:selected.length>8,
          remaining_total:remaining.length,remaining_truncated:remaining.length>8,
          remaining_items:remaining.slice(0,8).map(i=>({...pick(i,["key","title","required","component_key","feature_key","state","run_id","record_id","task","evidence"]),
            note:clipped(i["note"],240),criteria:objects(i["criteria"]).slice(0,2).map(c=>{
              const r=objects(i["criteria_results"]).find(v=>v["key"]===c["key"]);
              return {key:c["key"]!,text:clipped(c["text"],160),reported_met:r?.["met"]??null,report_detail:clipped(r?.["detail"],160),claims_verified:false};
            }),criteria_truncated:objects(i["criteria"]).length>2})),claims_verified:false});
      }
      plans=readPage(items,input.plans_offset,input.limit,{schema_supported:true});
      // A minimal projection still consumes that plan. If all base rows were
      // consumed, keep the upstream cursor even when their detail was omitted.
      if(objects(plans["items"]).length===items.length){plans["next_offset"]=page["next_offset"]??null;plans["pagination_truncated"]=page["pagination_truncated"]??false;}
    }
    if(has("features")) {
      checks=await new D1FeatureReader(this.db,s,provider).list({offset:input.features_offset,limit:input.limit,...(input.component?{component:input.component}:{})});
    }
    return {decisions,plans,checks};
  }
}
