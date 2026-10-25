import { z } from 'zod';
import { accessScopeSchema } from './model.js';
import { cloudWriteSchema,type CloudWrite } from './commands.js';
import type { JsonObject } from '../memory/model.js';

export const remoteWriteTools:Record<CloudWrite['operation'],string>={begin:'memory_begin_task',checkpoint:'memory_checkpoint',finish:'memory_finish_task',
 'save-plan':'memory_save_plan','update-plan':'memory_update_plan_item','event-link':'memory_link_task_events',
 'skill-register':'memory_register_skill','skill-assign':'memory_assign_skill','skill-checkpoint':'memory_checkpoint_skill_usage'};
export const remoteDestinationSchema=z.strictObject({endpoint:z.url(),scope:accessScopeSchema}).refine(({endpoint,scope})=>{
 const u=new URL(endpoint);return !u.username&&!u.password&&!u.search&&!u.hash&&u.pathname===`/v1/projects/${scope.project_id}/mcp`
  &&(u.protocol==='https:'||u.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(u.hostname));
},'An exact HTTPS or loopback MCP endpoint is required.');
export type RemoteDestination=z.infer<typeof remoteDestinationSchema>;
export const writeTicketSchema=z.strictObject({operation:z.enum(Object.keys(remoteWriteTools) as [CloudWrite['operation'],...CloudWrite['operation'][]]),context_id:z.string().regex(/^[a-f0-9]{64}$/)});
export type WriteTicket=z.infer<typeof writeTicketSchema>;
export const outboxStateSchema=z.enum(['recovery_pending','persistence_unknown','auth_required','access_denied','blocked','saved']);
export type OutboxState=z.infer<typeof outboxStateSchema>;
export interface OutboxRequest {id:string;command:CloudWrite|null;ticket:WriteTicket;state:OutboxState;attempts:number;next_attempt_at:number;receipt_seen:boolean;write_dispatched:boolean}
export interface RemoteOutboxStore {
 readonly destination:RemoteDestination;
 retain(command:z.input<typeof cloudWriteSchema>,ticket:WriteTicket):JsonObject;
 get(id:string):OutboxRequest|undefined;
 list(offset?:number):JsonObject;
 pending(now:number):string[];
 claim(id:string,owner:string,now:number):boolean;
 dispatch(id:string,owner:string):void;
 settle(id:string,owner:string,state:OutboxState,code:string|null,next:number,receiptSeen:boolean,result?:JsonObject):boolean;
}
export interface RemoteMcpConnection {
 readonly destination:RemoteDestination;
 initialize(guard?:()=>void,deadline?:number):Promise<void>;
 call(name:string,args:JsonObject,guard?:()=>void,deadline?:number):Promise<JsonObject>;
}
export class RemoteCallError extends Error {
 constructor(readonly code:string,readonly status=0,readonly retryAfterMs=0){super('Remote call did not return a confirmed save.');}
}
