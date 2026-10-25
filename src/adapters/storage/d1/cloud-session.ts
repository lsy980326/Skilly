import type { Authentication,AccessScope } from '../../../core/access/model.js';
import type { cloudRequestSchema } from '../../../core/access/commands.js';
import type { z } from 'zod';
import type { D1Binding } from './binding.js';
import { D1ProjectAccess } from './project-access.js';
import { D1CloudWork } from './cloud-work.js';
import { D1TaskReader } from './task-reader.js';
import { D1CurrentKnowledge } from './current-knowledge.js';
import { D1Decisions } from './decisions.js';
import { D1Plans } from './plans.js';
import { D1CloudPlans } from './cloud-plans.js';
import { cloudWriteSchema } from '../../../core/access/commands.js';
import { D1ExecutionReader } from './execution-reader.js';
import { cloudExecutionReceipt } from './cloud-executions.js';
import type { SourceProvider } from '../../../core/execution/currentness.js';
import { resolveCloudEventContext,type CloudEventContextProvider } from '../../../core/access/event-context.js';
import { MemoryError } from '../../../core/memory/model.js';
import { D1CloudTaskEvents } from './cloud-task-events.js';
import { D1EventReader } from './event-reader.js';

import { D1CloudSkills,resolveCloudSkillScope,type CloudSkillContextProvider } from './cloud-skills.js';
import { D1SkillReader } from './skill-reader.js';
import { D1FeatureReader } from './feature-reader.js';

export type CloudCommand=z.infer<typeof cloudRequestSchema>['command'];
/** Shared HTTP/MCP business boundary. Inputs never choose the authenticated scope. */
export async function executeCloudCommand(db:D1Binding,auth:Authentication,scope:AccessScope,command:CloudCommand,sources?:SourceProvider,events?:CloudEventContextProvider,skills?:CloudSkillContextProvider){
 const write=cloudWriteSchema.options.some(option=>option.shape.operation.value===command.operation);
 const permit=await new D1ProjectAccess(db).bind(auth.principal,scope,write?'write':'read',()=>auth.assertFresh(),auth.credential);
 const work=new D1CloudWork(permit.binding,scope,auth.principal),reader=new D1TaskReader(permit.binding,scope);
 const eventContext=()=>{
  const context=resolveCloudEventContext(events,scope,auth.principal);
  if(!context)throw new MemoryError('unsupported_capability','This host has no bound event context; the MCP connection may still be healthy.');
  const {root_hash,session_hash}=context;
  return {scope:{...scope,root_hash,session_hash},anchor:context.observation_id??null};
 };
 const skillScope=()=>resolveCloudSkillScope(skills,scope,auth.principal);
 const skillReader=()=>new D1SkillReader(permit.binding,skillScope());
 let result:unknown;
 switch(command.operation){
  case 'begin':case 'checkpoint':case 'finish':result=await work.write(command);break;
  case 'save-plan':case 'update-plan':result=await new D1CloudPlans(permit.binding,scope,auth.principal).write(command);break;
  case 'tasks':result=await reader.listTasks(command.input);break;
  case 'task':result=await reader.getTask(command.input.run_id);break;
  case 'record':result=await reader.getRecord(command.input.record_id);break;
  case 'context':result=await new D1CurrentKnowledge(permit.binding,scope,sources).query(command.input);break;
  case 'features':result=await new D1FeatureReader(permit.binding,scope,sources).list(command.input);break;
  case 'skills':result=await skillReader().list(command.input.query,command.input.offset);break;
  case 'skill':result=await skillReader().detail(command.input.skill_key,command.input.version,command.input.installation_offset);break;
  case 'skill-package':result=await skillReader().package(command.input.skill_key,command.input.version);break;
  case 'skill-history':result=await skillReader().history(command.input.installation_id,command.input.kind,command.input.offset);break;
  case 'task-skills':result=await skillReader().taskSkills(command.input.run_id,command.input.offset);break;
  case 'skill-register':case 'skill-assign':case 'skill-checkpoint':result=await new D1CloudSkills(permit.binding,skillScope(),auth.principal).write(command);break;
  case 'decisions':result=await new D1Decisions(permit.binding,scope).query(command.input);break;
  case 'plans':result=await new D1Plans(permit.binding,scope,sources).query(command.input);break;
  case 'executions':result=await new D1ExecutionReader(permit.binding,scope,sources).list(command.input.run_id,command.input.offset);break;
  case 'event-observations':result=await new D1EventReader(permit.binding,eventContext().scope).observations(command.input.offset);break;
  case 'event-status':result={run_id:command.input.run_id,task_recording:await new D1EventReader(permit.binding,eventContext().scope).status(command.input.run_id),claims_verified:false};break;
  case 'event-link':{const ctx=eventContext();result=await new D1CloudTaskEvents(permit.binding,ctx.scope,auth.principal).link(command.input,ctx.anchor);break;}
  case 'receipt':{const {write_operation:op,idempotency_key:key}=command.input;result=await (op==='skill-register'||op==='skill-assign'||op==='skill-checkpoint'||op==='skill-inspect'?new D1CloudSkills(permit.binding,skillScope(),auth.principal).receipt(op,key):op==='event-receive'||op==='event-link'?new D1CloudTaskEvents(permit.binding,eventContext().scope,auth.principal).receipt(op,key):op==='execution-start'||op==='execution-finish'?cloudExecutionReceipt(permit.binding,scope,auth.principal,op,key):op==='save-plan'||op==='update-plan'?new D1CloudPlans(permit.binding,scope,auth.principal).receipt(op,key):work.receipt(op,key));break;}
 }
 await permit.check();await auth.assertFresh();return result;
}
