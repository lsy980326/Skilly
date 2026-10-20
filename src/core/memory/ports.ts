import type { MemoryRecord, Mutation, Project, Receipt, RecordQuery, Run } from "./model.js";

/** Storage owns atomicity; domain rules are computed before a versioned commit. */
export interface MemoryStore {
  getProject(id: string): Promise<Project | undefined>;
  findProject(key: string): Promise<Project | undefined>;
  listProjects(after: string, limit: number): Promise<Project[]>;
  getRun(projectId: string, runId: string): Promise<Run | undefined>;
  getRecord(projectId: string, recordId: string): Promise<MemoryRecord | undefined>;
  getReceipt(scope: string, key: string): Promise<Receipt | undefined>;
  commit(mutation: Mutation): Promise<"committed" | "conflict">;
  query(input: RecordQuery): Promise<MemoryRecord[]>;
  maxSequence(projectId: string): Promise<number>;
}
