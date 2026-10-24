import { z } from "zod";

const id = z.string().regex(/^(?:[a-f0-9]{64}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i);
const hash = z.string().regex(/^[a-f0-9]{64}$/), scope = z.string().min(1).max(100), time = z.iso.datetime();
const sequence = z.int().positive();
export const savedPointSchema = z.strictObject({ stage: z.enum(["record", "start", "unknown"]), record_id: z.uuid().nullable(),
  seq: sequence.optional(), source_seq: sequence.optional(), recorded_at: time.optional(), record_visible: z.boolean(), receipt_confirmed: z.boolean(),
  read_at: time, meaning: z.literal("Record visible during hook processing; not an atomic cutoff across databases.") });
export const eventRowSchemas = {
  events: z.strictObject({ seq: sequence, id, project_key: scope, repository: scope, environment: scope, root_hash: hash,
    session_hash: hash, turn_hash: hash.nullable(), event: z.enum(["SessionStart", "PostToolUse", "PreCompact", "Stop", "Interrupt", "SessionEnd"]),
    source: z.enum(["startup", "resume", "clear", "compact", "fork"]).nullable(), tool_group: z.enum(["shell", "edit", "mcp", "other"]).nullable(), received_at: time }),
  task_links: z.strictObject({ seq: sequence, id: z.uuid(), project_id: z.uuid(), run_id: z.uuid(), project_key: scope,
    repository: scope, environment: scope, root_hash: hash, session_hash: hash, anchor_id: id, from_seq: sequence, linked_at: time }),
  event_task_links: z.strictObject({ event_id: id, link_id: z.uuid(), saved_json: z.string().max(4096) }),
  event_link_failures: z.strictObject({ event_id: id, link_id: z.uuid(), status: z.literal("association_unconfirmed") }),
  event_imports: z.strictObject({ kind: z.enum(["event", "link"]), id, source_seq: sequence,
    source_from_seq: sequence.nullable(), source_bundle_hash: hash }),
};
export type EventTable = keyof typeof eventRowSchemas;
export const eventTables = Object.keys(eventRowSchemas) as EventTable[];
