import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { MemoryError } from "../../core/memory/model.js";
import { parseSkillPackage, type SkillPackage } from "../../core/skills/package.js";
import { skillKey, type SkillVersion } from "../../core/skills/model.js";
import { LocalSkillObserver } from "./local-observer.js";

function safeDirectory(path: string): void {
  if (!isAbsolute(path) || resolve(path) !== path) throw new MemoryError("invalid_path", "Use a normalized absolute path.");
  let current = parse(path).root;
  for (const part of path.slice(current.length).split("/").filter(Boolean)) {
    current = join(current, part);
    const info = lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new MemoryError("invalid_path", "Directories must not be symlinks.");
  }
}
export function readSkillPackage(path: string): SkillPackage {
  if (!isAbsolute(path)) throw new MemoryError("invalid_path", "Use an absolute package path.");
  safeDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 128 * 1024) throw new MemoryError("invalid_package", "Package must be a regular file up to 128 KiB.");
    const bytes = Buffer.alloc(128 * 1024 + 1);
    // readFileSync would be unbounded if the file grows after fstat.
    let length = 0, count;
    while (length < bytes.length && (count = readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > 128 * 1024) throw new MemoryError("invalid_package", "Package exceeds 128 KiB.");
    let value: unknown;
    try { value = JSON.parse(bytes.subarray(0, length).toString("utf8")); }
    catch { throw new MemoryError("invalid_package", "Package is not valid JSON."); }
    return parseSkillPackage(value);
  } finally { closeSync(fd); }
}

export function verifySkillPackage(p: SkillPackage, root: string, tool: "codex" | "cursor", folder = p.skill_key) {
  skillKey.parse(folder); safeDirectory(root);
  const version: SkillVersion = { ...p, project_id: "00000000-0000-4000-8000-000000000000", created_at: "" };
  const files = new LocalSkillObserver(root).observe({ id: "", project_id: version.project_id, skill_key: p.skill_key, version: p.version,
    repository: "", environment: "", project_root: root, tool, folder, assigned_at: "" }, version);
  return { state: files.every(f => f.state === "matches") ? "matches" : files.some(f => f.state === "unavailable") ? "unavailable" : files.some(f => f.state === "missing") ? "missing" : "modified",
    files, content_hash: p.content_hash, observed_at: new Date().toISOString(), loading_status: "unknown", scripts_executed: false };
}

export function installSkillPackage(p: SkillPackage, root: string, tool: "codex" | "cursor", folder = p.skill_key) {
  skillKey.parse(folder); safeDirectory(root);
  let parent = root;
  for (const part of [tool === "codex" ? ".agents" : ".cursor", "skills"]) {
    parent = join(parent, part);
    try { mkdirSync(parent, { mode: 0o700 }); }
    catch (error) { if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error; }
    safeDirectory(parent);
  }
  const target = join(parent, folder);
  // Reserve a NEW target before writing. No existing folder, including empty ones, is replaced.
  try { mkdirSync(target, { mode: 0o700 }); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new MemoryError("installation_exists", `Existing skill folder preserved: ${target}. Choose another --folder or inspect the existing installation.`);
    throw error;
  }
  try {
    for (const file of [{ path: "SKILL.md", content: p.body }, ...p.files]) {
      const path = join(target, file.path);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); safeDirectory(dirname(path));
      writeFileSync(path, file.content, { flag: "wx", mode: 0o600 });
    }
    const observation = verifySkillPackage(p, root, tool, folder);
    if (observation.state !== "matches") throw new MemoryError("installation_incomplete", "Files changed during installation; inspect the retained folder.");
    return { status: "installed", path: target, ...observation, automatic_loading: false };
  } catch (error) {
    // Keep partial output for inspection. Never remove user data or report partial output as installed.
    throw new MemoryError("installation_incomplete", `Installation incomplete at ${target}; output retained. ${error instanceof Error ? error.message : "Inspect files."}`);
  }
}
