import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { MemoryError } from "../../../core/memory/model.js";
import { manifestSchema, MAX_DATA_BYTES, MAX_LINE_BYTES, type Manifest } from "../../../core/transfer/format.js";

export function fail(code: string, message: string): never { throw new MemoryError(code, message); }
export function safePath(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) fail("invalid_path", "Use a normalized absolute local path.");
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) fail("invalid_path", "Symbolic links are not supported."); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
}
export function fileDescriptor(path: string, maxBytes = Number.MAX_SAFE_INTEGER): number {
  safePath(path);
  if (!lstatSync(path).isFile()) fail("invalid_file", "Expected an existing regular file.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size > maxBytes) { closeSync(fd); fail("invalid_file", "Expected a regular file within the size limit."); }
  return fd;
}
export function digest(path: string, maxBytes = Number.MAX_SAFE_INTEGER): { sha256: string; bytes: number } {
  const fd = fileDescriptor(path, maxBytes), hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024);
  let bytes = 0;
  try { let count; while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) { bytes += count; if (bytes > maxBytes) fail("transfer_limit", "Input grew beyond its declared size."); hash.update(buffer.subarray(0, count)); } }
  finally { closeSync(fd); }
  return { sha256: hash.digest("hex"), bytes };
}
export function newDirectory(path: string): void {
  safePath(path); safePath(dirname(path));
  try { mkdirSync(path, { mode: 0o700 }); }
  catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") fail("destination_exists", "Destination must be a new directory; nothing was overwritten."); throw error; }
}
export function writeNew(path: string, content: string): void { writeFileSync(path, content, { flag: "wx", mode: 0o600, flush: true }); }
export function readManifest(directory: string, kind: Manifest["kind"]): Manifest {
  const fd = fileDescriptor(join(directory, "manifest.json"), 16 * 1024);
  try {
    const parsed = manifestSchema.parse(JSON.parse(readFileSync(fd, "utf8")));
    if (parsed.kind !== kind) fail("invalid_bundle", "Bundle kind does not match this command.");
    return parsed;
  } catch (error) { if (error instanceof MemoryError) throw error; return fail("invalid_bundle", "Invalid or unsupported bundle manifest."); }
  finally { closeSync(fd); }
}
export function checkFile(path: string, expected: { sha256: string; bytes: number }): void {
  const actual = digest(path, expected.bytes);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) fail("checksum_mismatch", "Bundle data is incomplete or changed; hashes are not signatures.");
}

export function* bundleLines(fd: number): Generator<string> {
  const buffer = Buffer.alloc(64 * 1024);
  let pending = Buffer.alloc(0), count, offset = 0;
  while ((count = readSync(fd, buffer, 0, buffer.length, offset)) > 0) {
    offset += count; pending = Buffer.concat([pending, buffer.subarray(0, count)]);
    let end;
    while ((end = pending.indexOf(10)) !== -1) {
      if (end + 1 > MAX_LINE_BYTES) fail("transfer_limit", "Oversized bundle row.");
      yield new TextDecoder("utf-8", { fatal: true }).decode(pending.subarray(0, end));
      pending = pending.subarray(end + 1);
    }
    if (pending.length > MAX_LINE_BYTES || offset > MAX_DATA_BYTES) fail("transfer_limit", "Oversized bundle data.");
  }
  if (pending.length) fail("invalid_bundle", "Incomplete NDJSON row.");
}
