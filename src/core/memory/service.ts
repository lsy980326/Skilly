import {
  MemoryError, parseJsonObject, recordStatus,
  type BeginTaskInput, type CheckpointInput, type Context, type FinishTaskInput,
  type JsonObject, type MemoryRecord, type Mutation, type Project, type QueryInput,
  type RegisterProjectInput, type Run,
} from "./model.js";
import type { MemoryStore } from "./ports.js";
import type { Component, OverviewQuery, WorkLinks } from "../work/model.js";

const encoder = new TextEncoder();
const CONTEXT_BYTES = 32 * 1024;
type Change = Omit<Mutation, "receipt"> & { result: JsonObject };

export class MemoryService {
  constructor(private readonly store: MemoryStore, private readonly context: Context) {}

  async registerProject(input: RegisterProjectInput): Promise<JsonObject> {
    return this.mutate("registration", input.idempotency_key, { operation: "register", ...input }, async () => {
      const existing = await this.store.findProject(input.key);
      if (existing && existing.name !== input.name) {
        throw new MemoryError("project_exists", "This project key is already registered with a different name.");
      }
      const project: Project = existing
        ? { ...existing, revision: existing.revision + 1 }
        : { id: this.context.id(), key: input.key, name: input.name, revision: 0, created_at: this.context.now() };
      return {
        project, expected_revision: existing?.revision ?? null,
        result: { status: "persisted", project: { ...project } },
      };
    });
  }

  async listProjects(after: string, limit: number): Promise<JsonObject> {
    const projects = await this.store.listProjects(after, limit + 1);
    const page = projects.slice(0, limit);
    return {
      projects: page.map(project => ({ ...project })),
      next_cursor: projects.length > limit ? page.at(-1)?.key ?? null : null,
    };
  }

  async findProject(key: string): Promise<Project | undefined> {
    return this.store.findProject(key);
  }

  async registerComponent(projectId: string, component: Component): Promise<JsonObject> {
    return this.mutate(projectId, `component-binding:v1:${component.key}:${component.name}`, { operation: "component", component }, async () => {
      const project = await this.requireProject(projectId);
      return { project: { ...project, revision: project.revision + 1 }, expected_revision: project.revision,
        work: { components: [component] }, result: { status: "persisted", component } };
    });
  }

  async queryOverview(input: OverviewQuery): Promise<JsonObject> {
    await this.requireProject(input.project_id);
    return this.store.work.overview(input);
  }

  async beginTask(input: BeginTaskInput, defaultComponent?: Component): Promise<JsonObject> {
    return this.mutate(input.project_id, input.idempotency_key, { operation: "begin", ...input }, async () => {
      // Apply connection metadata only for a new mutation. Keep original retry hashes/receipts intact.
      const workLinks = links(input.components?.length || !defaultComponent ? input : { ...input, components: [defaultComponent] });
      const project = await this.requireProject(input.project_id);
      const now = this.context.now();
      const run: Run = {
        id: this.context.id(), project_id: project.id, goal: input.goal, mode: input.mode,
        environment: input.environment, repository: input.repository,
        state: "active", created_at: now, updated_at: now,
        ...(input.actor ? { actor: input.actor } : {}),
      };
      return {
        project: { ...project, revision: project.revision + 1 }, expected_revision: project.revision, run,
        work: { run_id: run.id, ...workLinks, ...(input.title ? { title: input.title } : {}), ...(input.branch ? { branch: input.branch } : {}) },
        result: {
          status: "persisted", run: parseJsonObject(JSON.stringify({ ...run,
            ...(input.title ? { title: input.title } : {}), ...(input.branch ? { branch: input.branch } : {}), ...workLinks })),
          capture: "agent_reports_only", current_knowledge: [],
          next_tool: "memory_query_context",
        },
      };
    });
  }

  async checkpoint(input: CheckpointInput): Promise<JsonObject> {
    return this.mutate(input.project_id, input.idempotency_key, { operation: "checkpoint", ...input }, async () => {
      const project = await this.requireProject(input.project_id);
      const run = await this.requireActiveRun(project.id, input.run_id);
      const now = this.context.now();
      const observedAt = input.observed_at ?? now;
      if (observedAt > now) throw new MemoryError("invalid_time", "observed_at cannot be in the future.");
      if (input.supersedes) {
        const previous = await this.store.getRecord(project.id, input.supersedes);
        if (!previous) throw new MemoryError("not_found", "The superseded record does not exist in this project.");
        if (previous.superseded_by) throw new MemoryError("conflict", "This record has already been superseded.");
        if (previous.topic !== input.topic || previous.kind !== input.kind
          || previous.environment !== run.environment || previous.repository !== run.repository) {
          throw new MemoryError("scope_mismatch", "A replacement must use the same topic, kind, repository and environment.");
        }
        if (observedAt < previous.observed_at) {
          throw new MemoryError("older_observation", "An older observation cannot supersede a newer one.");
        }
      }
      const record: Omit<MemoryRecord, "seq"> = {
        id: this.context.id(), project_id: project.id, run_id: run.id, topic: input.topic,
        kind: input.kind, body: input.body, environment: run.environment, repository: run.repository,
        source_fingerprint: input.source_fingerprint ?? null,
        observed_at: observedAt, recorded_at: now, supersedes: input.supersedes ?? null, superseded_by: null,
        report_origin: input.report_origin ?? "unspecified",
      };
      return {
        project: { ...project, revision: project.revision + 1 }, expected_revision: project.revision,
        run: { ...run, updated_at: now }, record,
        work: { run_id: run.id, record_id: record.id, ...links(input), ...(input.report ? { report: input.report } : {}) },
        result: {
          status: "persisted", record_id: record.id, knowledge_status: "unknown",
          provenance: "agent_report", project_revision: project.revision + 1,
          report_origin: record.report_origin,
        },
      };
    });
  }

  async finishTask(input: FinishTaskInput): Promise<JsonObject> {
    return this.mutate(input.project_id, input.idempotency_key, { operation: "finish", ...input }, async () => {
      const project = await this.requireProject(input.project_id);
      const run = await this.requireActiveRun(project.id, input.run_id);
      const now = this.context.now();
      const record: Omit<MemoryRecord, "seq"> = {
        id: this.context.id(), project_id: project.id, run_id: run.id,
        topic: "task-summary", kind: "summary", body: input.summary,
        environment: run.environment, repository: run.repository, source_fingerprint: null,
        observed_at: now, recorded_at: now, supersedes: null, superseded_by: null,
        report_origin: input.report_origin ?? "unspecified",
      };
      return {
        project: { ...project, revision: project.revision + 1 }, expected_revision: project.revision,
        run: { ...run, state: input.outcome, updated_at: now }, record,
        work: { run_id: run.id, record_id: record.id, ...links(input), ...(input.report ? { report: input.report } : {}) },
        result: {
          status: "persisted", run_id: run.id, state: input.outcome, record_id: record.id,
          knowledge_status: "unknown", provenance: "agent_report",
          report_origin: record.report_origin,
        },
      };
    });
  }

  async queryContext(input: QueryInput): Promise<JsonObject> {
    const project = await this.requireProject(input.project_id);
    const { cursor: _cursor, ...filters } = input;
    const queryHash = this.context.hash(filters);
    let after = Number.MAX_SAFE_INTEGER;
    let snapshot = await this.store.maxSequence(project.id);
    if (input.cursor) {
      let cursor: JsonObject;
      try {
        cursor = parseJsonObject(input.cursor);
      } catch {
        throw new MemoryError("invalid_cursor", "Invalid query cursor.");
      }
      if (cursor["query"] !== queryHash || cursor["revision"] !== project.revision
        || typeof cursor["after"] !== "number" || !Number.isSafeInteger(cursor["after"])
        || typeof cursor["snapshot"] !== "number" || !Number.isSafeInteger(cursor["snapshot"])
        || cursor["after"] < 1 || cursor["snapshot"] < 0 || cursor["snapshot"] > snapshot
        || cursor["after"] > cursor["snapshot"]) {
        throw new MemoryError("invalid_cursor", "Query scope or records changed; restart the query.");
      }
      after = cursor["after"];
      snapshot = cursor["snapshot"];
    }
    const records = await this.store.query({ ...filters, after_seq: after, snapshot_seq: snapshot, limit: input.limit + 1 });
    const page: JsonObject[] = [];
    const response: JsonObject = {
      status: records.length ? "matched" : "no_match", project_id: project.id,
      project_revision: project.revision, current_knowledge: [], records: page,
      capture: "agent_reports_only", currentness: "unverified",
      search: "literal_terms_prefix_and_scoped_substring",
      truncated: false, next_cursor: null,
    };
    for (const record of records.slice(0, input.limit)) {
      const body = Array.from(record.body).slice(0, 400).join("");
      page.push({
        id: record.id, run_id: record.run_id, topic: record.topic, kind: record.kind,
        excerpt: body, excerpt_truncated: body.length < record.body.length,
        provenance: "agent_report", knowledge_status: recordStatus(record, input.source_fingerprint),
        observed_at: record.observed_at, recorded_at: record.recorded_at,
        source_fingerprint: record.source_fingerprint, superseded_by: record.superseded_by,
        report_origin: record.report_origin,
      });
      // Leave space for cursor metadata, independent of character width in UTF-8.
      if (encoder.encode(JSON.stringify(response)).byteLength > CONTEXT_BYTES - 1024) {
        page.pop();
        break;
      }
    }
    const last = records[page.length - 1];
    if (records.length > page.length && last) {
      response["truncated"] = true;
      response["next_cursor"] = JSON.stringify({
        query: queryHash, revision: project.revision, after: last.seq, snapshot,
      });
    }
    const latest = await this.requireProject(project.id);
    if (latest.revision !== project.revision) {
      throw new MemoryError("conflict", "Records changed during the query. Retry against the new revision.", true);
    }
    return response;
  }

  async getEvidence(projectId: string, recordId: string): Promise<JsonObject> {
    await this.requireProject(projectId);
    const record = await this.store.getRecord(projectId, recordId);
    if (!record) throw new MemoryError("not_found", "Record not found in this project.");
    return {
      record: parseJsonObject(JSON.stringify({ ...record, report: this.store.work.report(projectId, recordId) ?? null })), provenance: "agent_report",
      knowledge_status: recordStatus(record), verified: false,
      executions: this.store.executions.list(projectId, record.run_id, 0, recordId),
    };
  }

  async getStatus(projectId: string, runId: string): Promise<JsonObject> {
    const project = await this.requireProject(projectId);
    const run = await this.store.getRun(projectId, runId);
    if (!run) throw new MemoryError("not_found", "Run not found in this project.");
    return { run: parseJsonObject(JSON.stringify({ ...run, ...this.store.work.identity(projectId, runId) })), project_revision: project.revision, capture: "agent_reports_only", pending_queue_supported: false };
  }

  async listExecutions(projectId: string, runId: string, offset: number): Promise<JsonObject> {
    await this.getStatus(projectId, runId);
    return this.store.executions.list(projectId, runId, offset);
  }

  private async requireProject(id: string): Promise<Project> {
    const project = await this.store.getProject(id);
    if (!project) throw new MemoryError("not_found", "Project not found.");
    return project;
  }

  private async requireActiveRun(projectId: string, runId: string): Promise<Run> {
    const run = await this.store.getRun(projectId, runId);
    if (!run) throw new MemoryError("not_found", "Run not found in this project.");
    if (run.state !== "active") throw new MemoryError("run_closed", "This run is closed. Begin a new run.");
    return run;
  }

  private async mutate(scope: string, key: string, payload: unknown, build: () => Promise<Change>): Promise<JsonObject> {
    const hash = this.context.hash(payload);
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.store.getReceipt(scope, key);
      if (existing) {
        if (existing.hash !== hash) throw new MemoryError("idempotency_conflict", "This key was already used with different input.");
        return existing.result;
      }
      let next: Change;
      try { next = await build(); }
      catch (error) {
        // A concurrent copy may finish after our receipt read and before the
        // state checks (for example closing the same run). Prefer its receipt.
        const raced = await this.store.getReceipt(scope, key);
        if (raced) {
          if (raced.hash !== hash) throw new MemoryError("idempotency_conflict", "This key was already used with different input.");
          return raced.result;
        }
        throw error;
      }
      const { result, ...change } = next;
      const status = await this.store.commit({ ...change, receipt: { scope, key, hash, result } });
      if (status === "committed") return result;
    }
    throw new MemoryError("conflict", "Concurrent changes prevented this write. Retry with the same idempotency key.", true);
  }
}

function links(input: WorkLinks): WorkLinks {
  return { ...(input.components ? { components: input.components } : {}), ...(input.features ? { features: input.features } : {}) };
}
