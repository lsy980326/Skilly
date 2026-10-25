import { z } from 'zod';
import { rowSchemas } from '../../../core/transfer/format.js';
import { eventRowSchemas } from '../../../core/transfer/events.js';
import { storageOriginSchema } from '../../../core/transfer/origins.js';
import { MemoryError,type JsonObject } from '../../../core/memory/model.js';
import { hashText,canonical } from './query.js';

/** Archive data can inform a historical view only after the same ownership checks as native rows. */
export async function validateTransferOrigins(data:JsonObject[],project:string,projectKey:string,native:Record<string,z.ZodType>){
 for(const raw of data){const a=storageOriginSchema.parse(raw),r=JSON.parse(a.row_json) as JsonObject;
  if(await hashText(canonical(r))!==a.row_key)throw new MemoryError('invalid_transfer','Archived row hash differs.');
  let schema:z.ZodType|undefined;
  if(a.origin==='sqlite'){
   if(a.table_name.startsWith('event_'))schema=Object.entries(eventRowSchemas).find(([key])=>key===a.table_name.slice(6))?.[1];
   else if(a.table_name!=='storage_origins')schema=Object.entries(rowSchemas).find(([key])=>key===a.table_name)?.[1];
   if(a.table_name==='records'||a.table_name==='plan_item_updates')schema=rowSchemas[a.table_name].extend({seq:z.int().positive()});
  }else schema=native[a.table_name];
  if(!schema)throw new MemoryError('invalid_transfer','Unknown archived table.');schema.parse(r);
  if(a.project_id!==project||('project_id' in r&&r['project_id']!==project)||('project_key' in r&&r['project_key']!==projectKey)||a.table_name==='projects'&&r['id']!==project)throw new MemoryError('scope_mismatch','Foreign archived project row.');
  if(a.table_name==='receipts'&&r['scope']!==project){
   const result=JSON.parse(String(r['result_json'])) as {project?:{id?:unknown}};
   if(!(a.origin==='sqlite'&&r['scope']==='registration'&&result.project?.id===project))throw new MemoryError('scope_mismatch','Foreign registration receipt.');
  }
 }
}
