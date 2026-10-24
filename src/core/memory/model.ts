import type { StructuredReport, WorkLinks, WorkMutation } from "../work/model.js";
import type { Decision } from "../decisions/model.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export class MemoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly recovery?: JsonObject,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}

export interface Project {
  id: string;
  key: string;
  name: string;
  revision: number;
  created_at: string;
}

export type RunState = "active" | "completed" | "interrupted";
export interface Run {
  id: string;
  project_id: string;
  goal: string;
  mode: "answer" | "diagnose" | "review" | "change";
  environment: string;
  repository: string;
  state: RunState;
  created_at: string;
  updated_at: string;
  actor?: string;
}

export interface MemoryRecord {
  id: string;
  seq: number;
  project_id: string;
  run_id: string;
  topic: string;
  kind: "note" | "decision" | "change" | "issue" | "summary";
  body: string;
  environment: string;
  repository: string;
  source_fingerprint: string | null;
  observed_at: string;
  recorded_at: string;
  supersedes: string | null;
  superseded_by: string | null;
  report_origin: "unspecified" | "contemporaneous" | "retrospective";
}

export interface RegisterProjectInput {
  key: string;
  name: string;
  idempotency_key: string;
}

export interface BeginTaskInput extends WorkLinks {
  project_id: string;
  goal: string;
  mode: Run["mode"];
  environment: string;
  repository: string;
  idempotency_key: string;
  actor?: string | undefined;
  title?: string | undefined;
  branch?: string | undefined;
}

export interface CheckpointInput extends WorkLinks {
  decision?: Decision | undefined;
  project_id: string;
  run_id: string;
  topic: string;
  kind: MemoryRecord["kind"];
  body: string;
  source_fingerprint?: string | undefined;
  observed_at?: string | undefined;
  supersedes?: string | undefined;
  idempotency_key: string;
  report_origin?: MemoryRecord["report_origin"] | undefined;
  report?: StructuredReport | undefined;
}

export interface FinishTaskInput extends WorkLinks {
  project_id: string;
  run_id: string;
  summary: string;
  outcome: "completed" | "interrupted";
  idempotency_key: string;
  report_origin?: MemoryRecord["report_origin"] | undefined;
  report?: StructuredReport | undefined;
}

export interface QueryInput {
  project_id: string;
  query: string;
  environment: string;
  repository: string;
  topic?: string | undefined;
  source_fingerprint?: string | undefined;
  history: boolean;
  limit: number;
  cursor?: string | undefined;
}

export interface RecordQuery extends Omit<QueryInput, "cursor"> {
  after_seq: number;
  snapshot_seq: number;
}

export interface Receipt {
  scope: string;
  key: string;
  hash: string;
  result: JsonObject;
}

export interface Mutation {
  decision?: Decision;
  receipt: Receipt;
  project: Project;
  /** Null means create; otherwise compare and increment this project revision. */
  expected_revision: number | null;
  run?: Run;
  record?: Omit<MemoryRecord, "seq">;
  work?: WorkMutation;
  records?: Omit<MemoryRecord, "seq">[];
  reports?: WorkMutation[];
}

export interface Context {
  id(): string;
  now(): string;
  hash(value: unknown): string;
}

export function recordStatus(
  record: MemoryRecord,
  fingerprint?: string,
): "superseded" | "stale" | "unknown" {
  if (record.superseded_by) return "superseded";
  if (fingerprint && record.source_fingerprint && fingerprint !== record.source_fingerprint) {
    return "stale";
  }
  // Agent-supplied content never becomes verified merely by matching a version.
  return "unknown";
}

export function parseJsonObject(text: string): JsonObject {
  const parsed: unknown = JSON.parse(text);
  if (!isJsonObject(parsed)) throw new MemoryError("invalid_data", "Expected a JSON object.");
  return parsed;
}

function isJsonValue(value: unknown): value is JsonValue {
  return value === null || typeof value === "string" || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value))
    || (Array.isArray(value) && value.every(isJsonValue)) || isJsonObject(value);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.values(value).every(isJsonValue);
}
