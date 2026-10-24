import { z } from "zod";
import { MemoryError, parseJsonObject, type JsonObject, type JsonValue } from "../../../core/memory/model.js";
import type { D1Binding } from "./binding.js";

export const d1ScopeSchema = z.strictObject({ project_id: z.uuid(), repository: z.string().min(1).max(100), environment: z.string().min(1).max(100) });
export type D1Scope = z.infer<typeof d1ScopeSchema>;
export type Sql = (sql: string, ...values: (string | number | null)[]) => void;
export const json = (value: unknown): JsonObject => parseJsonObject(JSON.stringify(value));
export const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export function bounded(value: JsonObject, limit = 128 * 1024): JsonObject {
  if (bytes(value) > limit) throw new MemoryError("resource_limit", "D1 business response limit reached; no complete state was returned.");
  return value;
}
export function scope(input: D1Scope): D1Scope {
  const parsed = d1ScopeSchema.safeParse(input);
  if (!parsed.success) throw new MemoryError("invalid_input", "An exact D1 project/repository/environment is required.");
  return parsed.data;
}
export async function rows(db: D1Binding, sql: string, values: (string | number | null)[], max: number): Promise<JsonObject[]> {
  const result = await db.withSession("first-primary").prepare(sql).bind(...values).all();
  if (!result.success || !Array.isArray(result.results) || result.results.length > max) throw new MemoryError("storage_error", "Invalid bounded D1 result.");
  return result.results.map(json);
}
export function array(value: JsonValue | undefined): JsonObject[] {
  if (typeof value !== "string") throw new MemoryError("resource_limit", "Business snapshot is incomplete or exceeds its byte limit.");
  const decoded: unknown = JSON.parse(value);
  if (!Array.isArray(decoded)) throw new MemoryError("invalid_data", "Expected a saved JSON array.");
  return decoded.map(json);
}
export async function hashText(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,"0")).join("");
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  const result=JSON.stringify(value);
  if (result === undefined) throw new MemoryError("invalid_input", "Invalid JSON value.");
  return result;
}
