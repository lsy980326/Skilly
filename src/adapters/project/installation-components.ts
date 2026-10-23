import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { loadProjectBinding } from "./binding.js";
import type { InstallationComponent } from "../../core/viewer/components.js";

import type { ProjectBinding } from "../../core/memory/binding.js";
import { z } from "zod";
const allowlist = z.strictObject({ version: z.literal(1), projects: z.array(z.string().min(1).max(1024)).max(15) });

/** Read only public bindings under explicit host roots, never paths supplied by stored installations. */
export function installationComponents(roots: string[]): InstallationComponent[] {
  if (roots.length > 16 || Buffer.byteLength(JSON.stringify(roots)) > 1536) throw new Error("Source project roots exceed the local control limit.");
  return roots.flatMap(root => {
    if (!isAbsolute(root)) throw new Error("Source projects require absolute paths.");
    const path = realpathSync(root), binding = loadProjectBinding(path);
    return binding.component ? [{ root: path, project_key: binding.key, repository: binding.repository, environment: binding.environment, ...binding.component }] : [];
  });
}

/** Optional public host allowlist. This never reads Codex config or DB-supplied roots. */
export function projectInstallationComponents(root: string, binding?: ProjectBinding): InstallationComponent[] {
  const own = binding ? (binding.component ? [{ root: realpathSync(root), project_key: binding.key, repository: binding.repository, environment: binding.environment, ...binding.component }] : []) : installationComponents([root]);
  let descriptor: number;
  try { descriptor = openSync(join(root, "skilly.components.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return own;
    throw error;
  }
  try {
    const stat = fstatSync(descriptor), bytes = Buffer.alloc(4097);
    if (!stat.isFile() || stat.size > 4096) throw new Error("Component allowlist must be a regular file of at most 4 KiB.");
    let size = 0;
    while (size < bytes.length) {
      const n = readSync(descriptor, bytes, size, bytes.length - size, null);
      if (!n) break;
      size += n;
    }
    if (size > 4096) throw new Error("Component allowlist exceeds 4 KiB.");
    const value = JSON.parse(bytes.subarray(0, size).toString("utf8")) as unknown;
    const parsed = allowlist.parse(value);
    const roots = [...new Set([root, ...parsed.projects])];
    if (roots.length > 16 || Buffer.byteLength(JSON.stringify(roots)) > 1536) throw new Error("Source project roots exceed the local control limit.");
    if (roots.some(path => !isAbsolute(path))) throw new Error("Source projects require absolute paths.");
    return [...own, ...installationComponents(roots.filter(path => realpathSync(path) !== realpathSync(root)))];
  } finally { closeSync(descriptor); }
}
