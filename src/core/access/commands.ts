import { z } from 'zod';
import { reportSchema,workLinks,workKey } from '../work/schema.js';
import { decisionSchema,decisionSubjectSchema } from '../decisions/model.js';
import { savePlanFields,updatePlanFields,planQuerySchema } from '../plans/model.js';
import { registerSkillSchema,skillKey } from '../skills/schema.js';
import { assignSkillSchema,skillCheckpointSchema } from '../skills/operations.js';
import { featureQuerySchema } from '../work/feature-query.js';
import { cloudKnowledgeQuery } from '../work/current-knowledge.js';
import { cloudEventLinkFields } from './event-context.js';

const text=(max:number)=>z.string().trim().min(1).max(max),key=text(200),id=z.uuid();
const report=reportSchema.refine(r=>!r.import_source&&!r.feature_updates?.length,'This boundary accepts reports, not imports or feature state updates.').optional();
const task={idempotency_key:key};
export const cloudWorkWriteSchema=z.discriminatedUnion('operation',[
 z.strictObject({operation:z.literal('begin'),input:z.strictObject({...task,goal:text(2000),mode:z.enum(['answer','diagnose','review','change']),
  actor:text(80).optional(),title:text(200).optional(),branch:text(200).optional(),...workLinks})}),
 z.strictObject({operation:z.literal('checkpoint'),input:z.strictObject({...task,run_id:id,topic:text(200),kind:z.enum(['note','change','issue','decision']),body:text(16000),
  report_origin:z.enum(['contemporaneous','retrospective']).optional(),report,decision:decisionSchema.optional()})
  .refine(i=>(i.kind==='decision')===(i.decision!==undefined),'Decision records require structured decision metadata only.') }),
 z.strictObject({operation:z.literal('finish'),input:z.strictObject({...task,run_id:id,summary:text(16000),outcome:z.enum(['completed','interrupted']),report})}),
]);
export const cloudPlanWriteSchema=z.discriminatedUnion('operation',[
 z.strictObject({operation:z.literal('save-plan'),input:z.strictObject({...savePlanFields,...task,run_id:id})}),
 z.strictObject({operation:z.literal('update-plan'),input:z.strictObject({...updatePlanFields,...task,run_id:id})})
]);
export const cloudEventWriteSchema=z.strictObject({operation:z.literal('event-link'),input:z.strictObject(cloudEventLinkFields)});
export const cloudSkillWriteSchema=z.discriminatedUnion('operation',[
 z.strictObject({operation:z.literal('skill-register'),input:registerSkillSchema}),
 z.strictObject({operation:z.literal('skill-assign'),input:assignSkillSchema}),
 // A separate operation preserves the existing checkpoint key/receipt contract.
 z.strictObject({operation:z.literal('skill-checkpoint'),input:skillCheckpointSchema.omit({supersedes:true}).safeExtend({kind:z.enum(['note','change','issue']),report})}),
]);
export const cloudWriteSchema=z.discriminatedUnion('operation',[...cloudWorkWriteSchema.options,...cloudPlanWriteSchema.options,cloudEventWriteSchema,...cloudSkillWriteSchema.options]);
export type CloudWrite=z.infer<typeof cloudWriteSchema>;
export type CloudWorkWrite=z.infer<typeof cloudWorkWriteSchema>;
export const cloudReceiptOperation=z.enum(['begin','checkpoint','finish','save-plan','update-plan','execution-start','execution-finish','event-receive','event-link','skill-register','skill-assign','skill-checkpoint','skill-inspect']);
export const cloudReadSchema=z.discriminatedUnion('operation',[
 z.strictObject({operation:z.literal('tasks'),input:z.strictObject({offset:z.int().min(0).max(100000).optional(),limit:z.int().min(1).max(10).optional(),
  query:z.string().max(200).optional(),component:workKey.optional(),feature:workKey.optional(),state:z.enum(['active','completed','interrupted']).optional()})}),
 z.strictObject({operation:z.literal('task'),input:z.strictObject({run_id:id})}),
 z.strictObject({operation:z.literal('record'),input:z.strictObject({record_id:id})}),
 z.strictObject({operation:z.literal('context'),input:cloudKnowledgeQuery}),
 z.strictObject({operation:z.literal('features'),input:featureQuerySchema}),
 z.strictObject({operation:z.literal('skills'),input:z.strictObject({query:z.string().max(200).optional(),offset:z.int().min(0).max(100000).optional()})}),
 z.strictObject({operation:z.literal('skill'),input:z.strictObject({skill_key:skillKey,version:text(80).optional(),installation_offset:z.int().min(0).max(100000).optional()})}),
 z.strictObject({operation:z.literal('skill-package'),input:z.strictObject({skill_key:skillKey,version:text(80)})}),
 z.strictObject({operation:z.literal('skill-history'),input:z.strictObject({installation_id:id,kind:z.enum(['assignments','observations']),offset:z.int().min(0).max(100000).optional()})}),
 z.strictObject({operation:z.literal('task-skills'),input:z.strictObject({run_id:id,offset:z.int().min(0).max(100000).optional()})}),
 z.strictObject({operation:z.literal('decisions'),input:decisionSubjectSchema}),
 z.strictObject({operation:z.literal('plans'),input:planQuerySchema}),
 z.strictObject({operation:z.literal('executions'),input:z.strictObject({run_id:id,offset:z.int().min(0).max(100000).optional()})}),
 z.strictObject({operation:z.literal('event-observations'),input:z.strictObject({offset:z.int().min(0).max(100000).optional()})}),
 z.strictObject({operation:z.literal('event-status'),input:z.strictObject({run_id:id})}),
 z.strictObject({operation:z.literal('write-context'),input:z.strictObject({write_operation:cloudReceiptOperation})}),
 z.strictObject({operation:z.literal('receipt'),input:z.strictObject({write_operation:cloudReceiptOperation,idempotency_key:key})}),
]);
export const cloudRequestSchema=z.strictObject({repository:text(100),environment:text(100),command:z.union([cloudWriteSchema,cloudReadSchema])});
