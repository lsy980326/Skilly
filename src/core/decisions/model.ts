import { z } from "zod";
import { MemoryError, type JsonObject, type MemoryRecord } from "../memory/model.js";
import { workKey } from "../work/schema.js";

const ids = z.array(z.uuid()).max(200).refine(v => new Set(v).size === v.length, "Duplicate IDs.");
const text = (n: number) => z.string().trim().min(1).max(n);
export const decisionSubjectSchema=z.strictObject({subject:workKey,component_key:workKey.optional(),feature_key:workKey.optional(),history_offset:z.int().min(0).max(200).optional()});
export const decisionSchema = z.strictObject({
  subject: workKey, title: text(160), action: z.enum(["decide", "replace", "withdraw", "propose"]),
  choice_key: workKey.optional(), targets: z.array(z.uuid()).max(8), expected_current_ids: ids,
  component_key: workKey.optional(), feature_key: workKey.optional(),
  source: z.strictObject({ kind: z.enum(["user_statement", "agent_proposal"]), reference: text(300), quote: text(800) }),
}).superRefine((v, ctx) => {
  if ((v.action === "withdraw") === Boolean(v.choice_key)) ctx.addIssue({code:"custom",message:"A choice is required except for withdrawal."});
  if ((v.action === "replace" || v.action === "withdraw") !== (v.targets.length > 0)
    || new Set(v.targets).size !== v.targets.length) ctx.addIssue({code:"custom",message:"Only replacement/withdrawal requires unique targets."});
  if ((v.action === "propose") !== (v.source.kind === "agent_proposal")) ctx.addIssue({code:"custom",message:"Proposals cannot be user decisions."});
});
export type Decision = z.infer<typeof decisionSchema>;
export const decisionRecordSchema = z.object({id:z.uuid(),run_id:z.uuid(),seq:z.int().nonnegative(),body:z.string(),recorded_at:z.string(),
  report_origin:z.enum(["unspecified","contemporaneous","retrospective"])});
export type DecisionEvent = { record: Pick<MemoryRecord,"id"|"run_id"|"seq"|"body"|"recorded_at"|"report_origin">; decision: Decision };
export type DecisionQuery = { project_id: string; repository?: string | undefined; environment?: string | undefined;
  component?: string | undefined; feature?: string | undefined; subject?: string | undefined;
  query: string; offset: number; limit: number; history_offset?: number | undefined };
export const MAX_DECISION_EVENTS = 200;
export function assessDecisions(events: DecisionEvent[], truncated = false) {
  const active = new Map<string, DecisionEvent>(), states = new Map<string, string>();
  for (const event of events) {
    const {record:r,decision:d} = event;
    if (r.report_origin !== "contemporaneous") { states.set(r.id,"historical"); continue; }
    if (d.action === "propose") { states.set(r.id,"proposal"); continue; }
    for (const target of d.targets) { active.delete(target); states.set(target,d.action === "withdraw" ? "withdrawn" : "previous"); }
    if (d.action === "withdraw") states.set(r.id,"withdrawal");
    else { active.set(r.id,event); states.set(r.id,"current"); }
  }
  const status = truncated ? "unknown" : new Set([...active.values()].map(e=>e.decision.choice_key)).size > 1 ? "conflict"
    : active.size ? "current" : events.some(e=>e.record.report_origin === "contemporaneous" && e.decision.action === "withdraw") ? "withdrawn" : "unconfirmed";
  return {status,active,states};
}
export function validateDecision(d: Decision, events: DecisionEvent[], truncated: boolean, origin: string) {
  if (truncated || events.length >= MAX_DECISION_EVENTS) throw new MemoryError("invalid_input","Decision history limit reached; current state is unknown.");
  const state = assessDecisions(events);
  const actual = [...state.active.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify([...d.expected_current_ids].sort()))
    throw new MemoryError("conflict","Current decisions changed. Read the complete subject again; do not replace expected IDs automatically.");
  for (const target of d.targets) if (!state.active.has(target)) throw new MemoryError("scope_mismatch","Targets must be active decisions in this exact subject and scope.");
  if (origin !== "contemporaneous" && d.targets.length) throw new MemoryError("invalid_input","Historical reports cannot change current decisions.");
}
export interface DecisionReader {
  assertScope(project:string,run:string,decision:Decision):void;
  events(project: string, repository: string, environment: string, decision: Pick<Decision,"subject"|"component_key"|"feature_key">): {events:DecisionEvent[];truncated:boolean};
  query(input: DecisionQuery): JsonObject;
  metadata(project: string, record: string): Decision | undefined;
}
