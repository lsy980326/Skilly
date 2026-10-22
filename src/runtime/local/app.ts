import { DocumentImporter } from "../../core/documents/importer.js";
import { SubmittedMarkdownLibrary } from "../../adapters/documents/markdown.js";
import { SkillLibrary } from "../../core/skills/model.js";
import { LocalSkillObserver } from "../../adapters/skills/local-observer.js";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { MemoryService } from "../../core/memory/service.js";
import { MemoryError } from "../../core/memory/model.js";
import { SqliteMemoryStore } from "../../adapters/storage/sqlite/store.js";
import { ToolDispatcher } from "../../transport/tools.js";
import { BoundMemory, type ProjectBinding } from "../../core/memory/binding.js";
import { WriteRecovery } from "../../core/memory/recovery.js";
import { SqliteRecoveryJournal } from "../../adapters/storage/sqlite/recovery-journal.js";

export function openLocal(path: string, binding?: ProjectBinding, projectRoot?: string) {
  if (!isAbsolute(path)) throw new MemoryError("invalid_path", "Use an absolute local database path.");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  if (!lstatSync(path).isFile()) throw new MemoryError("invalid_path", "The database must be a regular local file.");
  const store = new SqliteMemoryStore(path);
  const context = {
    id: randomUUID, now: () => new Date().toISOString(),
    hash: (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex"),
  };
  const service = new MemoryService(store, context);
  const journal = new SqliteRecoveryJournal(`${path}.recovery.sqlite`);
  const recovery = new WriteRecovery(store, journal, context);
  const skills = new SkillLibrary(store.skills, context, projectRoot ? new LocalSkillObserver(projectRoot) : undefined);
  const documents = projectRoot ? new SubmittedMarkdownLibrary(binding?.component ? "component:" + binding.component.key : "root:" + createHash("sha256").update(projectRoot).digest("hex"), new DocumentImporter(store, context)) : undefined;
  const dispatcher = new ToolDispatcher(service, binding ? new BoundMemory(service, binding) : undefined, recovery, skills, documents);
  let closing: Promise<void> | undefined;
  return {
    dispatcher,
    executions: store.executions,
    close() {
      closing ??= dispatcher.drain().then(() => { journal.close(); store.close(); });
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
