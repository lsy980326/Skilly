import { type JsonObject,type JsonValue } from "../../../core/memory/model.js";
import { bounded,bytes } from "./query.js";

export function objects(value:JsonValue|undefined):JsonObject[] {
  return Array.isArray(value)?value.filter((v):v is JsonObject=>v!==null&&typeof v==="object"&&!Array.isArray(v)):[];
}
export function pick(row:JsonObject,keys:string[]):JsonObject {
  return Object.fromEntries(keys.filter(k=>row[k]!==undefined).map(k=>[k,row[k]!]));
}
/** Bounded projection with forward progress; omitted detail is never an empty complete verdict. */
export function readPage(items:JsonObject[],offset:number,limit:number,extra:JsonObject={},max=24*1024):JsonObject {
  const included:JsonObject[]=[];
  for(const item of items.slice(0,limit)) {
    if(bytes([...included,item])>max-1500)break;
    included.push(item);
  }
  if(!included.length&&items.length)included.push({...pick(items[0]!,["id","key","name","subject","component_key","feature_key","plan_key","version","progress","selected_progress"]),projection_truncated:true,claims_verified:false});
  const more=items.length>included.length,next=offset+included.length;
  return bounded({...extra,items:included,next_offset:more&&next<=100000?next:null,pagination_truncated:more&&next>100000,
    response_truncated:included.length<Math.min(limit,items.length)||included.some(i=>i["projection_truncated"]===true),pagination:"live_offset",claims_verified:false},max);
}
