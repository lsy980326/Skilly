import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { WorktreeFingerprint } from "../../core/execution/currentness.js";

const MAX_FILES = 2048, MAX_FILE_BYTES = 1024 * 1024, MAX_BYTES = 16 * MAX_FILE_BYTES;
const SOURCE_EXTENSIONS = new Set(".ts .tsx .mts .cts .js .jsx .mjs .cjs .py .go .rs .java .kt .kts .swift .c .h .cpp .hpp .cs .rb .php .vue .svelte .html .css .scss .sass .less .sql .graphql .gql .md .mdx .sh".split(" "));
const MANIFESTS = /^(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|(?:ts|js)config(?:\.[\w-]+)?\.json|Cargo\.(?:toml|lock)|go\.(?:mod|sum)|pom\.xml|requirements(?:-[\w-]+)?\.txt|pyproject\.toml|(?:yarn|pnpm-lock)\.(?:lock|yaml))$/;

/** Fixed public-source policy. No dotenv, credentials, private settings or arbitrary DB-supplied paths. */
function publicSource(path: string) {
  const parts = path.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || p.startsWith(".")
    || /^(?:node_modules|dist|build|coverage|vendor|secrets?|credentials?|passwords?|passwd|tokens?|private|auth|certs?|keys?)$/i.test(p))) return false;
  const name = basename(path);
  if (/(?:^|[._-])(?:env|secrets?|credentials?|passwords?|passwd|auth|tokens?|private|keys?|local)(?:[._-]|$)/i.test(name)) return false;
  return SOURCE_EXTENSIONS.has(extname(name)) || MANIFESTS.test(name);
}

class Incomplete extends Error {
  constructor(readonly reason: "limit_exceeded" | "excluded_changes" | "unsafe_entry" | "unstable" | "read_failed") { super(reason); }
}
function changedPaths(status: string) {
  const entries = status.split("\0"), paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]; if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") throw new Incomplete("read_failed");
    paths.push(entry.slice(3));
    if (/[RC]/.test(entry.slice(0, 2))) { const old = entries[++i]; if (!old) throw new Incomplete("read_failed"); paths.push(old); }
  }
  return paths;
}

/** Two bounded reads detect ordinary concurrent edits. Endpoints cannot prove no edit-and-revert between them. */
export function fingerprintWorktree(root: string, status: string, git: (args: string[]) => string): WorktreeFingerprint {
  const policy = "public_source_v1" as const, started = performance.now();
  let files = 0, bytes = 0, excluded = 0;
  const check = () => { if (performance.now() - started > 1000) throw new Incomplete("limit_exceeded"); };
  try {
    const ignored = new Set(git(["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"]).split("\0").filter(Boolean));
    if (changedPaths(status).some(path => !publicSource(path) || ignored.has(path))) throw new Incomplete("excluded_changes");
    const manifest = () => {
      check();
      const paths = [...new Set(git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]).split("\0").filter(Boolean))].sort();
      if (paths.length > MAX_FILES) throw new Incomplete("limit_exceeded");
      return paths;
    };
    const all = manifest(), selected = all.filter(path => publicSource(path) && !ignored.has(path)); excluded = all.length - selected.length;
    const digest = () => {
      const hash = createHash("sha256").update(policy + "\0"); files = 0; bytes = 0;
      for (const path of selected) {
        check(); const absolute = join(root, path);
        // Reject parent symlinks as well as leaf symlinks before opening any content.
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) {
          try { if (lstatSync(join(root, ...parts.slice(0, i))).isSymbolicLink()) throw new Incomplete("unsafe_entry"); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") break; throw error; }
        }
        let stat;
        try { stat = lstatSync(absolute); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          hash.update(JSON.stringify([path, "missing"]) + "\0"); files++; continue;
        }
        if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(absolute) !== absolute) throw new Incomplete("unsafe_entry");
        if (stat.size > MAX_FILE_BYTES || bytes + stat.size > MAX_BYTES) throw new Incomplete("limit_exceeded");
        const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = fstatSync(fd);
          if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size) throw new Incomplete("unstable");
          hash.update(JSON.stringify([path, stat.mode & 0o111, stat.size]) + "\0");
          const chunk = Buffer.alloc(64 * 1024); let size = 0, n: number;
          while ((n = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
            size += n; bytes += n; check();
            if (size > MAX_FILE_BYTES || bytes > MAX_BYTES) throw new Incomplete("limit_exceeded");
            hash.update(chunk.subarray(0, n));
          }
          const after = fstatSync(fd), atPath = lstatSync(absolute);
          if (size !== stat.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
            || atPath.dev !== after.dev || atPath.ino !== after.ino || realpathSync(absolute) !== absolute) throw new Incomplete("unstable");
          hash.update("\0"); files++;
        } finally { closeSync(fd); }
      }
      return hash.digest("hex");
    };
    const first = digest();
    if (JSON.stringify(manifest()) !== JSON.stringify(all) || digest() !== first) throw new Incomplete("unstable");
    check();
    return { policy, status: "collected", sha256: first, files, bytes, excluded };
  } catch (error) {
    return { policy, status: "unavailable", reason: error instanceof Incomplete ? error.reason : "read_failed" };
  }
}
