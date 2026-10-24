import { MemoryError, type JsonObject } from "./model.js";
import type { MemoryService } from "./service.js";
import type { Component } from "../work/model.js";

export interface ProjectBinding {
  version: 1;
  key: string;
  name: string;
  repository: string;
  environment: string;
  component?: Component | undefined;
}

/** A configured MCP connection has one scope, even when the DB holds many projects. */
export class BoundMemory {
  constructor(private readonly service: MemoryService, readonly binding: ProjectBinding, private readonly writable?: (id:string)=>boolean) {}

  async resolve(): Promise<JsonObject> {
    const existing=await this.service.findProject(this.binding.key);
    if(existing && existing.name!==this.binding.name)throw new MemoryError("scope_mismatch","Configured project name differs.");
    const readOnly=existing && this.writable?.(existing.id)===false;
    const result = readOnly ? { project: {id:existing.id} } : await this.service.registerProject({
      key: this.binding.key, name: this.binding.name,
      idempotency_key: `binding:v1:${this.binding.key}`,
    });
    const project = object(result["project"]);
    const id = project["id"];
    if (typeof id !== "string") throw new MemoryError("invalid_data", "Project identity is missing.");
    if (this.binding.component && !readOnly) await this.service.registerComponent(id, this.binding.component);
    return {
      project: { id, key: this.binding.key, name: this.binding.name },
      scope: { repository: this.binding.repository, environment: this.binding.environment },
      ...(this.binding.component ? { component: this.binding.component } : {}),
      capture: "agent_reports_only", currentness: "unverified",
      next_tool: "memory_query_context",
    };
  }

  async assertScope(tool: string, input: unknown): Promise<void> {
    if (tool === "memory_resolve_project") return;
    const args = object(input);
    const project = await this.service.findProject(this.binding.key);
    if (!project) throw new MemoryError("project_unresolved", "Call memory_resolve_project before using this connection.");
    if (project.name !== this.binding.name || args["project_id"] !== project.id) {
      throw new MemoryError("scope_mismatch", "Use the project_id returned by memory_resolve_project.");
    }
    for (const field of ["repository", "environment"] as const) {
      if (args[field] !== undefined && args[field] !== this.binding[field]) {
        throw new MemoryError("scope_mismatch", "This connection is bound to another repository or environment.");
      }
    }
    if (typeof args["run_id"] === "string") {
      const result = await this.service.getStatus(project.id, args["run_id"]);
      this.assertRecordScope(object(result["run"]));
    }
    if (typeof args["record_id"] === "string") {
      const result = await this.service.getEvidence(project.id, args["record_id"]);
      this.assertRecordScope(object(result["record"]));
    }
  }

  private assertRecordScope(value: Record<string, unknown>): void {
    if (value["repository"] !== this.binding.repository || value["environment"] !== this.binding.environment) {
      throw new MemoryError("scope_mismatch", "This record or task belongs to another repository or environment.");
    }
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MemoryError("invalid_input", "Expected an object.");
  }
  return value as Record<string, unknown>;
}
