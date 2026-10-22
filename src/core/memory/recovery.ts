import { MemoryError, type Context, type JsonObject } from "./model.js";
import type { MemoryStore } from "./ports.js";
import { recordingCoverage, recordingDelivery } from "./recording-health.js";

export const RECOVERABLE_WRITES = ["memory_begin_task", "memory_checkpoint", "memory_finish_task"] as const;
export type RecoverableWrite = typeof RECOVERABLE_WRITES[number];
const operations = { memory_begin_task: "begin", memory_checkpoint: "checkpoint", memory_finish_task: "finish" };

export interface RecoveryScope {
  project_id: string;
  repository: string;
  environment: string;
}

export interface PendingWrite extends RecoveryScope {
  id: string;
  tool: RecoverableWrite;
  key: string;
  hash: string;
  input: JsonObject | null;
  received_at: string;
  last_error: string | null;
}

/** This journal is independent of the record DB, so a record DB lock can be recovered. */
export interface RecoveryJournal {
  prepare(request: PendingWrite): Promise<"new" | "existing">;
  get(id: string): Promise<PendingWrite | undefined>;
  list(scope: RecoveryScope, limit: number, offset: number): Promise<PendingWrite[]>;
  markSaved(id: string): Promise<boolean>;
  markFailed(id: string, code: string, retainInput: boolean): Promise<boolean>;
}

export function isRecoverableWrite(name: string): name is RecoverableWrite {
  return RECOVERABLE_WRITES.some(tool => tool === name);
}

export class WriteRecovery {
  constructor(
    private readonly store: MemoryStore,
    private readonly journal: RecoveryJournal,
    private readonly context: Context,
    private readonly lifecycle?: () => JsonObject,
  ) {}

  async execute(tool: RecoverableWrite, input: JsonObject, invoke: () => Promise<JsonObject>): Promise<JsonObject> {
    const scope = await this.scopeFor(input);
    const key = text(input, "idempotency_key");
    const request: PendingWrite = {
      ...scope, id: this.context.hash([scope.project_id, key]), tool, key,
      hash: this.context.hash({ operation: operations[tool], ...input }),
      input, received_at: this.context.now(), last_error: null,
    };
    // A saved receipt remains usable even if the recovery disk is unavailable.
    const existing = await this.receipt(request);
    if (existing) return this.confirm(request, existing);
    let prepared: "new" | "existing";
    try { prepared = await this.journal.prepare(request); }
    catch (error) {
      // Another connection can commit and acknowledge between our read and prepare.
      const raced = await this.receipt(request);
      if (raced) return this.confirm(request, raced);
      throw error;
    }
    let result: JsonObject;
    try {
      result = await invoke();
    } catch (error) {
      const code = error instanceof MemoryError ? error.code : "storage_error";
      const domainRejection = error instanceof MemoryError && !error.retryable
        && ["run_closed", "not_found", "invalid_time", "scope_mismatch", "older_observation", "invalid_input", "idempotency_conflict", "conflict", "catalog_conflict"].includes(code);
      // Do not let newly invalid requests exhaust the bounded retry queue.
      // Previously retained originals stay available even if their run later closes.
      const retainInput = prepared === "existing" || !domainRejection;
      let retained = true;
      let failureRecorded = true;
      try { retained = await this.journal.markFailed(request.id, code, retainInput); } catch { failureRecorded = false; }
      throw new MemoryError(code,
        error instanceof MemoryError ? error.message : "Write result is unconfirmed.",
        error instanceof MemoryError ? error.retryable : false,
        { request_id: request.id, persistence: domainRejection ? "rejected" : "unconfirmed",
          pending_retained: retained, failure_detail_saved: failureRecorded,
          next_tool: "memory_recovery_status" });
    }
    return this.confirm(request, result);
  }

  async status(input: RecoveryScope & { limit: number; offset: number; request_id?: string | undefined }): Promise<JsonObject> {
    if (!await this.store.getProject(input.project_id)) throw new MemoryError("not_found", "Project not found.");
    let requests: PendingWrite[];
    if (input.request_id) {
      const request = await this.journal.get(input.request_id);
      if (!request) throw new MemoryError("not_found", "Recovery request not found; retention is not confirmed.");
      this.assertScope(request, input);
      requests = [request];
    } else {
      requests = await this.journal.list(input, input.limit + 1, input.offset);
    }
    const runs = await this.store.unfinishedRuns(input.project_id, input.repository, input.environment, input.limit + 1, input.offset);
    const items: JsonObject[] = [];
    for (const request of requests.slice(0, input.limit)) {
      let receipt: JsonObject | undefined;
      let conflict = false;
      try { receipt = await this.receipt(request); }
      catch (error) {
        if (!(error instanceof MemoryError) || error.code !== "idempotency_conflict") throw error;
        conflict = true;
      }
      const recoveryState = receipt ? "saved" : conflict ? "conflict"
        : request.input === null ? (request.last_error ? "rejected" : "payload_unavailable")
        : request.last_error ? (["busy", "storage_error", "conflict"].includes(request.last_error) ? "retry_required" : "blocked")
        : "unconfirmed";
      items.push({
        request_id: request.id, tool: request.tool, first_received_at: request.received_at,
        run_id: request.input?.["run_id"] ?? (receipt ? receiptSummary(receipt)["run_id"] : null) ?? null,
        persistence: receipt ? "persisted" : "not_found",
        recovery_state: recoveryState,
        delivery_status: recordingDelivery(!!receipt, request.input !== null, recoveryState),
        last_error: request.last_error, original_input_retained: request.input !== null,
        receipt: receipt ? receiptSummary(receipt) : null,
      });
    }
    const more = requests.length > input.limit || runs.length > input.limit;
    return {
      requests: items,
      unfinished_runs: runs.slice(0, input.limit).map(run => ({
        id: run.id, mode: run.mode, state: run.state, created_at: run.created_at, updated_at: run.updated_at,
        goal: Array.from(run.goal).slice(0, 120).join(""), goal_truncated: Array.from(run.goal).length > 120,
        attention: run.state === "active" ? "unfinished_or_still_running" : "reported_interruption",
      })),
      next_offset: more ? input.offset + input.limit : null,
      capture: "agent_reports_only", claims_verified: false, automatic_replay: false,
      recording_coverage: recordingCoverage(),
      ...(this.lifecycle ? { lifecycle_observations: this.lifecycle() } : {}),
      limitation: "Active does not prove a crash. Absence of a receipt is a point-in-time observation. Requests that never reached this server are not captured. Pagination is live, not a snapshot.",
    };
  }

  async retry(input: RecoveryScope & { request_id: string }, invoke: (tool: string, args: JsonObject) => Promise<JsonObject>): Promise<JsonObject> {
    const request = await this.journal.get(input.request_id);
    if (!request) throw new MemoryError("not_found", "Recovery request not found; do not reconstruct the original input.");
    this.assertScope(request, input);
    const existing = await this.receipt(request);
    if (existing) return this.confirm(request, existing);
    if (!request.input) throw new MemoryError("payload_unavailable", "Original input is unavailable. A new retrospective report is required.");
    if (this.context.hash({ operation: operations[request.tool], ...request.input }) !== request.hash
      || request.input["project_id"] !== request.project_id || request.input["idempotency_key"] !== request.key) {
      throw new MemoryError("invalid_data", "Retained input does not match its original request; retry refused.");
    }
    // Re-enter normal validation, binding and idempotency checks; never patch the stored payload.
    return invoke(request.tool, request.input);
  }

  private async receipt(request: PendingWrite): Promise<JsonObject | undefined> {
    const receipt = await this.store.getReceipt(request.project_id, request.key);
    if (receipt && receipt.hash !== request.hash) {
      throw new MemoryError("idempotency_conflict", "The request key belongs to a different input; original data was preserved.");
    }
    return receipt?.result;
  }

  private async confirm(request: PendingWrite, receipt: JsonObject): Promise<JsonObject> {
    let cleanup = false;
    let requestId: string | null = null;
    // The authoritative record is already committed. A journal failure must not turn it into an unsaved claim.
    try {
      if (await this.journal.get(request.id)) {
        requestId = request.id;
        cleanup = await this.journal.markSaved(request.id);
      }
    } catch { cleanup = false; }
    return { ...receipt, recovery: { request_id: requestId, persistence: "persisted", journal_acknowledged: cleanup } };
  }

  private async scopeFor(input: JsonObject): Promise<RecoveryScope> {
    const project_id = text(input, "project_id");
    if (!await this.store.getProject(project_id)) throw new MemoryError("not_found", "Project not found.");
    if (typeof input["run_id"] === "string") {
      const run = await this.store.getRun(project_id, input["run_id"]);
      if (!run) throw new MemoryError("not_found", "Run not found in this project.");
      return { project_id, repository: run.repository, environment: run.environment };
    }
    return { project_id, repository: text(input, "repository"), environment: text(input, "environment") };
  }

  private assertScope(request: RecoveryScope, scope: RecoveryScope): void {
    if (request.project_id !== scope.project_id || request.repository !== scope.repository || request.environment !== scope.environment) {
      throw new MemoryError("scope_mismatch", "Recovery request belongs to another project, repository or environment.");
    }
  }
}

function text(value: JsonObject, key: string): string {
  const item = value[key];
  if (typeof item !== "string") throw new MemoryError("invalid_input", `Expected string: ${key}.`);
  return item;
}

function receiptSummary(receipt: JsonObject): JsonObject {
  const run = receipt["run"];
  const runId = run !== null && typeof run === "object" && !Array.isArray(run) ? run["id"] : null;
  return {
    status: receipt["status"] ?? null, run_id: receipt["run_id"] ?? runId ?? null,
    record_id: receipt["record_id"] ?? null, state: receipt["state"] ?? null,
    knowledge_status: "unknown", provenance: "agent_report",
  };
}
