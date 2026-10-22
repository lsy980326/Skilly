import { createMemoryContext } from "../../adapters/storage/sqlite/context.js";
import { DocumentImporter } from "../../core/documents/importer.js";
import { SubmittedMarkdownLibrary } from "../../adapters/documents/markdown.js";
import { SkillLibrary } from "../../core/skills/model.js";
import { LocalSkillObserver } from "../../adapters/skills/local-observer.js";
import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { MemoryService } from "../../core/memory/service.js";
import { MemoryError } from "../../core/memory/model.js";
import { SqliteMemoryStore } from "../../adapters/storage/sqlite/store.js";
import { ToolDispatcher } from "../../transport/tools.js";
import { BoundMemory, type ProjectBinding } from "../../core/memory/binding.js";
import { WriteRecovery } from "../../core/memory/recovery.js";
import { SqliteRecoveryJournal } from "../../adapters/storage/sqlite/recovery-journal.js";
import { readLifecycle } from "../../adapters/storage/sqlite/lifecycle.js";
import { boundSourceProvider } from "../../adapters/project/source-version.js";

export function openLocal(path: string, binding?: ProjectBinding, projectRoot?: string) {
  if (!isAbsolute(path)) throw new MemoryError("invalid_path", "Use an absolute local database path.");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  if (!lstatSync(path).isFile()) throw new MemoryError("invalid_path", "The database must be a regular local file.");
  const store = new SqliteMemoryStore(path, binding && projectRoot ? boundSourceProvider(projectRoot, binding) : undefined);
  const context = createMemoryContext();
  const service = new MemoryService(store, context);
  const journal = new SqliteRecoveryJournal(`${path}.recovery.sqlite`);
  const recovery = new WriteRecovery(store, journal, context,
    binding && projectRoot ? () => readLifecycle(path, binding, projectRoot) : undefined);
  const skills = new SkillLibrary(store.skills, context, projectRoot ? new LocalSkillObserver(projectRoot) : undefined);
  const documents = projectRoot ? new SubmittedMarkdownLibrary(binding?.component ? "component:" + binding.component.key : "root:" + createHash("sha256").update(projectRoot).digest("hex"), new DocumentImporter(store, context)) : undefined;
  const dispatcher = new ToolDispatcher(service, binding ? new BoundMemory(service, binding) : undefined, recovery, skills, documents, store.taskEvents(projectRoot));
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
