import { normalizeAlias,normalizeCodePath,pathMatches } from "../../../core/work/discovery.js";
import type { JsonObject } from "../../../core/memory/model.js";
import { rows,type D1Scope } from "./query.js";
import { hasDiscoverySchema } from "./discovery-mutation.js";
import type { D1Binding } from "./binding.js";

export class D1Discovery {
  constructor(private readonly db:D1Binding,private readonly scope:D1Scope,readonly supported:boolean){}
  static async open(db:D1Binding,s:D1Scope){return new D1Discovery(db,s,await hasDiscoverySchema(db));}
  predicate(alias:string,q:string) {
    const clauses=[`instr(lower(${alias}.name),lower(?))>0`,`instr(lower(${alias}.key),lower(?))>0`,`instr(lower(${alias}.description),lower(?))>0`];
    const params:(string|number|null)[]=[q,q,q],s=this.scope,path=normalizeCodePath(q)?.toLowerCase();
    if(this.supported) {
      clauses.push(`EXISTS(SELECT 1 FROM feature_aliases m WHERE m.project_id=${alias}.project_id AND m.feature_key=${alias}.key
        AND m.repository=? AND m.environment=? AND instr(m.normalized_alias,?)>0)`);params.push(s.repository,s.environment,normalizeAlias(q));
      if(path){clauses.push(`EXISTS(SELECT 1 FROM feature_code_paths m WHERE m.project_id=${alias}.project_id AND m.feature_key=${alias}.key
        AND m.repository=? AND m.environment=? AND (instr('/'||m.normalized_path||'/','/'||?||'/')>0 OR substr(?,1,length(m.normalized_path)+1)=m.normalized_path||'/'))`);
        params.push(s.repository,s.environment,path,path);}
    }
    return {sql:`(${clauses.join(" OR ")})`,params};
  }
  async metadata(key:string,q?:string):Promise<JsonObject> {
    const result:JsonObject={aliases:[],code_paths:[],truncated:false,schema_supported:this.supported,provenance:"explicit_feature_metadata",file_access:"not_performed"};
    if(!this.supported)return result;
    const s=this.scope,path=q===undefined?null:normalizeCodePath(q)?.toLowerCase();
    for(const kind of ["aliases","code_paths"] as const) {
      const params:(string|number|null)[]=[s.project_id,key,s.repository,s.environment];
      let condition="";
      if(q!==undefined) {
        if(kind==="aliases"){condition="AND instr(normalized_alias,?)>0";params.push(normalizeAlias(q));}
        else if(path){condition="AND (instr('/'||normalized_path||'/','/'||?||'/')>0 OR substr(?,1,length(normalized_path)+1)=normalized_path||'/')";params.push(path,path);}
        else continue;
      }
      const data=await rows(this.db,`SELECT ${kind==="aliases"?"alias":"path"} AS value,repository,environment,source_run_id
        FROM ${kind==="aliases"?"feature_aliases":"feature_code_paths"} WHERE project_id=? AND feature_key=? AND repository=? AND environment=? ${condition} ORDER BY value LIMIT 9`,params,9);
      result[kind]=data.slice(0,8);if(data.length>8)result["truncated"]=true;
    }
    return result;
  }
  async reasons(feature:JsonObject,q:string):Promise<JsonObject> {
    const reasons:JsonObject[]=[];
    if(!q)return {match_reasons:reasons,match_reasons_truncated:false};
    const base={feature_key:String(feature["key"]),feature_name:String(feature["name"])};
    // SQLite lower() folds ASCII; alias normalization is the explicit NFKC/Unicode route.
    const lower=(s:string)=>s.replace(/[A-Z]/g,c=>c.toLowerCase());
    for(const [kind,label,field] of [["feature_name","기능 이름","name"],["feature_key","기능 ID","key"],["feature_description","기능 설명","description"]]) {
      const value=String(feature[field!]??"");if(lower(value).includes(lower(q)))reasons.push({kind:kind!,label:label!,value,...base});
    }
    const m=await this.metadata(String(feature["key"]),q);
    for(const kind of ["aliases","code_paths"] as const) {
      const entries=m[kind];if(!Array.isArray(entries))continue;
      for(const row of entries)if(row&&typeof row==="object"&&!Array.isArray(row)) {
        if(kind==="code_paths"&&!pathMatches(String(row["value"]),q))continue;
        reasons.push({...row,...base,kind:kind==="aliases"?"feature_alias":"code_path",label:kind==="aliases"?"등록된 기능 별칭":"등록된 코드 경로"});
      }
    }
    return {match_reasons:reasons.slice(0,8),match_reasons_truncated:reasons.length>8||m["truncated"]===true};
  }
}
