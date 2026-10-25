import { z } from "zod";
import { MemoryError,type JsonObject } from "../../../core/memory/model.js";
import { assessFeatureKnowledge } from "../../../core/work/knowledge.js";
import type { SourceProvider } from "../../../core/execution/currentness.js";
import { D1Discovery } from "./discovery-reader.js";
import { hasExecutionSchema } from "./execution-mutation.js";
import { projectExecution,type CurrentSources } from "./execution-reader.js";
import { rows,json,scope,type D1Scope } from "./query.js";
import { readPage } from "./read-page.js";
import type { D1Binding } from "./binding.js";

export { featureQuerySchema } from "../../../core/work/feature-query.js";
import { featureQuerySchema } from "../../../core/work/feature-query.js";
export function taskComponent(alias:string,component:string|undefined):{sql:string;params:string[]} {
  if(component==="unclassified")return {sql:`AND NOT EXISTS(SELECT 1 FROM run_components rc WHERE rc.project_id=${alias}.project_id AND rc.run_id=${alias}.id)`,params:[]};
  return component?{sql:`AND EXISTS(SELECT 1 FROM run_components rc WHERE rc.project_id=${alias}.project_id AND rc.run_id=${alias}.id AND rc.component_key=?)`,params:[component]}:{sql:"",params:[]};
}
export class D1FeatureReader {
  private readonly scope:D1Scope;
  constructor(private readonly db:D1Binding,s:D1Scope,private readonly sources?:SourceProvider){this.scope=scope(s);}
  async list(raw:z.input<typeof featureQuerySchema>={}):Promise<JsonObject> {
    const parsed=featureQuerySchema.safeParse(raw);if(!parsed.success)throw new MemoryError("invalid_input","Invalid bounded feature search.");
    const q=parsed.data,s=this.scope,discovery=await D1Discovery.open(this.db,s),component=taskComponent("r",q.component),match=discovery.predicate("f",q.query);
    const data=await rows(this.db,`SELECT f.* FROM features f WHERE f.project_id=?
      AND EXISTS(SELECT 1 FROM run_features rf JOIN runs r ON r.project_id=rf.project_id AND r.id=rf.run_id
        WHERE rf.project_id=f.project_id AND rf.feature_key=f.key AND r.repository=? AND r.environment=? ${component.sql})
      ${q.feature?"AND f.key=?":""} AND ${match.sql} ORDER BY f.key LIMIT ? OFFSET ?`,
      [s.project_id,s.repository,s.environment,...component.params,...(q.feature?[q.feature]:[]),...match.params,q.limit+1,q.offset],q.limit+1);
    const current:CurrentSources=new Map(),supported=await hasExecutionSchema(this.db),items:JsonObject[]=[];
    for(const f of data.slice(0,q.limit))items.push({...f,discovery:await discovery.metadata(String(f["key"])),...await discovery.reasons(f,q.query),
      agent_report:await this.report(String(f["key"]),q.component),current_knowledge:await this.knowledge(String(f["key"]),q.component,supported,current),claims_verified:false});
    if(data.length>q.limit)items.push(data[q.limit]!);
    return readPage(items,q.offset,q.limit,{scope:json(s),discovery_schema_supported:discovery.supported,
      classification:"explicit_links_only",no_match_meaning:"No candidate in this bounded scope; not proof of feature absence or record completeness."});
  }
  private async report(key:string,component?:string):Promise<JsonObject|null> {
    const s=this.scope,c=taskComponent("t",component);
    const [row]=await rows(this.db,`SELECT r.id AS record_id,r.run_id,r.report_origin,r.recorded_at,j.value AS update_json
      FROM records r JOIN runs t ON t.project_id=r.project_id AND t.id=r.run_id
      JOIN run_features x ON x.project_id=r.project_id AND x.run_id=r.run_id JOIN record_reports p ON p.project_id=r.project_id AND p.record_id=r.id
      JOIN json_each(p.report_json,'$.feature_updates') j WHERE r.project_id=? AND r.repository=? AND r.environment=? AND t.repository=r.repository AND t.environment=r.environment
      AND x.feature_key=? AND json_extract(j.value,'$.key')=? AND r.report_origin='contemporaneous' AND r.superseded_by IS NULL ${c.sql}
      ORDER BY r.observed_at DESC,r.seq DESC LIMIT 1`,[s.project_id,s.repository,s.environment,key,key,...c.params],1);
    if(!row)return null;const {update_json,...rest}=row;
    return {...rest,update:typeof update_json==="string"?JSON.parse(update_json):null,provenance:"agent_report",claims_verified:false};
  }
  private async knowledge(key:string,component:string|undefined,supported:boolean,current:CurrentSources):Promise<JsonObject> {
    if(!supported)return json({...assessFeatureKnowledge([]),schema_supported:false,scanned:0,limit:40});
    const s=this.scope,c=taskComponent("r",component);
    const data=await rows(this.db,`SELECT e.*,r.repository,r.environment,p.project_key FROM executions e
      JOIN runs r ON r.project_id=e.project_id AND r.id=e.run_id JOIN projects p ON p.id=e.project_id
      JOIN run_features x ON x.project_id=r.project_id AND x.run_id=r.id
      WHERE e.project_id=? AND r.repository=? AND r.environment=? AND x.feature_key=? ${c.sql} ORDER BY e.started_at DESC,e.id DESC LIMIT 41`,
      [s.project_id,s.repository,s.environment,key,...c.params],41);
    const verdict=assessFeatureKnowledge(data.slice(0,40).map(e=>projectExecution(e,this.sources,current).observation),data.length>40);
    return json({...verdict,schema_supported:true,evidence:verdict.evidence.slice(0,8),evidence_truncated:verdict.evidence.length>8,
      conflicts:verdict.conflicts.slice(0,8).map(g=>({...g,execution_ids:g.execution_ids.slice(0,8),ids_truncated:g.execution_ids.length>8})),
      conflicts_truncated:verdict.conflicts.length>8,scanned:Math.min(40,data.length),limit:40});
  }
}
