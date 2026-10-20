import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { MemoryError } from "../../core/memory/model.js";
import type { ProjectBinding } from "../../core/memory/binding.js";

const scope = z.string().trim().min(1).max(100);
const schema = z.strictObject({
  version: z.literal(1),
  key: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  name: scope,
  repository: scope,
  environment: scope,
});

export function loadProjectBinding(root: string): ProjectBinding {
  if (!isAbsolute(root)) throw new MemoryError("invalid_path", "--project must be an absolute directory.");
  // Never inspect remotes, environment files or parent directories to guess identity.
  const descriptor = openSync(join(root, "skilly.project.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4096) {
      throw new MemoryError("invalid_binding", "Project binding must be a regular JSON file of at most 4 KiB.");
    }
    // Bound the read itself as well as stat: a file can grow after fstat.
    const buffer = Buffer.alloc(4097);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > 4096) throw new MemoryError("invalid_binding", "Project binding exceeds 4 KiB.");
    let value: unknown;
    try { value = JSON.parse(buffer.subarray(0, length).toString("utf8")); }
    catch { throw new MemoryError("invalid_binding", "Invalid project binding JSON."); }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new MemoryError("invalid_binding", "Invalid skilly.project.json fields.");
    return parsed.data;
  } finally { closeSync(descriptor); }
}
