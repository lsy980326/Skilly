import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ProjectBinding } from "../../core/memory/binding.js";
import type { SourceObservation, SourceProvider } from "../../core/execution/currentness.js";
import { loadProjectBinding } from "./binding.js";
import { fingerprintWorktree } from "./worktree-fingerprint.js";
import { SOURCE_LIMITS } from "../../core/execution/source-limits.js";

function git(root: string, args: string[]) {
  // File inventories grow with repository size, unlike scalar HEAD/root responses.
  // Keep both bounded: a failed/truncated listing must never establish equality.
  const listing = args[0] === "status" || args[0] === "ls-files";
  const r = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, ...args],
    { encoding: "utf8", timeout: 1500, maxBuffer: listing ? SOURCE_LIMITS.git_listing_bytes : 128 * 1024, windowsHide: true });
  if (r.error || r.status !== 0 || (listing && r.stdout && !r.stdout.endsWith("\0")))
    throw new Error("Git metadata unavailable");
  return r.stdout;
}
export function observeSource(root: string, binding: ProjectBinding): SourceObservation {
  const base = { version: 1 as const, root_hash: createHash("sha256").update(root).digest("hex"),
    project_key: binding.key, repository: binding.repository, environment: binding.environment, observed_at: new Date().toISOString() };
  try {
    if (realpathSync(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== realpathSync(root))
      return { ...base, status: "unavailable", commit: null, reason: "not_repository_root" };
    const before = git(root, ["rev-parse", "--verify", "HEAD"]).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(before)) throw new Error("Invalid commit");
    const dirty = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"]);
    // Hidden/unmerged index entries cannot establish a complete public-source comparison.
    const hidden = () => git(root, ["ls-files", "-v", "-z"]).split("\0").some(entry => /^[a-zSM]/.test(entry));
    if (hidden())
      return { ...base, status: "unavailable", commit: null, reason: "index_entries_unobserved" };
    const worktree = fingerprintWorktree(root, dirty, args => git(root, args));
    const after = git(root, ["rev-parse", "--verify", "HEAD"]).trim();
    if (hidden()) return { ...base, status: "unavailable", commit: null, reason: "index_entries_unobserved" };
    return { ...base, status: dirty || before !== after ? "dirty" : "clean", commit: after,
      reason: dirty || before !== after ? "working_tree_changed" : null,
      worktree: before === after ? worktree : { policy: "public_source_v1", status: "unavailable", reason: "unstable" } };
  } catch { return { ...base, status: "unavailable", commit: null, reason: "git_unavailable" }; }
}

/** The MCP host has already resolved this binding; no second project-file read is required. */
export function boundSourceProvider(root: string, binding: ProjectBinding): SourceProvider {
  let canonical: string;
  try { canonical = realpathSync(root); } catch { return () => undefined; }
  const hash = createHash("sha256").update(canonical).digest("hex");
  return recorded => recorded.root_hash === hash && recorded.project_key === binding.key
    && recorded.repository === binding.repository && recorded.environment === binding.environment
    ? observeSource(canonical, binding) : undefined;
}

/** Only explicit host startup roots; never follow DB/HTTP/skill-record paths as an execution target. */
export function sourceProvider(roots: string[]): SourceProvider {
  if (roots.length > 16 || Buffer.byteLength(JSON.stringify(roots)) > 1536) throw new Error("Source project roots exceed the local control limit (16 roots / 1536 bytes).");
  const allowed = roots.map(root => {
    if (!isAbsolute(root)) throw new Error("Source projects require absolute paths.");
    const path = realpathSync(root), binding = loadProjectBinding(path);
    return { path, binding, hash: createHash("sha256").update(path).digest("hex") };
  });
  return recorded => {
    const configured = allowed.find(x => x.hash === recorded.root_hash && x.binding.key === recorded.project_key
      && x.binding.repository === recorded.repository && x.binding.environment === recorded.environment);
    if (!configured) return undefined;
    try { return observeSource(configured.path, loadProjectBinding(configured.path)); }
    catch { return { ...recorded, observed_at: new Date().toISOString(), status: "unavailable", commit: null, reason: "git_unavailable" }; }
  };
}
