import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute, join, parse, resolve } from "node:path";
import type { FileObservation, Installation, SkillObserver, SkillVersion } from "../../core/skills/model.js";
import { packagePath, skillKey } from "../../core/skills/model.js";

function noLinks(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new Error("Unsafe root");
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("Symlink");
  }
}
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
/** Inspect only registered package paths under the root supplied by the current launch. Never execute content. */
export class LocalSkillObserver implements SkillObserver {
  constructor(readonly root: string) {}
  observe(installation: Installation, version: SkillVersion): FileObservation[] {
    const files = [{ path: "SKILL.md", content: version.body }, ...version.files];
    let rootValid = false, totalBytes = 0;
    try { noLinks(this.root); rootValid = lstatSync(this.root).isDirectory(); } catch { /* Each file is reported unavailable below. */ }
    return files.map(file => {
      const base = { path: file.path, hash: null, bytes: null };
      if (!rootValid || !skillKey.safeParse(installation.folder).success || installation.project_root !== this.root || (file.path !== "SKILL.md" && !packagePath.safeParse(file.path).success)) {
        return { ...base, state: "unavailable" };
      }
      let fd: number | undefined;
      try {
        const directory = installation.tool === "codex" ? ".agents" : ".cursor";
        const path = join(this.root, directory, "skills", installation.folder, file.path);
        noLinks(path);
        if (!lstatSync(path).isFile()) throw new Error("Not a regular file");
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = fstatSync(fd, { bigint: true });
        if (!before.isFile() || before.size > 256n * 1024n) throw new Error("Oversized file");
        noLinks(path);
        const openedPath = lstatSync(path, { bigint: true });
        if (openedPath.isSymbolicLink() || openedPath.ino !== before.ino || openedPath.dev !== before.dev) throw new Error("Path changed before read");
        const digest = createHash("sha256"), buffer = Buffer.alloc(32 * 1024);
        let count, bytes = 0;
        while ((count = readSync(fd, buffer)) > 0) {
          bytes += count; totalBytes += count;
          if (bytes > 256 * 1024 || totalBytes > 2 * 1024 * 1024) throw new Error("Read limit");
          digest.update(buffer.subarray(0, count));
        }
        noLinks(path);
        const after = fstatSync(fd, { bigint: true }), pathStat = lstatSync(path, { bigint: true });
        if (before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || before.size !== after.size
          || pathStat.isSymbolicLink() || pathStat.ino !== before.ino || pathStat.dev !== before.dev) throw new Error("File changed");
        const actual = digest.digest("hex");
        return { path: file.path, hash: actual, bytes, state: actual === hash(file.content) ? "matches" : "modified" };
      } catch (error) {
        return { ...base, state: error instanceof Error && "code" in error && error.code === "ENOENT" && fd === undefined ? "missing" : "unavailable" };
      } finally { if (fd !== undefined) closeSync(fd); }
    });
  }
}
