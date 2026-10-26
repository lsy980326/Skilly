import { InitializeResultSchema,CallToolResultSchema,ListToolsResultSchema,LATEST_PROTOCOL_VERSION,JSONRPCResponseSchema } from '@modelcontextprotocol/sdk/types.js';
import { remoteDestinationSchema,RemoteCallError,type RemoteDestination,type RemoteMcpConnection } from '../../core/access/remote-outbox.js';
import { parseJsonObject,type JsonObject } from '../../core/memory/model.js';

const known=new Set(['access_denied','authentication_required','invalid_input','not_found','conflict','idempotency_conflict','task_finished','project_write_blocked','scope_mismatch','resource_limit',
 'persistence_unknown','plan_conflict','completion_conditions_missing','invalid_evidence','unsupported_capability','stale_anchor','link_conflict','run_closed',
 'link_store_full','version_conflict','source_conflict','assignment_conflict','write_context_changed','request_failed','authorization_unavailable']);
/** Fixed stateless JSON MCP transport. No login, key files, redirects, queue or implicit retries. */
export class CloudMcpConnection implements RemoteMcpConnection {
 readonly destination:RemoteDestination;
 private active=0;
 private id=0;
 constructor(destination:RemoteDestination,private readonly credential:()=>Promise<string|undefined>,private readonly fetcher:typeof fetch=fetch,private readonly timeoutMs=5000){
  const parsed=remoteDestinationSchema.parse(structuredClone(destination));this.destination=Object.freeze({...parsed,scope:Object.freeze(parsed.scope)});
  Object.defineProperty(this,'destination',{value:this.destination,writable:false,configurable:false,enumerable:true});
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<25||timeoutMs>30000)throw new RemoteCallError('invalid_input');
 }
 async initialize(guard:()=>void=()=>{},deadline?:number){
  const result=InitializeResultSchema.safeParse(await this.request('initialize',{protocolVersion:LATEST_PROTOCOL_VERSION,capabilities:{},clientInfo:{name:'skilly-outbox',version:'1'}},guard,deadline));
  if(!result.success||result.data.protocolVersion!==LATEST_PROTOCOL_VERSION||!result.data.capabilities.tools)throw new RemoteCallError('unsupported_capability');
 }
 async call(name:string,args:JsonObject,guard:()=>void=()=>{},deadline?:number):Promise<JsonObject>{
  const value=await this.callValue(name,args,guard,deadline);if(value===null)throw new RemoteCallError('invalid_response');return value;
 }
 async callValue(name:string,args:JsonObject,guard:()=>void=()=>{},deadline?:number):Promise<JsonObject|null>{
  const result=CallToolResultSchema.safeParse(await this.request('tools/call',{name,arguments:args},guard,deadline));
  if(!result.success)throw new RemoteCallError('invalid_response');
  const content=result.data.content;
  if(content.length!==1||content[0]?.type!=='text')throw new RemoteCallError('invalid_response');
  let value:JsonObject;try{if(JSON.parse(content[0].text)===null&&!result.data.isError)return null;value=parseJsonObject(content[0].text);}catch{throw new RemoteCallError('invalid_response');}
  if(result.data.isError){const error=value['error'],code=error&&typeof error==='object'&&!Array.isArray(error)?error['code']:undefined;
   throw new RemoteCallError(typeof code==='string'&&known.has(code)?code:'request_failed');}
  return value;
 }
 async listTools(guard:()=>void=()=>{},deadline?:number){
  const result=ListToolsResultSchema.safeParse(await this.request('tools/list',{},guard,deadline));
  if(!result.success||result.data.nextCursor)throw new RemoteCallError('unsupported_capability');
  return result.data.tools;
 }
 private async request(method:string,params:JsonObject,guard:()=>void,cycleDeadline?:number):Promise<unknown>{
  if(this.active>=4)throw new RemoteCallError('connection_busy');
  const id=++this.id,body=JSON.stringify({jsonrpc:'2.0',id,method,params});
  if(new TextEncoder().encode(body).length>65536)throw new RemoteCallError('resource_limit');
  this.active++;const controller=new AbortController(),end=Math.min(performance.now()+this.timeoutMs,cycleDeadline??Infinity);let stopped=false,timer:ReturnType<typeof setTimeout>;
  const check=()=>{guard();if(stopped||performance.now()>=end)throw new RemoteCallError('connection_timeout');};
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,response:Response|undefined;
  const cancel=()=>{try{void (reader?reader.cancel():response?.body?.cancel())?.catch(()=>{});}catch{/* Cancellation never controls the request deadline. */}};
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{stopped=true;controller.abort();cancel();reject(new RemoteCallError('connection_timeout'));},Math.max(0,end-performance.now()));});
  const pending=(async()=>{
   try{
    check();const token=await this.credential();check();
    if(!token)throw new RemoteCallError('authentication_required',401);
    if(token.length>16384||!/^[A-Za-z0-9._-]+$/.test(token))throw new RemoteCallError('invalid_credential',401);
    response=await this.fetcher(this.destination.endpoint,{method:'POST',redirect:'error',signal:controller.signal,
     headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream','Mcp-Protocol-Version':LATEST_PROTOCOL_VERSION,'Cf-Access-Jwt-Assertion':token},body});check();
    if(response.status===401||response.status===403){throw new RemoteCallError(response.status===401?'authentication_required':'access_denied',response.status);}
    if(!response.ok){const retry=Number(response.headers.get('Retry-After'));
     throw new RemoteCallError(response.status===429?'rate_limited':response.status===413?'resource_limit':'remote_unavailable',response.status,Number.isFinite(retry)?Math.min(60000,Math.max(0,retry*1000)):0);}
    if(!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')||!response.body)throw new RemoteCallError('invalid_response');
    reader=response.body.getReader();const chunks:Uint8Array[]=[];let bytes=0;
    while(true){const r=await reader.read();check();if(r.done)break;bytes+=r.value.byteLength;if(bytes>65536)throw new RemoteCallError('resource_limit');chunks.push(r.value);}
    const data=new Uint8Array(bytes);let at=0;for(const chunk of chunks){data.set(chunk,at);at+=chunk.length;}
    let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(data));}catch{throw new RemoteCallError('invalid_response');}
    const message=JSONRPCResponseSchema.safeParse(raw);
    if(!message.success||message.data.id!==id||!('result' in message.data))throw new RemoteCallError('invalid_response');check();return message.data.result;
   }catch(e){if(e instanceof RemoteCallError)throw e;throw new RemoteCallError('connection_failed');}
   finally{cancel();if(reader)reader.releaseLock();}
  })();
  // A credential provider or fetch implementation can ignore cancellation. Keep its slot until it settles.
  const held=pending.finally(()=>{this.active--;});void held.catch(()=>{});
  try{return await Promise.race([held,deadline]);}finally{clearTimeout(timer!);}
 }
}
