import { accessSync, constants, lstatSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const installationRelativePath = '.agents/skills/use-skilly/installation.json';
export const runtimePath = fileURLToPath(new URL('../dist/runtime/local/main.js', import.meta.url));

// Installation data is separate from private Codex settings. Never interpret it as code.
export function installationData(project, db) {
  return { version: 1, project, db, node: process.execPath, runtime: runtimePath };
}

export function regularPath(path, directory = false) {
  let current = path;
  while (true) {
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || (current === path && !directory ? !stat.isFile() : !stat.isDirectory())) throw new Error('Unsafe path');
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

export function readInstallation(path) {
  regularPath(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 16384) throw new Error('Invalid installation file');
    const bytes = Buffer.alloc(16385);
    const size = readSync(fd, bytes, 0, bytes.length, 0);
    if (size > 16384) throw new Error('Oversized installation data');
    const value = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    const keys = ['version', 'project', 'db', 'node', 'runtime'];
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
      || Object.keys(value).length !== keys.length || !keys.every(k => k in value)
      || keys.slice(1).some(k => typeof value[k] !== 'string' || !isAbsolute(value[k]) || value[k].includes('\0'))) throw new Error('Invalid installation data');
    return value;
  } finally { closeSync(fd); }
}

export function diagnoseInstallation(project, db, path = join(project, installationRelativePath)) {
  let value;
  try { value = readInstallation(path); }
  catch (error) { return { status: error.code === 'ENOENT' ? 'missing' : 'invalid', connection_verified: false }; }
  const expected = installationData(project, db);
  const mismatches = ['project', 'db', 'node', 'runtime'].filter(k => value[k] !== expected[k]);
  let runtimeAvailable = false;
  try { regularPath(value.runtime); regularPath(value.node); accessSync(value.node, constants.X_OK); runtimeAvailable = true; } catch { /* Report unavailable, never run an unknown path. */ }
  return { status: mismatches.length ? 'path_mismatch' : runtimeAvailable ? 'paths_match' : 'runtime_unavailable',
    mismatched_fields: mismatches, runtime_available: runtimeAvailable, connection_verified: false };
}

// access(2) is only a preflight in this process; it cannot prove a future host's sandbox grant.
export function diagnoseExecutionAccess(db) {
  try {
    regularPath(dirname(db), true);
    accessSync(dirname(db), constants.R_OK | constants.W_OK | constants.X_OK);
    for (const file of [db, `${db}-wal`, `${db}-shm`]) {
      try { regularPath(file); accessSync(file, constants.R_OK | constants.W_OK); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { status: 'appears_writable', write_verified: false, host_sandbox: 'not_checked' };
  } catch (error) {
    return { status: error.code === 'ENOENT' ? 'parent_missing' : error.code === 'EACCES' || error.code === 'EPERM' ? 'access_denied' : 'unsafe_or_unavailable',
      write_verified: false, host_sandbox: 'not_checked' };
  }
}
