import { MemoryError,type Mutation } from "../../../core/memory/model.js";
import type { WorkMutation } from "../../../core/work/model.js";
import { normalizeAlias,normalizeCodePath } from "../../../core/work/discovery.js";
import { rows,type Sql } from "./query.js";
import type { D1Binding } from "./binding.js";

export async function hasDiscoverySchema(db:D1Binding) {
  return (await rows(db,"SELECT name FROM sqlite_master WHERE type='table' AND name='feature_aliases'",[],1)).length===1;
}
export async function prepareD1Discovery(db:D1Binding,change:Mutation,entries:WorkMutation[]) {
  const declarations=entries.flatMap(e=>(e.features??[]).filter(f=>f.aliases!==undefined||f.code_paths!==undefined).map(f=>({entry:e,feature:f})));
  if(!declarations.length)return undefined;
  if(!await hasDiscoverySchema(db))throw new MemoryError("unsupported_capability","Apply the explicit D1 discovery schema first.");
  const [p]=await rows(db,"SELECT revision FROM projects WHERE id=?",[change.project.id],1);
  if((p?.["revision"]??null)!==change.expected_revision)return "conflict";
  const groups=new Map<string,{table:"feature_aliases"|"feature_code_paths";feature:string;repository:string;environment:string;values:Set<string>}>();
  for(const {entry,feature} of declarations) {
    const [saved]=await rows(db,"SELECT state,repository,environment FROM runs WHERE project_id=? AND id=?",[change.project.id,entry.run_id!],1);
    if(saved?saved["state"]!=="active":change.run?.id!==entry.run_id||change.run?.state!=="active")
      throw new MemoryError("scope_mismatch","Discovery metadata requires its own active task.");
    const repository=String(saved?.["repository"]??change.run!.repository),environment=String(saved?.["environment"]??change.run!.environment);
    for(const table of ["feature_aliases","feature_code_paths"] as const) {
      const key=JSON.stringify([table,feature.key,repository,environment]);
      const group=groups.get(key)??{table,feature:feature.key,repository,environment,values:new Set<string>()};
      for(const value of table==="feature_aliases"?(feature.aliases??[]).map(normalizeAlias):(feature.code_paths??[]).map(p=>normalizeCodePath(p)!))group.values.add(value);
      groups.set(key,group);
    }
  }
  // A permanent capacity limit is not a retryable revision conflict. The batch
  // guard below remains authoritative if another writer changes the scope.
  for(const g of groups.values()) {
    if(!g.values.size)continue;
    const field=g.table==="feature_aliases"?"normalized_alias":"path";
    const existing=await rows(db,`SELECT ${field} AS value FROM ${g.table} WHERE project_id=? AND feature_key=? AND repository=? AND environment=? LIMIT 65`,
      [change.project.id,g.feature,g.repository,g.environment],65);
    for(const row of existing)g.values.add(String(row["value"]));
    if(g.values.size>64)throw new MemoryError("resource_limit","D1 feature metadata capacity reached; existing declarations are retained.");
  }
  return (sql:Sql)=>{
    for(const {entry,feature:f} of declarations)for(const table of ["feature_aliases","feature_code_paths"] as const) {
      const values=table==="feature_aliases"?(f.aliases??[]).map(alias=>({value:alias,normalized:normalizeAlias(alias)}))
        :(f.code_paths??[]).map(path=>({value:normalizeCodePath(path)!,normalized:normalizeCodePath(path)!.toLowerCase()}));
      if(!values.length)continue;
      const fields=table==="feature_aliases"?"project_id,feature_key,repository,environment,alias,normalized_alias,source_run_id":"project_id,feature_key,repository,environment,path,normalized_path,source_run_id";
      sql(`INSERT INTO ${table}(${fields}) SELECT r.project_id,?,r.repository,r.environment,json_extract(j.value,'$.value'),
        json_extract(j.value,'$.normalized'),r.id FROM runs r JOIN json_each(?) j
        WHERE r.project_id=? AND r.id=? AND r.state='active' ON CONFLICT DO NOTHING`,f.key,JSON.stringify(values),change.project.id,entry.run_id!);
      sql(`INSERT INTO skilly_write_assertions(id,ok) VALUES(1,CASE WHEN EXISTS(SELECT 1 FROM runs WHERE project_id=? AND id=? AND state='active')
        AND (SELECT count(*) FROM ${table} m JOIN runs r ON r.project_id=m.project_id AND r.id=?
          WHERE m.project_id=? AND m.feature_key=? AND m.repository=r.repository AND m.environment=r.environment)<=64 THEN 1 ELSE 0 END)`,
        change.project.id,entry.run_id!,entry.run_id!,change.project.id,f.key);
      sql("DELETE FROM skilly_write_assertions WHERE id=1");
    }
  };
}
