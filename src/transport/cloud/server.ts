import { z } from 'zod';
import { AccessError,type Authenticator } from '../../core/access/model.js';
import { cloudRequestSchema } from '../../core/access/commands.js';
import { MemoryError } from '../../core/memory/model.js';
import { executeCloudCommand } from '../../adapters/storage/d1/cloud-session.js';
import type { D1Binding } from '../../adapters/storage/d1/binding.js';

const headers={'Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff'};
export function cloudResponse(value:unknown,status=200){return Response.json(value,{status,headers});}
export async function cloudInput(request:Request,signal?:AbortSignal){
 if(request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()!=='application/json')throw new MemoryError('invalid_input','JSON required.');
 const reader=request.body?.getReader();if(!reader)throw new MemoryError('invalid_input','Body required.');let size=0;const parts:Uint8Array[]=[];
 // A source's cancel promise can hang. Close the reader without waiting on that source.
 const cancel=()=>{void reader.cancel().catch(()=>{});};
 signal?.addEventListener('abort',cancel,{once:true});
 try{signal?.throwIfAborted();while(true){const r=await reader.read();signal?.throwIfAborted();if(r.done)break;size+=r.value.byteLength;if(size>65536){cancel();throw new MemoryError('resource_limit','Request too large.');}parts.push(r.value);}}
 finally{signal?.removeEventListener('abort',cancel);reader.releaseLock();}
 const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}catch{throw new MemoryError('invalid_input','JSON required.');}
}
export function cloudError(e:unknown){
 if(e instanceof AccessError)return cloudResponse({error:{code:e.code}},e.status);
 if(e instanceof z.ZodError)return cloudResponse({error:{code:'invalid_input'}},400);
 if(e instanceof MemoryError&&e.code==='unsupported_capability')return cloudResponse({error:{code:e.code}},501);
 if(e instanceof MemoryError){const status=e.code==='resource_limit'?413:e.code==='not_found'?404:e.code==='scope_mismatch'?403:['invalid_input','completion_conditions_missing','invalid_evidence'].includes(e.code)?400:['conflict','idempotency_conflict','task_finished','project_write_blocked','owner_conflict','plan_conflict'].includes(e.code)?409:503;
  return cloudResponse({error:{code:status===503?'storage_unavailable':e.code}},status);}
 return cloudResponse({error:{code:'request_failed'}},503);
}
/** Fetch handler only. No listener, deployment, account bootstrap, CORS or remote configuration. */
export function createCloudHandler(db:D1Binding,authenticator:Authenticator){
 return async(request:Request):Promise<Response>=>{try{
  const auth=await authenticator.authenticate(request);await auth.assertFresh();
  const url=new URL(request.url),match=/^\/v1\/projects\/([a-fA-F0-9-]{36})\/memory$/.exec(url.pathname);
  if(request.method!=='POST'||!match||url.search) return cloudResponse({error:{code:'not_found'}},404);
  const projectId=z.uuid().parse(match[1]),body=cloudRequestSchema.parse(await cloudInput(request)),command=body.command;
  const scope={project_id:projectId,repository:body.repository,environment:body.environment};
  return cloudResponse(await executeCloudCommand(db,auth,scope,command));
 }catch(e){
  return cloudError(e);
 }};
}
