import { z } from 'zod';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { InitializeRequestSchema,CallToolRequestSchema,ListToolsRequestSchema,PingRequestSchema,LATEST_PROTOCOL_VERSION,SUPPORTED_PROTOCOL_VERSIONS,isJSONRPCRequest } from '@modelcontextprotocol/sdk/types.js';
import { AccessError,accessScopeSchema } from '../../core/access/model.js';
import { MemoryError } from '../../core/memory/model.js';
import { D1AccessAuthenticator } from '../../adapters/auth/d1-access.js';
import { D1ProjectAccess } from '../../adapters/storage/d1/project-access.js';
import type { D1Binding } from '../../adapters/storage/d1/binding.js';
import { cloudInput,cloudResponse,cloudError } from '../cloud/server.js';
import { listCloudTools,callCloudTool,cloudMcpInstructions } from './cloud-tools.js';

const configSchema=z.strictObject({endpoint:z.url(),policy_id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),scope:accessScopeSchema});
export type CloudMcpConfig=z.infer<typeof configSchema>;
const envelope=z.strictObject({jsonrpc:z.literal('2.0'),id:z.union([z.string().min(1).max(100),z.int()]).optional(),method:z.string().max(80),params:z.unknown().optional()});
const errorCode=(e:unknown)=>e instanceof AccessError?e.code:e instanceof z.ZodError?'invalid_input':e instanceof MemoryError&&['conflict','idempotency_conflict','task_finished','project_write_blocked','scope_mismatch','resource_limit','persistence_unknown'].includes(e.code)?e.code:'request_failed';
const noStore=(response:Response)=>{const headers=new Headers(response.headers);headers.set('Cache-Control','no-store');headers.set('Pragma','no-cache');headers.set('X-Content-Type-Options','nosniff');return new Response(response.body,{status:response.status,headers});};
/** Standard SDK transport, deliberately limited to stateless JSON request/response methods. */
export function createCloudMcpHandler(db:D1Binding,raw:CloudMcpConfig){
 const config=configSchema.parse(structuredClone(raw)),endpoint=new URL(config.endpoint),authenticator=new D1AccessAuthenticator(db,config.policy_id);
 if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!==`/v1/projects/${config.scope.project_id}/mcp`
  ||(endpoint.protocol!=='https:'&&!(endpoint.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(endpoint.hostname))))throw new Error('Invalid fixed MCP endpoint.');
 let active=0;
 return async(request:Request):Promise<Response>=>{
  const url=new URL(request.url),origin=request.headers.get('Origin'),host=request.headers.get('Host');
  if(url.href!==endpoint.href||host!==endpoint.host||(origin!==null&&origin!==endpoint.origin))return cloudResponse({error:{code:'access_denied'}},403);
  if(active>=16)return cloudResponse({error:{code:'resource_limit'}},429);
  active++;let transport:WebStandardStreamableHTTPServerTransport|undefined;
  try{
   const auth=await authenticator.authenticate(request),permit=await new D1ProjectAccess(db).bind(auth.principal,config.scope,'read',()=>auth.assertFresh(),auth.credential);
   if(request.method!=='POST'){await permit.check();const response=cloudResponse({error:{code:'method_not_allowed'}},405);response.headers.set('Allow','POST');return response;}
   if(request.headers.has('Mcp-Session-Id')||request.headers.has('Last-Event-ID'))throw new MemoryError('invalid_input','Sessions and replay are not supported.');
   const body=envelope.parse(await cloudInput(request));
   if(body.id===undefined&&body.method!=='notifications/initialized')throw new MemoryError('invalid_input','Unsupported notification.');
   if(!['initialize','notifications/initialized','ping','tools/list','tools/call'].includes(body.method))throw new MemoryError('invalid_input','Unsupported method.');
   if(body.method==='notifications/initialized'&&(body.id!==undefined||body.params!==undefined))throw new MemoryError('invalid_input','Invalid initialization notification.');
   transport=new WebStandardStreamableHTTPServerTransport({enableJsonResponse:true,maxRequestBodySize:65536});
   const current=transport;
   let rejectTransport:(error:unknown)=>void=()=>{};
   const transportFailure=new Promise<never>((_,reject)=>{rejectTransport=reject;});
   // The SDK calls onmessage without awaiting it. Route callback failures to this request.
   current.onmessage=message=>{void (async()=>{
    if(!isJSONRPCRequest(message))return;
    try{
     let result:Record<string,unknown>;
     switch(message.method){
      case 'initialize':{const r=InitializeRequestSchema.parse(message);result={protocolVersion:SUPPORTED_PROTOCOL_VERSIONS.includes(r.params.protocolVersion)?r.params.protocolVersion:LATEST_PROTOCOL_VERSION,
       capabilities:{tools:{}},serverInfo:{name:'skilly-d1',version:'0.1.0'},instructions:cloudMcpInstructions};break;}
      case 'ping':PingRequestSchema.parse(message);result={};break;
      case 'tools/list':{const r=ListToolsRequestSchema.parse(message);if(r.params?.cursor)throw new MemoryError('invalid_input','No tool pagination.');result={tools:listCloudTools()};break;}
      case 'tools/call':{
       const r=CallToolRequestSchema.parse(message);if(r.params.task||r.params._meta)throw new MemoryError('invalid_input','Task extensions are not supported.');
       const value=await callCloudTool(db,auth,config.scope,r.params.name,r.params.arguments??{});
       result={content:[{type:'text',text:JSON.stringify(value)}]};break;
      }
      default:throw new MemoryError('invalid_input','Unsupported method.');
     }
     await permit.check();await current.send({jsonrpc:'2.0',id:message.id,result});
    }catch(e){
     const code=errorCode(e);
     await current.send(message.method==='tools/call'?{jsonrpc:'2.0',id:message.id,result:{isError:true,content:[{type:'text',text:JSON.stringify({error:{code},claims_verified:false})}]}}
      :{jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'Invalid request'}});
    }
   })().catch(rejectTransport);};
   await current.start();
   // Never forward credentials into the SDK's requestInfo or error paths.
   const headers=new Headers({'Content-Type':'application/json','Accept':request.headers.get('Accept')??''});
   const version=request.headers.get('Mcp-Protocol-Version');if(version)headers.set('Mcp-Protocol-Version',version);
   const response=await Promise.race([current.handleRequest(new Request(endpoint.href,{method:'POST',headers,body:JSON.stringify(body)})),transportFailure]);
   await permit.check();await auth.assertFresh();
   if(!response.ok)return cloudResponse({jsonrpc:'2.0',id:body.id??null,error:{code:-32600,message:'Invalid request'}},response.status);
   const text=await response.text();if(new TextEncoder().encode(text).length>65536)throw new MemoryError('resource_limit','Response limit reached; use the original receipt.');
   await permit.check();return noStore(new Response(text||null,{status:response.status,headers:response.headers}));
  }catch(e){return cloudError(e);}
  finally{try{if(transport)await transport.close();}finally{active--;}}
 };
}
