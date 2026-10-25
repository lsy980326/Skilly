import type { Authentication,AccessScope } from '../../../core/access/model.js';
import type { cloudRequestSchema } from '../../../core/access/commands.js';
import type { z } from 'zod';
import type { D1Binding } from './binding.js';
import { D1ProjectAccess } from './project-access.js';
import { D1CloudWork } from './cloud-work.js';
import { D1TaskReader } from './task-reader.js';
import { D1CurrentKnowledge } from './current-knowledge.js';

export type CloudCommand=z.infer<typeof cloudRequestSchema>['command'];
/** Shared HTTP/MCP business boundary. Inputs never choose the authenticated scope. */
export async function executeCloudCommand(db:D1Binding,auth:Authentication,scope:AccessScope,command:CloudCommand){
 const write=['begin','checkpoint','finish'].includes(command.operation);
 const permit=await new D1ProjectAccess(db).bind(auth.principal,scope,write?'write':'read',()=>auth.assertFresh(),auth.credential);
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
 await permit.check();await auth.assertFresh();return result;
}
