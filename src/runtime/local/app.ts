import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { MemoryService } from "../../core/memory/service.js";
import { MemoryError } from "../../core/memory/model.js";
import { SqliteMemoryStore } from "../../adapters/storage/sqlite/store.js";
import { ToolDispatcher } from "../../transport/tools.js";
import { BoundMemory, type ProjectBinding } from "../../core/memory/binding.js";

export function openLocal(path: string, binding?: ProjectBinding) {
  if (!isAbsolute(path)) throw new MemoryError("invalid_path", "Use an absolute local database path.");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  if (!lstatSync(path).isFile()) throw new MemoryError("invalid_path", "The database must be a regular local file.");
  const store = new SqliteMemoryStore(path);
  const service = new MemoryService(store, {
    id: randomUUID, now: () => new Date().toISOString(),
    hash: value => createHash("sha256").update(canonical(value)).digest("hex"),
  });
  const dispatcher = new ToolDispatcher(service, binding ? new BoundMemory(service, binding) : undefined);
  let closing: Promise<void> | undefined;
  return {
    dispatcher,
    close() {
      closing ??= dispatcher.drain().then(() => { store.close(); });
      return closing;
    },
  };
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
