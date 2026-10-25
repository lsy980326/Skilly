import { z } from "zod";
/** Archive fields have no execution or current-observation authority. */
export const storageOriginSchema=z.strictObject({project_id:z.uuid(),origin:z.enum(["sqlite","d1"]),
 table_name:z.string().regex(/^[a-z_]{1,40}$/),row_key:z.string().min(1).max(200),row_json:z.string().max(65536).refine(v=>{
 try {const x:unknown=JSON.parse(v);return x!==null&&typeof x==="object"&&!Array.isArray(x);} catch {return false;}
 },"Invalid archived row.")});
