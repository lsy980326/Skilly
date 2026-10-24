import { closeSync, existsSync, readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { bundleLines, checkFile, fail, fileDescriptor, newDirectory, readManifest, writeNew } from "./files.js";
import { MAX_DATA_BYTES } from "../../../core/transfer/format.js";
import { exportProject, importProject } from "./project.js";
import { restoreDatabase } from "./snapshot.js";
import type { AuthorityRow } from "../sqlite/project-authority.js";

const selectionSchema = z.strictObject({ transfer_id: z.uuid(),
  slot: z.string().regex(/^return-attempt-[a-f0-9-]{36}$/),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  backup: z.string().nullable() });
type Selection = z.infer<typeof selectionSchema>;
function selection(directory: string): Selection | undefined {
  const path = join(directory, "return-selection.json");
  if (!existsSync(path)) return;
  const fd = fileDescriptor(path, 4096);
  try { return selectionSchema.parse(JSON.parse(readFileSync(fd, "utf8"))); }
  finally { closeSync(fd); }
}
export function returnPath(directory: string): string {
  const selected = selection(directory);
  return selected ? join(directory, selected.slot, "copy", "memory.sqlite") : join(directory, "return", "memory.sqlite");
}
// Full selected-project rows, including requests and events. Snapshot timestamps
// and DB-local record sequences are not logical content or backup freshness.
function contentHash(directory: string): string {
  const manifest = readManifest(directory, "project"), hash = createHash("sha256");
  for (const [name, descriptor] of [["data.ndjson", manifest.files.main], ["events.ndjson", manifest.files.events]] as const) {
    hash.update(name + "\n");
    if (!descriptor) continue;
    const path = join(directory, name); checkFile(path, descriptor);
    const fd = fileDescriptor(path, MAX_DATA_BYTES);
    try {
      for (const line of bundleLines(fd)) {
        const entry = z.object({ table: z.string(), row: z.record(z.string(), z.unknown()) }).parse(JSON.parse(line));
        if (name === "data.ndjson") delete entry.row["source_seq"];
        hash.update(JSON.stringify(entry) + "\n");
      }
    } finally { closeSync(fd); }
  }
  return hash.digest("hex");
}
export async function prepareReturnCopy(directory: string, target: string, authority: AuthorityRow, backup?: string): Promise<string> {
  const selected = selection(directory);
  if (selected) {
    if (selected.transfer_id !== authority.transfer_id || (backup !== undefined && selected.backup !== backup))
      fail("authority_conflict", "A different recovery selection is already durable; nothing was reopened.");
    const root = join(directory, selected.slot), manifest = readManifest(join(root, "export"), "project");
    if (manifest.project_id !== authority.project_id || manifest.files.main.sha256 !== selected.source_sha256)
      fail("invalid_transfer", "Selected recovery bundle differs.");
    checkFile(join(root, "export", "data.ndjson"), manifest.files.main);
    if (manifest.files.events) checkFile(join(root, "export", "events.ndjson"), manifest.files.events);
    const fd = fileDescriptor(join(root, "copy", "import.json"), 4096);
    try {
      const receipt = z.object({ project_id: z.uuid(), source_sha256: z.string(), source_events_sha256: z.string().optional() }).parse(JSON.parse(readFileSync(fd, "utf8")));
      if (receipt.project_id !== authority.project_id || receipt.source_sha256 !== manifest.files.main.sha256 || receipt.source_events_sha256 !== manifest.files.events?.sha256)
        fail("invalid_transfer", "Recovery completion receipt differs from its selected bundle.");
    } finally { closeSync(fd); }
    return returnPath(directory);
  }
  // Each explicit retry owns new paths. Incomplete exports/imports are retained,
  // never appended to, removed, or selected by directory timestamps.
  const slot = "return-attempt-" + randomUUID(), root = join(directory, slot);
  newDirectory(root);
  writeNew(join(root, "attempt.json"), JSON.stringify({ transfer_id: authority.transfer_id, slot, backup: backup ?? null }));
  const latest = join(root, "latest"); exportProject(target, authority.project_id, latest);
  let input = latest;
  if (backup !== undefined) {
    const restored = await restoreDatabase(backup, join(root, "backup"));
    input = join(root, "export"); exportProject(restored.db, authority.project_id, input);
    if (contentHash(latest) !== contentHash(input))
      fail("stale_backup", "Backup differs from the latest fenced project, including requests or events. All copies remain fenced; no records were discarded.");
  } else {
    // Separate immutable export and latest comparison are only needed for backup.
    input = join(root, "export"); exportProject(target, authority.project_id, input);
  }
  await importProject(input, join(root, "copy"), undefined, authority);
  const manifest = readManifest(input, "project");
  writeNew(join(directory, "return-selection.json"), JSON.stringify({ transfer_id: authority.transfer_id, slot,
    source_sha256: manifest.files.main.sha256, backup: backup ?? null }));
  return returnPath(directory);
}
