import type { D1Binding,D1Statement } from '../../adapters/storage/d1/binding.js';
import { cloudError,cloudResponse } from '../cloud/server.js';

type StopReason='request_timeout'|'storage_timeout'|'request_aborted'|'storage_busy';
class RequestStopped extends Error {
 constructor(readonly reason:StopReason){super(reason);}
}

/** Request termination does not cancel a native D1 promise or undo a submitted batch. */
export class CloudRequest {
 private readonly end:number;
 private readonly timer:ReturnType<typeof setTimeout>;
 private rejectStop!:(error:RequestStopped)=>void;
 private readonly stopped:Promise<never>;
 private readonly controller=new AbortController();
 private readonly onAbort=()=>this.stop('request_aborted');
 private terminal:RequestStopped|undefined;
 private closed=false;
 writeDispatched=false;
 constructor(private readonly request:Request,timeoutMs:number,readonly storageTimeoutMs:number){
  this.end=performance.now()+timeoutMs;
  this.stopped=new Promise<never>((_,reject)=>{this.rejectStop=reject;});
  // Some failures precede the first awaited operation; the original promise still rejects.
  void this.stopped.catch(()=>{});
  this.timer=setTimeout(()=>this.stop('request_timeout'),timeoutMs);
  request.signal.addEventListener('abort',this.onAbort,{once:true});
  if(request.signal.aborted)this.onAbort();
 }
 get signal(){return this.controller.signal;}
 get failure(){return this.terminal;}
 stop(reason:StopReason){
  if(this.closed||this.terminal)return;
  this.terminal=new RequestStopped(reason);
  this.rejectStop(this.terminal);
  this.controller.abort(this.terminal);
 }
 check(){
  if(!this.terminal&&performance.now()>=this.end)this.stop('request_timeout');
  if(this.terminal)throw this.terminal;
  if(this.closed)throw new Error('Request is closed.');
 }
 async wait<T>(pending:Promise<T>,storage=false):Promise<T>{
  void pending.catch(()=>{});
  this.check();
  const end=performance.now()+this.storageTimeoutMs;
  const timer=storage?setTimeout(()=>this.stop('storage_timeout'),this.storageTimeoutMs):undefined;
  try{
   const result=await Promise.race([pending,this.stopped]);
   if(storage&&performance.now()>=end)this.stop('storage_timeout');
   this.check();return result;
  }finally{if(timer!==undefined)clearTimeout(timer);}
 }
 close(){
  clearTimeout(this.timer);
  this.request.signal.removeEventListener('abort',this.onAbort);
  this.closed=true;
  this.controller.abort();
 }
 error(error:unknown){
  const terminal=this.terminal;
  if(!terminal&&!this.writeDispatched)return cloudError(error);
  const response=terminal?cloudResponse({error:{code:terminal.reason}},terminal.reason==='request_aborted'?408:terminal.reason==='storage_busy'?503:504):cloudError(error);
  // No result/IDs are returned after termination. Dispatch is only this attempt's fact;
  // an earlier identical request may already have a saved receipt.
  return response.json().then((body:unknown)=>{
   const fields=body!==null&&typeof body==='object'&&!Array.isArray(body)?body:{};
   const result=cloudResponse({...fields,delivery:{write_dispatch:this.writeDispatched?'dispatched':'not_dispatched',
    dispatch_scope:'current_request_only',persistence:this.writeDispatched?'unknown':'not_checked',
    next_action:'check_original_receipt_or_retry_identical',automatic_replay:false},claims_verified:false},response.status);
   if(terminal?.reason==='storage_busy')result.headers.set('Retry-After','1');
   return result;
  });
 }
}

/** Keep unresolved native calls counted after HTTP termination, with no waiting queue. */
export class CloudRequestStorage {
 private pending=0;
 constructor(private readonly raw:D1Binding,private readonly limit=16){}
 bind(life:CloudRequest):D1Binding{
  const execute=<T>(call:()=>Promise<T>,write=false):Promise<T>=>{
   life.check();
   if(this.pending>=this.limit){life.stop('storage_busy');life.check();}
   this.pending++;
   if(write)life.writeDispatched=true;
   let native:Promise<T>;
   try{native=call();}catch(error){this.pending--;throw error;}
   const settled=native.then(value=>{this.pending--;return value;},error=>{this.pending--;throw error;});
   // If time elapsed synchronously inside a binding, wait() can reject before racing.
   void settled.catch(()=>{});
   return life.wait(settled,true);
  };
  return {...(this.raw.writeGeneration===undefined?{}:{writeGeneration:this.raw.writeGeneration}),withSession:constraint=>{
   life.check();const session=this.raw.withSession(constraint),native=new WeakMap<D1Statement,D1Statement>();
   const wrap=(statement:D1Statement):D1Statement=>{
    const result:D1Statement={bind:(...values)=>{life.check();return wrap(statement.bind(...values));},all:<T>()=>execute(()=>statement.all<T>())};
    native.set(result,statement);return result;
   };
   return {prepare:sql=>{life.check();return wrap(session.prepare(sql));},batch:statements=>{
    life.check();const originals=statements.map(statement=>{const original=native.get(statement);if(!original)throw new Error('Foreign statement.');return original;});
    return execute(()=>session.batch(originals),true);
   }};
  }};
 }
}
