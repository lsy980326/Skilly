import { createHash } from "node:crypto";
import type { z } from "zod";
import type { Context, JsonObject } from "../memory/model.js";
import { MemoryError } from "../memory/model.js";
import { registerSkillSchema, skillContentText } from "./schema.js";
export { skillKey, packagePath, registerSkillSchema, observationFilesSchema } from "./schema.js";

export function skillContentHash(body: string, files: { path: string; content: string }[]): string {
  return createHash("sha256").update(skillContentText(body, files)).digest("hex");
}
export type SkillVersion = Omit<z.infer<typeof registerSkillSchema>, "idempotency_key" | "files"> & {
  files: { path: string; content: string }[]; content_hash: string; created_at: string;
};
export type Installation = { id: string; project_id: string; skill_key: string; version: string; repository: string; environment: string;
  project_root: string; tool: "codex" | "cursor"; folder: string; assigned_at: string };
export type FileObservation = { path: string; state: "matches" | "modified" | "missing" | "unavailable"; hash: string | null; bytes: number | null };
export type Observation = { id: string; project_id: string; installation_id: string; version: string; expected_hash: string;
  observed_at: string; state: FileObservation["state"]; files: FileObservation[] };
export type SkillChange = { version?: SkillVersion; installation?: Installation; observation?: Observation };
export interface SkillRepository {
  receipt(projectId: string, key: string, hash: string): JsonObject | undefined;
  source(projectId: string, key: string): string | undefined;
  version(projectId: string, key: string, version: string): SkillVersion | undefined;
  installation(projectId: string, id: string): Installation | undefined;
  save(projectId: string, key: string, hash: string, result: JsonObject, change: SkillChange): JsonObject;
  listForComponent(projectId: string, offset: number, limit: number, query: string, component?: string): JsonObject;
  detail(projectId: string, key: string, version?: string, installationOffset?: number, component?: string): JsonObject;
}
export interface SkillObserver { readonly root: string; observe(installation: Installation, version: SkillVersion): FileObservation[]; }
export class SkillLibrary {
  constructor(private readonly store: SkillRepository, private readonly context: Context, private readonly observer?: SkillObserver) {}
  register(input: z.infer<typeof registerSkillSchema>): JsonObject {
    const { idempotency_key, ...data } = input;
    const version: SkillVersion = { ...data, files: input.files, content_hash: skillContentHash(input.body, input.files), created_at: this.context.now() };
    const source = this.store.source(input.project_id, input.skill_key);
    if (source && source !== input.source) throw new MemoryError("source_conflict", "Use another skill key for a different source.");
    const existing = this.store.version(input.project_id, input.skill_key, input.version);
    if (existing && (existing.content_hash !== version.content_hash || existing.source !== version.source || existing.name !== version.name
      || existing.description !== version.description || existing.install_instructions !== version.install_instructions)) {
      throw new MemoryError("version_conflict", "A skill version is immutable. Use a new version for changed content or metadata.");
    }
    return this.store.save(input.project_id, idempotency_key, this.context.hash({ operation: "register-skill", ...data }),
      { status: "persisted", skill_key: data.skill_key, version: data.version, content_hash: version.content_hash, evidence: "supplied_content", loading_status: "unknown" },
      existing ? {} : { version });
  }
  assign(input: { project_id: string; skill_key: string; version: string; repository: string; environment: string;
    tool: "codex" | "cursor"; folder: string; idempotency_key: string }): JsonObject {
    if (!this.observer) throw new MemoryError("project_root_required", "Use a connection launched with --project for installation assignment and inspection.");
    if (!this.store.version(input.project_id, input.skill_key, input.version)) throw new MemoryError("not_found", "Register this skill version first.");
    const { idempotency_key, ...data } = input;
    const installation: Installation = { ...data, id: this.context.id(), project_root: this.observer.root, assigned_at: this.context.now() };
    return this.store.save(input.project_id, idempotency_key, this.context.hash({ operation: "assign-skill", ...data, project_root: this.observer.root }),
      { status: "persisted", installation_id: installation.id, version: input.version, observation: "not_checked" }, { installation });
  }
  inspect(input: { project_id: string; installation_id: string; repository: string; environment: string; idempotency_key: string }): JsonObject {
    const payloadHash = this.context.hash({ operation: "inspect-skill", ...input });
    const installation = this.store.installation(input.project_id, input.installation_id);
    if (!installation) throw new MemoryError("not_found", "Installation not found in this project.");
    if (!this.observer || installation.project_root !== this.observer.root) throw new MemoryError("scope_mismatch", "This connection cannot inspect another project root. Imported paths are historical data.");
    if (installation.repository !== input.repository || installation.environment !== input.environment) throw new MemoryError("scope_mismatch", "Installation belongs to another repository or environment.");
    const receipt = this.store.receipt(input.project_id, input.idempotency_key, payloadHash);
    if (receipt) return receipt;
    const version = this.store.version(input.project_id, installation.skill_key, installation.version);
    if (!version) throw new MemoryError("not_found", "Assigned version is unavailable.");
    const files = this.observer.observe(installation, version);
    const state = files.some(f => f.state === "unavailable") ? "unavailable" : files.some(f => f.state === "missing") ? "missing"
      : files.some(f => f.state === "modified") ? "modified" : "matches";
    const observation: Observation = { id: this.context.id(), project_id: input.project_id, installation_id: installation.id,
      version: installation.version, expected_hash: version.content_hash, observed_at: this.context.now(), state, files };
    return this.store.save(input.project_id, input.idempotency_key, payloadHash,
      { status: "persisted", observation_id: observation.id, installation_id: installation.id, state, observed_at: observation.observed_at,
        evidence: "local_files_at_observation_time", loading_status: "unknown", automatic_install: false }, { observation });
  }
  list(projectId: string, offset: number, limit: number, query: string, component?: string): JsonObject { return this.store.listForComponent(projectId, offset, limit, query, component); }
  detail(projectId: string, key: string, version?: string, installationOffset?: number, component?: string): JsonObject { return this.store.detail(projectId, key, version, installationOffset, component); }
}
