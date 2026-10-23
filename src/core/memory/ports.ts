import type { MemoryRecord, Mutation, Project, Receipt, RecordQuery, Run } from "./model.js";
import type { WorkReader } from "../work/model.js";
import type { ExecutionReader } from "../execution/model.js";

/** Storage owns atomicity; domain rules are computed before a versioned commit. */
export interface MemoryStore {
  readonly work: WorkReader;
  readonly executions: ExecutionReader;
  getProject(id: string): Promise<Project | undefined>;
  findProject(key: string): Promise<Project | undefined>;
  listProjects(after: string, limit: number): Promise<Project[]>;
  getRun(projectId: string, runId: string): Promise<Run | undefined>;
  getRecord(projectId: string, recordId: string): Promise<MemoryRecord | undefined>;
  getReceipt(scope: string, key: string): Promise<Receipt | undefined>;
  commit(mutation: Mutation): Promise<"committed" | "conflict">;
  query(input: RecordQuery): Promise<MemoryRecord[]>;
  maxSequence(projectId: string): Promise<number>;
  unfinishedRuns(projectId: string, repository: string, environment: string, limit: number, offset: number, component?: string): Promise<Run[]>;
}
