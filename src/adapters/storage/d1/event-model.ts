import { z } from "zod";
import { d1ScopeSchema } from "./query.js";
import { eventRowSchemas } from "../../../core/transfer/events.js";

const fields=eventRowSchemas.events.shape;
export const d1EventScopeSchema=d1ScopeSchema.extend({root_hash:fields.root_hash,session_hash:fields.session_hash});
export type D1EventScope=z.infer<typeof d1EventScopeSchema>;
const key=z.string().min(1).max(200);
// Host-normalized allowlist. No raw path, prompt, command, tool input/output or caller-selected project/session.
export const receiveEventSchema=z.strictObject({idempotency_key:key,observation_id:fields.id,event:fields.event,
  observed_at:fields.received_at,turn_hash:fields.turn_hash.default(null),source:fields.source.default(null),tool_group:fields.tool_group.default(null)});
export const linkEventSchema=z.strictObject({idempotency_key:key,run_id:z.uuid(),observation_id:fields.id});
export const eventCommandSchema=z.discriminatedUnion("operation",[
  z.strictObject({operation:z.literal("receive"),input:receiveEventSchema.extend(d1EventScopeSchema.shape),at:z.iso.datetime()}),
  z.strictObject({operation:z.literal("link"),input:linkEventSchema.extend(d1EventScopeSchema.shape),id:z.uuid(),at:z.iso.datetime()}),
]);
export type D1EventChange=z.infer<typeof eventCommandSchema>;
export const eventCoverage=Object.freeze({provenance:"local_hook_input",authenticity:"not_attested",claims_verified:false,
  completeness:"unknown",missing_record_count:null,live_execution:"unknown",hook_loading:"not_verified",automatic_replay:false,
  recording_coverage:{received_events:"persisted_receipts_only",unreceived_events:"not_observable",unreceived_work_requests:"not_observable"}});

/** One server-transaction snapshot. It does NOT describe when the user physically pressed Stop. */
export function lastSavedSql(project:string,run:string,at:string):string {
  const confirmed=`EXISTS(SELECT 1 FROM receipts q WHERE q.scope=checkpoint_record.project_id AND
    (json_extract(q.result_json,'$.record_id')=checkpoint_record.id OR EXISTS(SELECT 1 FROM json_each(q.result_json,'$.record_ids') j WHERE j.value=checkpoint_record.id)))`;
  const start=`EXISTS(SELECT 1 FROM receipts q WHERE q.scope=${project} AND json_extract(q.result_json,'$.run.id')=${run})`;
  return `coalesce((SELECT json_object('stage','record','record_id',checkpoint_record.id,'seq',checkpoint_record.seq,'recorded_at',checkpoint_record.recorded_at,
    'record_visible',json('true'),'receipt_confirmed',json(CASE WHEN ${confirmed} THEN 'true' ELSE 'false' END),
    'read_at',${at},'meaning','Server receive transaction snapshot; not the physical interruption time.')
    FROM records checkpoint_record WHERE checkpoint_record.project_id=${project} AND checkpoint_record.run_id=${run} ORDER BY checkpoint_record.seq DESC LIMIT 1),
    json_object('stage',CASE WHEN ${start} THEN 'start' ELSE 'unknown' END,'record_id',NULL,'record_visible',json('false'),
    'receipt_confirmed',json(CASE WHEN ${start} THEN 'true' ELSE 'false' END),'read_at',${at},
    'meaning','Server receive transaction snapshot; not the physical interruption time.'))`;
}
