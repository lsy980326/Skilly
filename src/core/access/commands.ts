import { z } from 'zod';
import { reportSchema,workLinks,workKey } from '../work/schema.js';

const text=(max:number)=>z.string().trim().min(1).max(max),key=text(200),id=z.uuid();
const report=reportSchema.refine(r=>!r.import_source&&!r.feature_updates?.length,'This boundary accepts reports, not imports or feature state updates.').optional();
const task={idempotency_key:key};
export const cloudWriteSchema=z.discriminatedUnion('operation',[
 z.strictObject({operation:z.literal('begin'),input:z.strictObject({...task,goal:text(2000),mode:z.enum(['answer','diagnose','review','change']),
  actor:text(80).optional(),title:text(200).optional(),branch:text(200).optional(),...workLinks})}),
 z.strictObject({operation:z.literal('checkpoint'),input:z.strictObject({...task,run_id:id,topic:text(200),kind:z.enum(['note','change','issue']),body:text(16000),
  report_origin:z.enum(['contemporaneous','retrospective']).optional(),report})}),
 z.strictObject({operation:z.literal('finish'),input:z.strictObject({...task,run_id:id,summary:text(16000),outcome:z.enum(['completed','interrupted']),report})}),
]);
export type CloudWrite=z.infer<typeof cloudWriteSchema>;
export const cloudReadSchema=z.discriminatedUnion('operation',[
 z.strictObject({operation:z.literal('tasks'),input:z.strictObject({offset:z.int().min(0).max(100000).optional(),limit:z.int().min(1).max(10).optional(),
  query:z.string().max(200).optional(),component:workKey.optional(),feature:workKey.optional(),state:z.enum(['active','completed','interrupted']).optional()})}),
 z.strictObject({operation:z.literal('task'),input:z.strictObject({run_id:id})}),
 z.strictObject({operation:z.literal('record'),input:z.strictObject({record_id:id})}),
 z.strictObject({operation:z.literal('context'),input:z.strictObject({})}),
 z.strictObject({operation:z.literal('receipt'),input:z.strictObject({write_operation:z.enum(['begin','checkpoint','finish']),idempotency_key:key})}),
]);
export const cloudRequestSchema=z.strictObject({repository:text(100),environment:text(100),command:z.union([cloudWriteSchema,cloudReadSchema])});
