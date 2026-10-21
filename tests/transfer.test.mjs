import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, realpathSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openLocal } from "../dist/runtime/local/app.js";
import { backupDatabase, restoreDatabase, openSnapshots } from "../dist/adapters/storage/transfer/snapshot.js";
import { exportProject, importProject } from "../dist/adapters/storage/transfer/project.js";
import { SqliteViewer } from "../dist/adapters/storage/sqlite/viewer.js";

// Keep test files in this isolated OS temp directory; maintenance never deletes inputs or partial outputs.
const root = realpathSync(mkdtempSync(join(tmpdir(), "skilly-transfer-")));
let counter = 0;
const destination = label => join(root, `${++counter}-${label}`);
const hash = path => createHash("sha256").update(readFileSync(path)).digest("hex");
async function sample(t, key = "first") {
  const db = `${destination(key)}.sqlite`, app = openLocal(db);
  t.after(() => app.close());
  const call = (name, args) => app.dispatcher.call(name, args);
  const pid = (await call("memory_register_project", { key, name: key, idempotency_key: `register-${key}` })).project.id;
  const begin = { project_id: pid, goal: `${key} 기능 유지보수`, mode: "change", actor: "Codex", repository: "web", environment: "development",
    title: `${key} 작업`, components: [{ key: "web", name: "Web" }], features: [{ key: "comments", name: "댓글" }], idempotency_key: `start-${key}` };
  const run = (await call("memory_begin_task", begin)).run.id;
  const input = { project_id: pid, run_id: run, topic: "comments", kind: "change", body: `${key} 댓글 원문`, report_origin: "contemporaneous", idempotency_key: "original" };
  const record = (await call("memory_checkpoint", input)).record_id;
  const correction = (await call("memory_checkpoint", { ...input, body: `${key} 댓글 정정`, supersedes: record, idempotency_key: "corrected",
    report: { title: "댓글 정정", summary: "원문을 보존해 정정", technical: { files: ["src/comments.ts"], record_ids: [record] }, checks: [{ name: "로컬 검사", result: "not_run" }], feature_updates: [{ key: "comments", state: "in_progress", summary: "검사 전" }] } })).record_id;
  await call("memory_checkpoint", { ...input, body: `${key} 소급 보고`, report_origin: "retrospective", idempotency_key: "retro" });
  return { db, app, call, pid, begin, run, record, correction };
}
function counts(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return Object.fromEntries(["projects", "runs", "records", "receipts", "record_reports"].map(name => [name, db.prepare(`SELECT count(*) AS n FROM ${name}`).get().n])); }
  finally { db.close(); }
}
function rewriteBundle(directory, change) {
  const path = join(directory, "data.ndjson"), manifestPath = join(directory, "manifest.json");
  const rows = readFileSync(path, "utf8").trimEnd().split("\n").map(JSON.parse);
  change(rows);
  const data = rows.map(row => JSON.stringify(row)).join("\n") + "\n";
  writeFileSync(path, data);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.files.main = { sha256: hash(path), bytes: Buffer.byteLength(data) };
  manifest.rows = rows.length;
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

test("online backup includes committed WAL, recovery tombstones and restores to a new path", async t => {
  const f = await sample(t);
  const original = counts(f.db), before = hash(f.db), journalBefore = hash(`${f.db}.recovery.sqlite`);
  const output = destination("backup");
  const backed = await backupDatabase(f.db, output);
  assert.equal(backed.status, "completed");
  assert.equal(backed.recovery, "included");
  assert.deepEqual(counts(backed.db), original);
  assert.equal(hash(f.db), before);
  assert.equal(hash(`${f.db}.recovery.sqlite`), journalBefore);
  assert.equal(statSync(output).mode & 0o777, 0o700);
  assert.equal(statSync(backed.db).mode & 0o777, 0o600);
  const restored = await restoreDatabase(output, destination("restored"));
  assert.deepEqual(counts(restored.db), original);
  const app = openLocal(restored.db); t.after(() => app.close());
  const replay = await app.dispatcher.call("memory_begin_task", f.begin);
  assert.equal(replay.run.id, f.run, "Idempotency receipts survive restore.");
  assert.equal(replay.run.state, "active");
  await assert.rejects(restoreDatabase(output, output), error => error.code === "destination_exists");
});

test("project export/import preserves history, identities, links, receipts and excludes the other project", async t => {
  const f = await sample(t, "isolated");
  const other = (await f.call("memory_register_project", { key: "private-other", name: "DO-NOT-EXPORT", idempotency_key: "private-register" })).project.id;
  await f.call("memory_begin_task", { project_id: other, goal: "FOREIGN-SECRET", mode: "change", idempotency_key: "private-run" });
  const before = counts(f.db), output = destination("export");
  exportProject(f.db, f.pid, output);
  const text = readFileSync(join(output, "data.ndjson"), "utf8");
  assert.ok(!text.includes(other)); assert.ok(!text.includes("FOREIGN-SECRET")); assert.ok(!text.includes("DO-NOT-EXPORT"));
  assert.ok(!text.includes('"table":"record_search"'));
  const imported = await importProject(output, destination("imported"));
  const app = openLocal(imported.db); t.after(() => app.close());
  const projects = await app.dispatcher.call("memory_list_projects", {});
  assert.deepEqual(projects.projects.map(p => p.id), [f.pid]);
  const evidence = await app.dispatcher.call("memory_get_evidence", { project_id: f.pid, record_id: f.record });
  assert.equal(evidence.record.superseded_by, f.correction); assert.equal(evidence.verified, false);
  const correction = await app.dispatcher.call("memory_get_evidence", { project_id: f.pid, record_id: f.correction });
  assert.deepEqual(correction.record.report.technical, { files: ["src/comments.ts"], record_ids: [f.record] });
  const query = await app.dispatcher.call("memory_query_context", { project_id: f.pid, repository: "web", environment: "development", query: "정정" });
  assert.equal(query.records[0].id, f.correction);
  assert.equal(query.records[0].knowledge_status, "unknown");
  const view = new SqliteViewer(imported.db);
  try { assert.equal(view.runs(f.pid).items[0].actor, "Codex"); assert.equal(view.runs(f.pid).items[0].features[0].key, "comments"); }
  finally { view.close(); }
  assert.equal((await app.dispatcher.call("memory_begin_task", f.begin)).run.id, f.run);
  assert.deepEqual(counts(f.db), before);
});

test("import can merge into a new copy of a different multi-project DB; collisions never overwrite the base", async t => {
  const f = await sample(t, "source"), base = await sample(t, "base"), output = destination("merge-export");
  exportProject(f.db, f.pid, output);
  const before = counts(base.db), beforeHash = hash(base.db);
  const merged = await importProject(output, destination("merged"), base.db);
  assert.equal(counts(merged.db).projects, 2);
  assert.deepEqual(counts(base.db), before); assert.equal(hash(base.db), beforeHash);
  const failed = destination("conflict");
  await assert.rejects(importProject(output, failed, merged.db));
  assert.equal(existsSync(join(failed, "import.json")), false);
  assert.equal(counts(merged.db).projects, 2);
});

test("corrupt checksums, unknown tables, cross-project rows and dangling references fail without activation", async t => {
  const f = await sample(t, "validation");
  for (const modify of [
    rows => { rows[0].table = "sqlite_schema"; },
    rows => { rows.find(row => row.table === "records").row.project_id = "00000000-0000-4000-8000-000000000000"; },
    rows => { rows.find(row => row.table === "records").row.run_id = "00000000-0000-4000-8000-000000000000"; },
    rows => { rows[0].row.arbitrary = "unsupported"; },
  ]) {
    const bundle = destination("malformed-export"), target = destination("malformed-import");
    exportProject(f.db, f.pid, bundle); rewriteBundle(bundle, modify);
    await assert.rejects(importProject(bundle, target));
    assert.equal(existsSync(join(target, "import.json")), false);
  }
  const bundle = destination("corrupt-export"); exportProject(f.db, f.pid, bundle);
  writeFileSync(join(bundle, "data.ndjson"), "tampered");
  await assert.rejects(importProject(bundle, destination("corrupt-import")), error => error.code === "checksum_mismatch");
});

test("paths, foreign databases, unsupported schema and existing outputs are refused", async t => {
  const f = await sample(t, "safe");
  await assert.rejects(backupDatabase("relative.sqlite", destination("relative")), error => error.code === "invalid_path");
  const link = `${destination("link")}.sqlite`; symlinkSync(f.db, link);
  await assert.rejects(backupDatabase(link, destination("linked")), error => error.code === "invalid_path");
  const existing = destination("occupied"); writeFileSync(existing, "preserve");
  await assert.rejects(backupDatabase(f.db, existing), error => error.code === "destination_exists");
  assert.equal(readFileSync(existing, "utf8"), "preserve");
  const foreign = `${destination("foreign")}.sqlite`, db = new DatabaseSync(foreign); db.exec("CREATE TABLE private_data (body TEXT)"); db.close();
  await assert.rejects(backupDatabase(foreign, destination("foreign-backup")), error => error.code === "unsupported_database");
  const snapshots = openSnapshots(f.db);
  try { assert.equal(snapshots.main.prepare("PRAGMA query_only").get().query_only, 1); }
  finally { snapshots.close(); }
  assert.equal(lstatSync(f.db).isFile(), true);
});

test("CLI exposes all four commands and performs synthetic backup/restore without touching its input", async t => {
  const f = await sample(t, "cli");
  const cli = new URL("../dist/runtime/local/main.js", import.meta.url);
  const execute = args => {
    const result = spawnSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8", timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
  };
  const backed = execute(["backup", "--db", f.db, "--output", destination("cli-backup")]);
  const restored = execute(["restore", "--input", backed.directory, "--output", destination("cli-restore")]);
  assert.deepEqual(counts(restored.db), counts(f.db));
  const exported = execute(["export", "--db", f.db, "--project-id", f.pid, "--output", destination("cli-export")]);
  const imported = execute(["import", "--input", exported.directory, "--output", destination("cli-import")]);
  assert.equal(counts(imported.db).projects, 1);
});

test("backup and project import retain failed writes without replay; an explicit retry preserves the original key", async t => {
  const f = await sample(t, "pending"), lock = new DatabaseSync(f.db);
  const input = { project_id: f.pid, run_id: f.run, topic: "comments", kind: "note", body: "실패 후 보존할 원문", idempotency_key: "pending-checkpoint", report_origin: "contemporaneous" };
  lock.exec("BEGIN IMMEDIATE");
  try { await assert.rejects(f.call("memory_checkpoint", input), error => error.code === "busy" && error.recovery.pending_retained === true); }
  finally { lock.exec("ROLLBACK"); lock.close(); }
  const before = counts(f.db), backup = destination("pending-backup"), bundle = destination("pending-export");
  await backupDatabase(f.db, backup); exportProject(f.db, f.pid, bundle);
  const restored = await restoreDatabase(backup, destination("pending-restored"));
  const imported = await importProject(bundle, destination("pending-imported"));
  for (const copy of [restored, imported]) {
    assert.deepEqual(counts(copy.db), before, "Copying must never run pending work.");
    const app = openLocal(copy.db); t.after(() => app.close());
    const scope = { project_id: f.pid, repository: "web", environment: "development" };
    const status = await app.dispatcher.call("memory_recovery_status", scope);
    assert.equal(status.requests.length, 1);
    assert.equal(status.requests[0].original_input_retained, true);
    const receipt = await app.dispatcher.call("memory_retry_write", { ...scope, request_id: status.requests[0].request_id });
    assert.equal(receipt.status, "persisted");
    assert.equal((await app.dispatcher.call("memory_checkpoint", input)).record_id, receipt.record_id);
    const evidence = await app.dispatcher.call("memory_get_evidence", { project_id: f.pid, record_id: receipt.record_id });
    assert.equal(evidence.record.body, input.body); assert.equal(evidence.verified, false);
  }
  assert.deepEqual(counts(f.db), before, "The original request remains untouched.");
});

test("global registration-key collision rolls back the imported project in the incomplete copy", async t => {
  const f = await sample(t, "receipt-source"), base = await sample(t, "receipt-base");
  await base.call("memory_register_project", { key: "unrelated", name: "unrelated", idempotency_key: "register-receipt-source" });
  const output = destination("receipt-export"), target = destination("receipt-conflict"), before = counts(base.db);
  exportProject(f.db, f.pid, output);
  await assert.rejects(importProject(output, target, base.db));
  assert.equal(existsSync(join(target, "import.json")), false);
  assert.deepEqual(counts(join(target, "memory.sqlite")), before);
  assert.deepEqual(counts(base.db), before);
});

test("recovery payload tampering and missing acknowledged receipts prevent completed outputs", async t => {
  const f = await sample(t, "recovery-validation"), bundle = destination("bad-recovery-export");
  exportProject(f.db, f.pid, bundle);
  rewriteBundle(bundle, rows => { rows.find(row => row.table === "requests").row.payload_hash = "0".repeat(64); });
  const target = destination("bad-recovery-import");
  await assert.rejects(importProject(bundle, target), error => error.code === "invalid_recovery");
  assert.equal(existsSync(join(target, "import.json")), false);
  const journal = new DatabaseSync(`${f.db}.recovery.sqlite`);
  journal.prepare("UPDATE requests SET request_key = 'missing' WHERE id = (SELECT id FROM requests LIMIT 1)").run();
  journal.close();
  const backup = destination("bad-recovery-backup");
  await assert.rejects(backupDatabase(f.db, backup), error => error.code === "invalid_recovery");
  assert.equal(existsSync(join(backup, "manifest.json")), false);
});

test("backup bundles are self-contained and unchecked WAL overlays are never restored", async t => {
  const f = await sample(t, "wal-overlay"), bundle = destination("sealed-backup");
  await backupDatabase(f.db, bundle);
  for (const name of ["memory.sqlite", "memory.sqlite.recovery.sqlite"]) {
    for (const suffix of ["-wal", "-shm", "-journal"]) assert.equal(existsSync(join(bundle, name + suffix)), false);
  }
  const writer = new DatabaseSync(join(bundle, "memory.sqlite"));
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
    const before = hash(join(bundle, "memory.sqlite"));
    writer.prepare("UPDATE projects SET name='UNHASHED WAL CONTENT' WHERE id=?").run(f.pid);
    assert.equal(hash(join(bundle, "memory.sqlite")), before);
    const target = destination("overlay-restore");
    await assert.rejects(restoreDatabase(bundle, target), error => error.code === "unsealed_bundle");
    assert.equal(existsSync(target), false);
  } finally { writer.close(); }
});

test("an acknowledged request with no matching receipt is refused instead of being silently lost", async t => {
  const f = await sample(t, "missing-receipt"), db = new DatabaseSync(f.db);
  db.prepare("UPDATE receipts SET idempotency_key='moved-receipt' WHERE scope=? AND idempotency_key='original'").run(f.pid);
  db.close();
  const target = destination("receipt-missing-backup");
  await assert.rejects(backupDatabase(f.db, target), error => error.code === "receipt_missing");
  assert.equal(existsSync(target), false);
});

test("pinned read snapshots do not absorb later writes from another connection", async t => {
  const f = await sample(t, "snapshot-pin"), snapshots = openSnapshots(f.db), writer = new DatabaseSync(f.db);
  try {
    // Exercise the main WAL snapshot directly: the recovery journal's rollback-mode read
    // transaction intentionally prevents new request preparation until that snapshot closes.
    writer.prepare("UPDATE projects SET name='after-pin' WHERE id=?").run(f.pid);
    assert.equal(snapshots.main.prepare("SELECT name FROM projects WHERE id=?").get(f.pid).name, "snapshot-pin");
    assert.equal(writer.prepare("SELECT name FROM projects WHERE id=?").get(f.pid).name, "after-pin");
    const { copySnapshot } = await import("../dist/adapters/storage/transfer/snapshot.js");
    const target = `${destination("pinned-copy")}.sqlite`;
    await copySnapshot(snapshots.main, target);
    const copy = new DatabaseSync(target, { readOnly: true });
    try { assert.equal(copy.prepare("SELECT name FROM projects WHERE id=?").get(f.pid).name, "snapshot-pin"); }
    finally { copy.close(); }
  } finally { snapshots.close(); writer.close(); }
});

test("oversized lines and unsupported manifest versions are rejected before a usable destination exists", async t => {
  const f = await sample(t, "limits"), bundle = destination("limits-export");
  exportProject(f.db, f.pid, bundle);
  rewriteBundle(bundle, rows => { rows.find(row => row.table === "records").row.body = "x".repeat(256 * 1024); });
  const target = destination("large-line");
  await assert.rejects(importProject(bundle, target), error => error.code === "transfer_limit");
  assert.equal(existsSync(target), false);
  const path = join(bundle, "manifest.json"), manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.version = 999; writeFileSync(path, JSON.stringify(manifest));
  await assert.rejects(importProject(bundle, destination("unsupported")), error => error.code === "invalid_bundle");
});
