import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openLocal } from "../dist/runtime/local/app.js";
import { SqliteViewer } from "../dist/adapters/storage/sqlite/viewer.js";
import { backupDatabase, restoreDatabase } from "../dist/adapters/storage/transfer/snapshot.js";
import { exportProject, importProject } from "../dist/adapters/storage/transfer/project.js";
import { initialize } from "../dist/adapters/storage/transfer/database.js";

async function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skilly-skills-"))), db = join(root, "memory.sqlite");
  const binding = { version: 1, key: "library-test", name: "Library test", repository: "web", environment: "development" };
  const app = openLocal(db, binding, root); t.after(() => app.close());
  const call = (name, input) => app.dispatcher.call(name, input);
  const pid = (await call("memory_resolve_project", {})).project.id;
  const register = { project_id: pid, skill_key: "use-sample", version: "1.0", name: "샘플 스킬", source: "local:sample",
    body: "---\nname: use-sample\n---\n# 보관한 스킬\n<img src=x onerror=alert(1)>", files: [{ path: "references/guide.md", content: "참고 원문" }],
    install_instructions: "프로젝트 .agents/skills/use-sample에 설치 후 새 세션에서 확인", idempotency_key: "register" };
  const folder = join(root, ".agents/skills/use-sample"); mkdirSync(join(folder, "references"), { recursive: true });
  writeFileSync(join(folder, "SKILL.md"), register.body); writeFileSync(join(folder, "references/guide.md"), register.files[0].content);
  await call("memory_register_skill", register);
  const assignment = { project_id: pid, skill_key: register.skill_key, version: "1.0", tool: "codex", folder: "use-sample", idempotency_key: "assign" };
  const installed = await call("memory_assign_skill", assignment);
  return { root, db, app, call, pid, register, assignment, folder, id: installed.installation_id,
    inspect: key => call("memory_check_skill_installation", { project_id: pid, installation_id: installed.installation_id, idempotency_key: key }) };
}

test("skill versions are immutable and source-separated; receipts replay without duplicate versions", async t => {
  const f = await fixture(t);
  assert.equal((await f.call("memory_register_skill", f.register)).status, "persisted");
  await assert.rejects(f.call("memory_register_skill", { ...f.register, body: "다른 내용", idempotency_key: "changed" }), { code: "version_conflict" });
  await assert.rejects(f.call("memory_register_skill", { ...f.register, version: "2.0", source: "foreign:sample", idempotency_key: "foreign" }), { code: "source_conflict" });
  await f.call("memory_register_skill", { ...f.register, version: "2.0", body: "새 버전", idempotency_key: "v2" });
  const list = await f.call("memory_list_skills", { project_id: f.pid });
  assert.equal(list.items[0].versions, 2); assert.ok(!JSON.stringify(list).includes(f.register.body));
  const detail = await f.call("memory_get_skill", { project_id: f.pid, skill_key: "use-sample", version: "1.0" });
  assert.equal(detail.skill.body, f.register.body); assert.equal(detail.loading_status, "unknown");
  assert.equal(detail.installations[0].state, "not_checked");
});

test("explicit file inspection distinguishes match, modified, missing and unavailable without installing or claiming loading", async t => {
  const f = await fixture(t), first = await f.inspect("check-1");
  assert.equal(first.state, "matches"); assert.equal(first.loading_status, "unknown");
  writeFileSync(join(f.folder, "SKILL.md"), "수정된 로컬 파일");
  assert.deepEqual(await f.inspect("check-1"), first, "A retry returns the original observation receipt.");
  assert.equal((await f.inspect("check-2")).state, "modified");
  renameSync(join(f.folder, "references/guide.md"), join(f.folder, "references/preserved.md"));
  assert.equal((await f.inspect("check-3")).state, "missing");
  symlinkSync(join(f.folder, "references/preserved.md"), join(f.folder, "references/guide.md"));
  assert.equal((await f.inspect("check-4")).state, "unavailable");
  assert.equal(readFileSync(join(f.folder, "SKILL.md"), "utf8"), "수정된 로컬 파일");
  const detail = await f.call("memory_get_skill", { project_id: f.pid, skill_key: "use-sample" });
  assert.equal(detail.installations[0].files[0].path, "SKILL.md");
  assert.ok(!JSON.stringify(detail.installations[0]).includes("수정된 로컬 파일"), "Observed file bodies are never collected.");
});

test("changing the desired version preserves older observations and requires reinspection", async t => {
  const f = await fixture(t); await f.inspect("before");
  await f.call("memory_register_skill", { ...f.register, version: "2.0", body: "신규", idempotency_key: "v2" });
  const assigned = await f.call("memory_assign_skill", { ...f.assignment, version: "2.0", idempotency_key: "assign-2" });
  assert.equal(assigned.installation_id, f.id);
  const detail = await f.call("memory_get_skill", { project_id: f.pid, skill_key: "use-sample" });
  assert.equal(detail.installations[0].version, "2.0"); assert.equal(detail.installations[0].observed_version, "1.0");
  assert.equal(detail.installations[0].state, "not_checked");
  const raw = new DatabaseSync(f.db, { readOnly: true });
  try { assert.equal(raw.prepare("SELECT count(*) AS n FROM skill_observations").get().n, 1); } finally { raw.close(); }
});

test("private paths, traversal, foreign scope, unbound inspection and imported roots are refused", async t => {
  const f = await fixture(t);
  for (const path of ["../SKILL.md", "references/.env", "references/auth.json", "/etc/passwd", "references/../secrets.md"]) {
    await assert.rejects(f.call("memory_register_skill", { ...f.register, files: [{ path, content: "not read" }], idempotency_key: path }));
  }
  await assert.rejects(f.call("memory_assign_skill", { ...f.assignment, folder: "../elsewhere", idempotency_key: "traversal" }));
  await assert.rejects(f.call("memory_check_skill_installation", { project_id: f.pid, installation_id: f.id, repository: "api", idempotency_key: "wrong-repo" }), { code: "scope_mismatch" });
  await assert.rejects(f.call("memory_get_skill", { project_id: randomUUID(), skill_key: "use-sample" }), { code: "scope_mismatch" });
  const other = realpathSync(mkdtempSync(join(tmpdir(), "skilly-skills-other-")));
  const app = openLocal(f.db, { version: 1, key: "library-test", name: "Library test", repository: "web", environment: "development" }, other); t.after(() => app.close());
  await assert.rejects(app.dispatcher.call("memory_check_skill_installation", { project_id: f.pid, installation_id: f.id, idempotency_key: "other-root" }), { code: "scope_mismatch" });
  const unbound = openLocal(f.db); t.after(() => unbound.close());
  await assert.rejects(unbound.dispatcher.call("memory_assign_skill", { ...f.assignment, idempotency_key: "unbound" }), { code: "project_root_required" });
});

test("read-only viewer serves content and saved observations without touching files or changing the DB", async t => {
  const f = await fixture(t); await f.inspect("check");
  const before = readFileSync(f.db), view = new SqliteViewer(f.db);
  try {
    assert.equal(view.skills(f.pid).items[0].skill_key, "use-sample");
    writeFileSync(join(f.folder, "SKILL.md"), "changed after observation");
    assert.equal(view.skills(f.pid, { key: "use-sample" }).installations[0].state, "matches");
    assert.equal(view.skills(f.pid, { key: "use-sample" }).installations[0].current_machine_verified, false);
  } finally { view.close(); }
  assert.deepEqual(readFileSync(f.db), before);
});

test("v5 skill data survives whole backup and project transfer without becoming a current installation claim", async t => {
  const f = await fixture(t); await f.inspect("snapshot");
  const b = join(f.root, "backup"), e = join(f.root, "export");
  await backupDatabase(f.db, b); exportProject(f.db, f.pid, e);
  const restored = await restoreDatabase(b, join(f.root, "restored")), imported = await importProject(e, join(f.root, "imported"));
  for (const copy of [restored, imported]) {
    const view = new SqliteViewer(copy.db);
    try {
      const detail = view.skills(f.pid, { key: "use-sample" });
      assert.equal(detail.skill.body, f.register.body); assert.equal(detail.installations[0].state, "matches");
      assert.equal(detail.installations[0].current_machine_verified, false); assert.equal(detail.loading_status, "unknown");
    } finally { view.close(); }
  }
});

test("v4 backup and export remain readable; only the import destination migrates to v7", async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skilly-legacy-transfer-"))), path = join(root, "legacy.sqlite");
  const old = new DatabaseSync(path), pid = randomUUID(); initialize(old, false, 4);
  old.prepare("INSERT INTO projects VALUES (?,?,?,?,?)").run(pid, "legacy", "Legacy", 0, new Date().toISOString()); old.close();
  const b = join(root, "backup"), e = join(root, "export"); await backupDatabase(path, b); exportProject(path, pid, e);
  const restored = await restoreDatabase(b, join(root, "restored")), imported = await importProject(e, join(root, "imported"));
  for (const [dbPath, expected] of [[path, 4], [restored.db, 4], [imported.db, 7]]) {
    const db = new DatabaseSync(dbPath, { readOnly: true }); try { assert.equal(db.prepare("PRAGMA user_version").get().user_version, expected); } finally { db.close(); }
  }
  const view = new SqliteViewer(path); try { assert.deepEqual(view.skills(pid).items, []); } finally { view.close(); }
});

test("real CLI --project supplies the root for assignment and explicit inspection", async t => {
  const f = await fixture(t);
  writeFileSync(join(f.root, "skilly.project.json"), JSON.stringify({ version: 1, key: "library-test", name: "Library test", repository: "web", environment: "development" }));
  const invoke = (tool, input) => {
    const result = spawnSync(process.execPath, [new URL("../dist/runtime/local/main.js", import.meta.url).pathname, "call", tool, "--db", f.db, "--project", f.root], { input: JSON.stringify(input), encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const assigned = invoke("memory_assign_skill", { ...f.assignment, idempotency_key: "cli-assign" });
  const checked = invoke("memory_check_skill_installation", { project_id: f.pid, installation_id: assigned.installation_id, idempotency_key: "cli-check" });
  assert.equal(checked.state, "matches"); assert.equal(checked.loading_status, "unknown");
});

test("installation pages expose every assignment instead of silently cutting off later roots", async t => {
  const f = await fixture(t);
  for (let n = 0; n < 8; n++) await f.call("memory_assign_skill", { ...f.assignment, folder: `sample-${n}`, idempotency_key: `slot-${n}` });
  const first = await f.call("memory_get_skill", { project_id: f.pid, skill_key: "use-sample" });
  const next = await f.call("memory_get_skill", { project_id: f.pid, skill_key: "use-sample", installation_offset: first.next_installation_offset });
  assert.equal(first.installations.length, 6); assert.equal(next.installations.length, 3);
  assert.equal(new Set([...first.installations, ...next.installations].map(i => i.id)).size, 9);
});

test("equal observation timestamps select the last saved row and preserve that order through export", async t => {
  const f = await fixture(t); await f.inspect("same-1");
  writeFileSync(join(f.folder, "SKILL.md"), "modified"); await f.inspect("same-2");
  const db = new DatabaseSync(f.db); db.exec("UPDATE skill_observations SET observed_at='2026-10-21T00:00:00.000Z'"); db.close();
  const view = new SqliteViewer(f.db); try { assert.equal(view.skills(f.pid, { key: "use-sample" }).installations[0].state, "modified"); } finally { view.close(); }
  const output = join(f.root, "same-export"); exportProject(f.db, f.pid, output);
  const imported = await importProject(output, join(f.root, "same-import"));
  const next = new SqliteViewer(imported.db); try { assert.equal(next.skills(f.pid, { key: "use-sample" }).installations[0].state, "modified"); } finally { next.close(); }
});

test("malformed imported package JSON never becomes a completed usable library", async t => {
  const f = await fixture(t), bundle = join(f.root, "malformed-export"), output = join(f.root, "malformed-import");
  exportProject(f.db, f.pid, bundle);
  const path = join(bundle, "data.ndjson"), entries = readFileSync(path, "utf8").trimEnd().split("\n").map(JSON.parse);
  entries.find(entry => entry.table === "skill_versions").row.files_json = "{}";
  const data = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n"; writeFileSync(path, data);
  const manifestPath = join(bundle, "manifest.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files.main = { bytes: Buffer.byteLength(data), sha256: createHash("sha256").update(data).digest("hex") };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(importProject(bundle, output)); assert.equal(existsSync(join(output, "import.json")), false);
});

test("import refuses mixed sources and file-state claims that contradict saved hashes", async t => {
  const f = await fixture(t); await f.inspect("observed");
  await f.call("memory_register_skill", { ...f.register, version: "2.0", body: "두 번째", idempotency_key: "v2" });
  for (const kind of ["source", "observation"]) {
    const bundle = join(f.root, `tampered-${kind}`), target = join(f.root, `reject-${kind}`); exportProject(f.db, f.pid, bundle);
    const path = join(bundle, "data.ndjson"), entries = readFileSync(path, "utf8").trimEnd().split("\n").map(JSON.parse);
    if (kind === "source") entries.filter(entry => entry.table === "skill_versions")[1].row.source = "foreign:source";
    else {
      const row = entries.find(entry => entry.table === "skill_observations").row;
      const files = JSON.parse(row.files_json); files[0].hash = "0".repeat(64); row.files_json = JSON.stringify(files);
    }
    const data = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n"; writeFileSync(path, data);
    const manifestPath = join(bundle, "manifest.json"), manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files.main = { bytes: Buffer.byteLength(data), sha256: createHash("sha256").update(data).digest("hex") }; writeFileSync(manifestPath, JSON.stringify(manifest));
    await assert.rejects(importProject(bundle, target)); assert.equal(existsSync(join(target, "import.json")), false);
  }
});
