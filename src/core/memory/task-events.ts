import type { JsonObject } from "./model.js";

export interface TaskEvents {
  link(projectId: string, runId: string, observationId: string): Promise<JsonObject>;
  status(projectId: string, runId: string): JsonObject;
}
