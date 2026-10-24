import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { MemoryError } from "../../core/memory/model.js";
import { digest, managedPath, type Snapshot } from "../../core/skills/update.js";
import { safeDirectory } from "./package-files.js";

export function missing(error: unknown) { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
export function exists(path: string) { try { lstatSync(path); return true; } catch (error) { if (missing(error)) return false; throw error; } }
export function directoryId(path: string) { safeDirectory(path); const s = lstatSync(path); return `${s.dev}:${s.ino}`; }
export function target(root: string, tool: "codex" | "cursor", folder: string) {
  safeDirectory(root);
  const path = join(root, tool === "codex" ? ".agents" : ".cursor", "skills", folder);
  safeDirectory(path); return path;
}
export function statePath(path: string, installation: string) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new MemoryError("invalid_path", "Use a normalized absolute state directory.");
  const skills = dirname(installation);
  if (path === skills || path.startsWith(skills + sep) || skills.startsWith(path + sep))
    throw new MemoryError("invalid_path", "Recovery state must be separate from the installed skills directory.");
  safeDirectory(dirname(path)); return path;
}
export function readBounded(path: string, limit = 256 * 1024): { bytes: Buffer; snapshot: Omit<Snapshot, "path"> } {
  safeDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw new MemoryError("unsafe_file", "Expected a regular bounded file.");
    const atPath = lstatSync(path, { bigint: true });
    if (atPath.isSymbolicLink() || atPath.dev !== before.dev || atPath.ino !== before.ino) throw new MemoryError("unsafe_file", "File identity changed.");
    const buffer = Buffer.alloc(limit + 1); let length = 0, count;
    while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) > 0) length += count;
    safeDirectory(dirname(path));
    const after = fstatSync(fd, { bigint: true }), current = lstatSync(path, { bigint: true });
    if (length > limit || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino)
      throw new MemoryError("unsafe_file", "File changed during bounded read.");
    const bytes = buffer.subarray(0, length);
    return { bytes, snapshot: { state: "present", hash: digest(bytes), identity: { dev: String(before.dev), ino: String(before.ino), mode: Number(before.mode & 0o777n),
      size: String(before.size), mtime: String(before.mtimeNs), ctime: String(before.ctimeNs) } } };
  } finally { closeSync(fd); }
}
export function snapshot(base: string, path: string, limit = 256 * 1024): Snapshot {
  managedPath.parse(path);
  try { return { path, ...readBounded(join(base, path), limit).snapshot }; }
  catch (error) { return { path, state: missing(error) ? "missing" : "unavailable", hash: null, identity: null }; }
}
export function sameFile(a: Snapshot, b: Snapshot) { return JSON.stringify(a) === JSON.stringify(b); }
export function sameInode(a: Snapshot, b: Snapshot) {
  return a.state === "present" && b.state === "present" && a.identity?.ino === b.identity?.ino && a.identity?.dev === b.identity?.dev;
}
export function ensureParents(path: string, base: string) {
  safeDirectory(base);
  const relative = dirname(path).slice(base.length);
  let parent = base;
  for (const part of relative.split(sep).filter(Boolean)) {
    parent = join(parent, part);
    try { mkdirSync(parent, { mode: 0o700 }); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
    safeDirectory(parent);
  }
}
export function writeNew(path: string, bytes: string | Buffer, mode = 0o600) {
  safeDirectory(dirname(path));
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { fchmodSync(fd, mode); writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
export function syncDirectory(path: string) {
  safeDirectory(path); const fd = openSync(path, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
