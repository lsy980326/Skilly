import { z } from 'zod';
import { AccessError,type Authenticator } from '../../core/access/model.js';
import { cloudRequestSchema } from '../../core/access/commands.js';
import { MemoryError } from '../../core/memory/model.js';
import { D1ProjectAccess } from '../../adapters/storage/d1/project-access.js';
import { D1CloudWork } from '../../adapters/storage/d1/cloud-work.js';
import { D1TaskReader } from '../../adapters/storage/d1/task-reader.js';
import { D1CurrentKnowledge } from '../../adapters/storage/d1/current-knowledge.js';
import type { D1Binding } from '../../adapters/storage/d1/binding.js';

const headers={'Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff'};
function response(value:unknown,status=200){return Response.json(value,{status,headers});}
async function input(request:Request){
 if(request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase()!=='application/json')throw new MemoryError('invalid_input','JSON required.');
 const reader=request.body?.getReader();if(!reader)throw new MemoryError('invalid_input','Body required.');let size=0;const parts:Uint8Array[]=[];
 try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>65536){await reader.cancel();throw new MemoryError('resource_limit','Request too large.');}parts.push(r.value);}}
 finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let at=0;for(const p of parts){bytes.set(p,at);at+=p.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}catch{throw new MemoryError('invalid_input','JSON required.');}
}
/** Fetch handler only. No listener, deployment, account bootstrap, CORS or remote configuration. */
export function createCloudHandler(db:D1Binding,authenticator:Authenticator){
 return async(request:Request):Promise<Response>=>{try{
  const auth=await authenticator.authenticate(request);auth.assertFresh();
  const url=new URL(request.url),match=/^\/v1\/projects\/([a-fA-F0-9-]{36})\/memory$/.exec(url.pathname);
  if(request.method!=='POST'||!match||url.search) return response({error:{code:'not_found'}},404);
  const projectId=z.uuid().parse(match[1]),body=cloudRequestSchema.parse(await input(request)),command=body.command;
  const scope={project_id:projectId,repository:body.repository,environment:body.environment},write=['begin','checkpoint','finish'].includes(command.operation);
  const permit=await new D1ProjectAccess(db).bind(auth.principal,scope,write?'write':'read',()=>auth.assertFresh());
  const work=new D1CloudWork(permit.binding,scope,auth.principal),reader=new D1TaskReader(permit.binding,scope);
  let result:unknown;
  switch(command.operation){
   case 'begin':case 'checkpoint':case 'finish':result=await work.write(command);break;
   case 'tasks':result=await reader.listTasks(command.input);break;
   case 'task':result=await reader.getTask(command.input.run_id);break;
   case 'record':result=await reader.getRecord(command.input.record_id);break;
   case 'context':result=await new D1CurrentKnowledge(permit.binding,scope).query();break;
   case 'receipt':result=await work.receipt(command.input.write_operation,command.input.idempotency_key);break;
  }
  await permit.check();auth.assertFresh();return response(result);
 }catch(e){
  if(e instanceof AccessError)return response({error:{code:e.code}},e.status);
  if(e instanceof z.ZodError)return response({error:{code:'invalid_input'}},400);
  if(e instanceof MemoryError){const status=e.code==='resource_limit'?413:e.code==='not_found'?404:e.code==='scope_mismatch'?403:e.code==='invalid_input'?400:['conflict','idempotency_conflict','task_finished','project_write_blocked'].includes(e.code)?409:503;
   return response({error:{code:status===503?'storage_unavailable':e.code}},status);}
  return response({error:{code:'request_failed'}},503);
 }};
}
