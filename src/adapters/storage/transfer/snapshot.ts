import { chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { validateRecoveryPair } from "./recovery.js";
import type { Manifest } from "../../../core/transfer/format.js";
import { readDatabase } from "./database.js";
import { checkFile, digest, fail, newDirectory, readManifest, writeNew } from "./files.js";
import { readEvents, validateEventPair } from "./events.js";
import { hasAuthority } from "../sqlite/project-authority.js";

export function openSnapshots(path: string, includeEvents = false) {
  let recovery: DatabaseSync | undefined, main: DatabaseSync | undefined, events: DatabaseSync | undefined;
  let eventsAt: string | null = null;
  try {
    // Events may reference main records. Pin events first, then read the newer main view.
    if (includeEvents) {
      try { lstatSync(`${path}.events.sqlite`); events = readEvents(`${path}.events.sqlite`); eventsAt = new Date().toISOString(); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
    // prepare(request) -> main receipt -> acknowledge(request). This order must not be reversed.
    try { lstatSync(`${path}.recovery.sqlite`); recovery = readDatabase(`${path}.recovery.sqlite`, true); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    const recoveryAt = recovery ? new Date().toISOString() : null;
    main = readDatabase(path);
    if (recovery) validateRecoveryPair(main, recovery);
    if (events) validateEventPair(main, events);
    return { main, recovery, events, eventsAt, recoveryAt, mainAt: new Date().toISOString(), close() { main?.close(); recovery?.close(); events?.close(); } };
  } catch (error) { main?.close(); recovery?.close(); events?.close(); throw error; }
}
export async function copySnapshot(db: DatabaseSync, path: string): Promise<void> {
  // Own a 0600 reservation inside the exclusive 0700 output directory. backup overwrites only this file.
  writeNew(path, "");
  await backup(db, path, { rate: 100 });
  chmodSync(path, 0o600);
  // Bundle hashes must cover all data: turn only this newly owned copy into a self-contained file.
  const copy = new DatabaseSync(path);
  try {
    copy.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
    // A physical backup is a retained copy, never a second active writer.
    if(hasAuthority(copy))copy.prepare("UPDATE project_authority SET state='blocked'").run();
  } finally { copy.close(); }
}
export async function copyDatabase(path: string, output: string) {
  const snapshots = openSnapshots(path, true);
  try {
    newDirectory(output);
    await copySnapshot(snapshots.main, join(output, "memory.sqlite"));
    if (snapshots.recovery) await copySnapshot(snapshots.recovery, join(output, "memory.sqlite.recovery.sqlite"));
    if (snapshots.events) await copySnapshot(snapshots.events, join(output, "memory.sqlite.events.sqlite"));
    const manifest: Manifest = { format: "skilly-local-transfer", version: snapshots.events ? 2 : 1, kind: "backup", schema_version: Number(snapshots.main.prepare("PRAGMA user_version").get()?.["user_version"]) as Manifest["schema_version"],
      created_at: new Date().toISOString(), recovery_snapshot_at: snapshots.recoveryAt, main_snapshot_at: snapshots.mainAt,
      project_id: null, rows: null, files: { main: digest(join(output, "memory.sqlite")),
        recovery: snapshots.recovery ? digest(join(output, "memory.sqlite.recovery.sqlite")) : null,
        ...(snapshots.events ? { events: digest(join(output, "memory.sqlite.events.sqlite")) } : {}) } };
    validateBackupFiles(output, manifest);
    return { manifest, result: { status: "completed", directory: output, db: join(output, "memory.sqlite"),
      recovery: manifest.files.recovery ? "included" : "absent", events: snapshots.events ? "included" : "absent",
      snapshot: snapshots.events ? "events_then_recovery_then_main" : "recovery_then_main", automatic_replay: false,
      ...(snapshots.events ? { event_linkage: "preserved_original_roots_and_sessions", atomic_cross_database_snapshot: false } : {}) } };
  } finally { snapshots.close(); }
}
export function rejectBundleOverlays(directory: string): void {
  for (const name of ["memory.sqlite", "memory.sqlite.recovery.sqlite", "memory.sqlite.events.sqlite"]) {
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      try { lstatSync(join(directory, name + suffix)); }
      catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
      fail("unsealed_bundle", "Backup must be a closed self-contained bundle without SQLite sidecars. Nothing was deleted.");
    }
  }
}
function validateBackupFiles(directory: string, manifest: Manifest): void {
  rejectBundleOverlays(directory);
  if (manifest.project_id !== null || manifest.rows !== null) fail("invalid_bundle", "Invalid backup manifest.");
  for (const [name, declared] of [["memory.sqlite.events.sqlite", Boolean(manifest.files.events)], ["memory.sqlite.recovery.sqlite", Boolean(manifest.files.recovery)]] as const) {
    if (declared) continue;
    try { lstatSync(join(directory, name)); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") continue; throw error; }
    fail("unsealed_bundle", "Undeclared companion file; nothing was restored.");
  }
  checkFile(join(directory, "memory.sqlite"), manifest.files.main);
  const main = readDatabase(join(directory, "memory.sqlite"));
  try {
    if (manifest.files.recovery) {
      checkFile(join(directory, "memory.sqlite.recovery.sqlite"), manifest.files.recovery);
      const journal = readDatabase(join(directory, "memory.sqlite.recovery.sqlite"), true);
      try {
        validateRecoveryPair(main, journal);
      } finally { journal.close(); }
    }
    if (manifest.files.events) {
      checkFile(join(directory, "memory.sqlite.events.sqlite"), manifest.files.events);
      const events = readEvents(join(directory, "memory.sqlite.events.sqlite"));
      try { validateEventPair(main, events); } finally { events.close(); }
    }
  } finally { main.close(); }
}
export async function backupDatabase(path: string, output: string) {
  const copy = await copyDatabase(path, output);
  writeNew(join(output, "manifest.json"), JSON.stringify(copy.manifest));
  return copy.result;
}
export async function restoreDatabase(input: string, output: string) {
  const manifest = readManifest(input, "backup");
  validateBackupFiles(input, manifest);
  const copy = await copyDatabase(join(input, "memory.sqlite"), output);
  // Reject replacement/changes to the input before publishing a completed output.
  rejectBundleOverlays(input);
  checkFile(join(input, "memory.sqlite"), manifest.files.main);
  if (manifest.files.recovery) checkFile(join(input, "memory.sqlite.recovery.sqlite"), manifest.files.recovery);
  if (manifest.files.events) checkFile(join(input, "memory.sqlite.events.sqlite"), manifest.files.events);
  if (Boolean(copy.manifest.files.recovery) !== Boolean(manifest.files.recovery)) fail("bundle_changed", "Recovery companion changed during restore.");
  if (Boolean(copy.manifest.files.events) !== Boolean(manifest.files.events)) fail("bundle_changed", "Event companion changed during restore.");
  writeNew(join(output, "manifest.json"), JSON.stringify(copy.manifest));
  return { ...copy.result, operation: "restore" };
}
