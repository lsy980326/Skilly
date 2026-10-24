import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { MemoryError } from "../../core/memory/model.js";
import { describeUpdate, digest, packageFiles, updateManifestSchema, updatePair, type Snapshot, type UpdateInput, type UpdateManifest } from "../../core/skills/update.js";
import { safeDirectory } from "./package-files.js";
import { directoryId, ensureParents, exists, readBounded, sameFile, sameInode, snapshot, statePath, syncDirectory, target, writeNew } from "./update-files.js";

type IO = { rename: typeof renameSync; link: typeof linkSync };
const ioDefault: IO = { rename: renameSync, link: linkSync };
const lockSchema = z.strictObject({ format: z.literal("skilly-skill-update-lock"), id: z.uuid(), state: z.string(), pid: z.int().positive() });
type Lock = { path: string; identity: string; owner: z.infer<typeof lockSchema> };
type UpdateResult = { status: string; state_directory: string; scripts_executed: false; loading_status: "unknown"; claims_verified: false; database_changed: false;
  version?: string; content_hash?: string; recovery_performed?: boolean; blocked_files?: string[]; update_error?: string; lock_status?: "released" | "release_failed" };
const marker = (id: string, status: string) => JSON.stringify({ id, status });
function complete(state: string, id: string, status: "applied" | "recovered", io: IO) {
  const prepared = join(state, `completion-${status}-${randomUUID()}.json`);
  writeNew(prepared, marker(id, status)); syncDirectory(state);
  // Publish a fully written marker; a failed/partial write never looks complete.
  io.link(prepared, join(state, `${status}.json`));
}
const fileAt = (state: string, directory: string, index: number) => join(state, directory, `${index}.txt`);
function changed(manifest: UpdateManifest) { return describeUpdate(manifest.before, manifest.after, manifest.snapshots).filter(f => f.change !== "unchanged"); }
function lockPath(installation: string) { return join(dirname(installation), `.${installation.split("/").at(-1)}.skilly-update.lock`); }
function inode(path: string) { const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink()) throw new MemoryError("unsafe_file", "Expected a regular operation file."); return `${s.dev}:${s.ino}`; }
function alive(pid: number) { try { process.kill(pid, 0); return true; } catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); } }

function acquire(installation: string, state: string, id: string, recovery = false): Lock {
  const path = lockPath(installation);
  if (exists(path)) {
    const identity = inode(path), prior = lockSchema.parse(JSON.parse(readBounded(path, 4096).bytes.toString("utf8")));
    if (!recovery || prior.id !== id || prior.state !== state || alive(prior.pid)) throw new MemoryError("update_busy", "Another update or recovery owns this installation lock.");
    if (inode(path) !== identity) throw new MemoryError("update_busy", "Update lock changed.");
    renameSync(path, join(state, `abandoned-lock-${randomUUID()}.json`));
  }
  const owner = { format: "skilly-skill-update-lock" as const, id, state, pid: process.pid };
  try { writeNew(path, JSON.stringify(owner)); }
  catch { throw new MemoryError("update_busy", "Could not reserve the installation lock. No existing lock was overwritten."); }
  return { path, owner, identity: inode(path) };
}
function release(lock: Lock, state: string): "released" | "release_failed" {
  try {
    if (inode(lock.path) !== lock.identity) return "release_failed";
    renameSync(lock.path, join(state, `released-lock-${randomUUID()}.json`));
    return "released";
  } catch { return "release_failed"; }
}

export function previewSkillUpdate(input: UpdateInput) {
  const pair = updatePair(input), installation = target(input.root, input.tool, pair.folder);
  let remaining = 2 * 1024 * 1024;
  const snapshots = pair.paths.map(path => { const file = snapshot(installation, path, Math.min(remaining, 256 * 1024)); remaining -= Number(file.identity?.size ?? 0); return file; });
  const rootIdentity = directoryId(input.root), targetIdentity = directoryId(installation);
  const identity = { root: input.root, tool: input.tool, folder: pair.folder, root_identity: rootIdentity, target_identity: targetIdentity,
    before: pair.before, after: pair.after, snapshots };
  const files = describeUpdate(pair.before, pair.after, snapshots);
  return { ...identity, format: "skilly-skill-update-preview" as const, preview_hash: digest(JSON.stringify(identity)),
    applicable: files.every(f => f.conflicts.length === 0), files,
    automatic_apply: false, scripts_executed: false, loading_status: "unknown" as const, claims_verified: false };
}

function assertScope(manifest: UpdateManifest, root: string, tool: "codex" | "cursor", folder: string) {
  const installation = target(root, tool, folder);
  if (manifest.root !== root || manifest.tool !== tool || manifest.folder !== folder
    || manifest.root_identity !== directoryId(root) || manifest.target_identity !== directoryId(installation))
    throw new MemoryError("scope_mismatch", "Recovery requires the same explicit project root, tool, folder and directory identities.");
  return installation;
}
function readManifest(state: string): UpdateManifest {
  safeDirectory(state);
  const m = updateManifestSchema.parse(JSON.parse(readBounded(join(state, "manifest.json"), 512 * 1024).bytes.toString("utf8")));
  const pair = updatePair({ before: m.before, after: m.after, root: m.root, tool: m.tool, folder: m.folder });
  if (JSON.stringify(pair.paths) !== JSON.stringify(m.snapshots.map(f => f.path)) || describeUpdate(m.before, m.after, m.snapshots).some(f => f.conflicts.length))
    throw new MemoryError("invalid_state", "Invalid prepared file set.");
  const identity = { root: m.root, tool: m.tool, folder: m.folder, root_identity: m.root_identity, target_identity: m.target_identity,
    before: m.before, after: m.after, snapshots: m.snapshots };
  if (digest(JSON.stringify(identity)) !== m.preview_hash || JSON.stringify(changed(m).map(f => f.path)) !== JSON.stringify(m.staged.map(f => f.path)))
    throw new MemoryError("invalid_state", "Prepared update identity mismatch.");
  if (m.staged.some((f, i) => f.state !== "present" || !f.identity || f.hash !== digest(changed(m)[i]!.after!)))
    throw new MemoryError("invalid_state", "Invalid staged file identity.");
  return m;
}
function hasMarker(state: string, id: string, status: "applied" | "recovered") {
  const path = join(state, `${status}.json`);
  if (!exists(path)) return false;
  const value: unknown = JSON.parse(readBounded(path, 4096).bytes.toString("utf8"));
  if (JSON.stringify(value) !== marker(id, status)) throw new MemoryError("invalid_state", "Invalid completion marker.");
  return true;
}
function result(status: string, state: string, extra: Partial<Pick<UpdateResult, "version" | "content_hash" | "recovery_performed" | "blocked_files">> = {}): UpdateResult {
  return { status, state_directory: state, ...extra, scripts_executed: false, loading_status: "unknown", claims_verified: false, database_changed: false };
}

function rollback(manifest: UpdateManifest, installation: string, state: string, io: IO) {
  const files = changed(manifest), blocked: string[] = [];
  for (let i = files.length - 1; i >= 0; i--) {
    const file = files[i]!, old = manifest.snapshots.find(s => s.path === file.path)!, fresh = manifest.staged[i]!;
    const destination = join(installation, file.path), backup = fileAt(state, "original", i);
    try {
      assertScope(manifest, manifest.root, manifest.tool, manifest.folder);
      const current = snapshot(installation, file.path);
      if (exists(backup)) {
        const original = readBounded(backup);
        const originalSnapshot = { path: file.path, ...original.snapshot };
        if (!sameInode(originalSnapshot, old) || originalSnapshot.hash !== old.hash || originalSnapshot.identity?.mode !== old.identity?.mode) throw new Error("Backup changed");
        if (current.state === "present" && current.hash === old.hash && current.identity?.mode === old.identity?.mode) continue;
        if (current.state !== "missing") {
          if (!sameInode(current, fresh) || current.hash !== fresh.hash || current.identity?.mode !== fresh.identity?.mode) throw new Error("Current file was changed outside this update");
          io.rename(destination, join(state, "retained", `${i}-${randomUUID()}.txt`));
        }
        const restored = join(state, "restored", `${i}-${randomUUID()}.txt`);
        writeNew(restored, original.bytes, old.identity!.mode);
        io.link(restored, destination);
      } else if (old.state === "missing") {
        if (current.state === "missing") continue;
        if (!sameInode(current, fresh) || current.hash !== fresh.hash || current.identity?.mode !== fresh.identity?.mode) throw new Error("New path was changed outside this update");
        io.rename(destination, join(state, "retained", `${i}-${randomUUID()}.txt`));
      } else if (!sameInode(current, old) || current.hash !== old.hash) throw new Error("Original file unavailable");
    } catch { blocked.push(file.path); }
  }
  if (blocked.length) return result("recovery_blocked", state, { blocked_files: blocked });
  complete(state, manifest.id, "recovered", io);
  return result("recovered", state);
}

export function applySkillUpdate(input: UpdateInput, options: { expect: string; state: string }, io: IO = ioDefault) {
  const preview = previewSkillUpdate(input);
  if (!/^[a-f0-9]{64}$/.test(options.expect) || preview.preview_hash !== options.expect)
    throw new MemoryError("preview_changed", "The approved preview no longer matches. Preview again before applying.");
  if (!preview.applicable) throw new MemoryError("update_conflict", "Local changes, occupied paths or package file removals block this update.");
  const installation = target(input.root, input.tool, preview.folder), state = statePath(options.state, installation);
  if (exists(state)) throw new MemoryError("output_exists", "Use a new recovery directory; existing outputs are preserved.");
  mkdirSync(state, { mode: 0o700 });
  const id = randomUUID(), lock = acquire(installation, state, id);
  let manifest: UpdateManifest | undefined, prepared = false;
  let outcome: ReturnType<typeof result>;
  try {
    for (const part of ["original", "incoming", "retained", "restored"]) mkdirSync(join(state, part), { mode: 0o700 });
    const files = preview.files.filter(f => f.change !== "unchanged"), staged: Snapshot[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!, initial = preview.snapshots.find(s => s.path === file.path)!;
      writeNew(fileAt(state, "incoming", i), file.after!, initial.identity?.mode ?? 0o600);
      staged.push({ path: file.path, ...readBounded(fileAt(state, "incoming", i)).snapshot });
    }
    manifest = { format: "skilly-skill-update", format_version: 1, id, root: input.root, tool: input.tool, folder: preview.folder,
      root_identity: preview.root_identity, target_identity: preview.target_identity, preview_hash: preview.preview_hash,
      before: preview.before, after: preview.after, snapshots: preview.snapshots, staged };
    // The durable intent and staged identities precede every target mutation.
    writeNew(join(state, "manifest.json"), JSON.stringify(manifest)); syncDirectory(state); prepared = true;
    if (previewSkillUpdate(input).preview_hash !== preview.preview_hash) throw new Error("Installation changed during preparation");
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!, initial = preview.snapshots.find(s => s.path === file.path)!;
      assertScope(manifest, input.root, input.tool, preview.folder);
      if (!sameFile(snapshot(installation, file.path), initial)) throw new Error("File changed before replacement");
      const destination = join(installation, file.path);
      ensureParents(destination, installation);
      if (initial.state === "present") {
        io.rename(destination, fileAt(state, "original", i));
        const saved = { path: file.path, ...readBounded(fileAt(state, "original", i)).snapshot };
        if (!sameInode(saved, initial) || saved.hash !== initial.hash) throw new Error("Original moved during replacement");
      }
      // Linking refuses a concurrent occupant rather than overwriting it. The staged link is retained.
      io.link(fileAt(state, "incoming", i), destination);
      syncDirectory(dirname(destination));
    }
    for (const file of packageFiles(manifest.after)) {
      const current = snapshot(installation, file.path), expected = manifest.staged.find(f => f.path === file.path) ?? manifest.snapshots.find(f => f.path === file.path)!;
      if (!sameInode(current, expected) || current.hash !== digest(file.content) || current.identity?.mode !== expected.identity?.mode) throw new Error("Final file comparison failed");
    }
    complete(state, id, "applied", io);
    outcome = result("applied", state, { version: manifest.after.version, content_hash: manifest.after.content_hash });
  } catch (error) {
    try {
      outcome = manifest && prepared
        ? hasMarker(state, id, "applied") ? result("recovery_blocked", state) : rollback(manifest, installation, state, io)
        : result("preparation_failed", state);
    }
    catch { outcome = result("recovery_blocked", state); }
    outcome = { ...outcome, update_error: error instanceof MemoryError ? error.code : "file_operation_failed" };
  }
  return { ...outcome, lock_status: release(lock, state) };
}

export function recoverSkillUpdate(input: { root: string; tool: "codex" | "cursor"; folder: string; state: string }, io: IO = ioDefault) {
  const installation = target(input.root, input.tool, updatePairFolder(input.folder));
  const state = statePath(input.state, installation), manifest = readManifest(state);
  assertScope(manifest, input.root, input.tool, input.folder);
  const completed = hasMarker(state, manifest.id, "applied") ? "applied" : hasMarker(state, manifest.id, "recovered") ? "recovered" : null;
  if (completed && !exists(lockPath(installation))) return result(completed, state, { recovery_performed: false });
  const lock = acquire(installation, state, manifest.id, true);
  let outcome: ReturnType<typeof result>;
  try { outcome = completed ? result(completed, state, { recovery_performed: false }) : rollback(manifest, installation, state, io); }
  catch { outcome = result("recovery_blocked", state); }
  return { ...outcome, lock_status: release(lock, state) };
}
function updatePairFolder(folder: string) { return updateManifestSchema.shape.folder.parse(folder); }
