import { realpathSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { listOrder } from "./list-sort.js";
import { componentWhere } from "./component-links.js";
import type { ListSort } from "../../../core/viewer/sorting.js";

/** Static classification SQL shared by UI and MCP; explicit declarations take precedence. */
export function recoveryClassification(version: number) {
  const declaration=`(SELECT json_group_array(json_object('key',json_extract(j.value,'$.key'),'name',json_extract(j.value,'$.name')))
    FROM (SELECT CASE WHEN type='object' THEN value ELSE '{}' END AS value FROM json_each(q.input_json,'$.components')) j
    WHERE json_type(j.value,'$.key')='text' AND json_type(j.value,'$.name')='text'
      AND length(json_extract(j.value,'$.name')) BETWEEN 1 AND 80 AND length(json_extract(j.value,'$.key')) BETWEEN 1 AND 80
      AND json_extract(j.value,'$.key') GLOB '[a-z0-9]*' AND json_extract(j.value,'$.key') NOT GLOB '*[^a-z0-9-]*'
      AND json_extract(j.value,'$.key')<>'unclassified')`;
  const linked=version>=4?`(SELECT json_group_array(json_object('key',c.key,'name',c.name)) FROM stored.runs r
    JOIN stored.run_components rc ON rc.project_id=r.project_id AND rc.run_id=r.id JOIN stored.components c ON c.project_id=rc.project_id AND c.key=rc.component_key
    WHERE r.project_id=q.project_id AND r.id=json_extract(q.input_json,'$.run_id') AND r.repository=q.repository AND r.environment=q.environment)` : "'[]'";
  const declared="json_type(q.input_json,'$.components')='array' AND json_array_length(q.input_json,'$.components')>0";
  return { components: `CASE WHEN ${declared} THEN ${declaration} WHEN q.input_json IS NOT NULL THEN ${linked} ELSE '[]' END`,
    source: `CASE WHEN ${declared} THEN 'request_declaration' WHEN q.input_json IS NOT NULL THEN 'stored_task' ELSE 'not_collected' END` };
}

/** The main path is host supplied; paths retained in requests are never followed. */
export function attachRecoverySource(journal: DatabaseSync, mainPath: string): number {
  const attached = journal.prepare("PRAGMA database_list").all().find(row => row["name"] === "stored");
  if (!attached) journal.prepare("ATTACH DATABASE ? AS stored").run(`${pathToFileURL(mainPath).href}?mode=ro`);
  else if (attached["file"] !== realpathSync(mainPath)) throw new Error("Recovery source changed.");
  return Number(journal.prepare("PRAGMA stored.user_version").get()?.["user_version"]);
}

/** Join only the host's already opened main DB. Stored request paths are never followed. */
export function recoveryRows(journal:DatabaseSync,mainPath:string,version:number,projectId:string,offset:number,limit:number,sort?:ListSort,component?:string) {
  attachRecoverySource(journal, mainPath);
  const classification = recoveryClassification(version);
  const selected=componentWhere(component,"SELECT 1 FROM json_each(component_json) c WHERE 1","json_extract(c.value,'$.key')");
  const order=listOrder(sort,{name:"coalesce(nullif(substr(json_extract(input_json,'$.goal'),1,200),''),tool)",date:"received_at",active:"0=1",tie:"id DESC",fallback:"received_at DESC,id DESC"});
  return journal.prepare(`WITH classified AS (SELECT q.*,
    ${classification.components} AS component_json,
    ${classification.source} AS component_source
    FROM requests q WHERE project_id=? AND (input_json IS NOT NULL OR last_error IS NOT NULL))
    SELECT id,tool,repository,environment,request_key,payload_hash,received_at,last_error,input_json IS NOT NULL AS retained,
      json_extract(input_json,'$.run_id') AS run_id,substr(json_extract(input_json,'$.goal'),1,200) AS goal,component_json,component_source
    FROM classified WHERE ${selected.sql} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(projectId,...selected.params,limit+1,offset);
}
