import { createHash, randomUUID } from "node:crypto";
import { MemoryError } from "../../../core/memory/model.js";

export function createMemoryContext() {
  return { id: randomUUID, now: () => new Date().toISOString(),
    hash: (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex") };
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new MemoryError("invalid_input", "Unsupported input value.");
  return encoded;
}
