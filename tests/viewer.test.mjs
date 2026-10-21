import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { request as httpRequest } from "node:http";
import { activityFor } from "../dist/core/viewer/model.js";
import { SqliteViewer } from "../dist/adapters/storage/sqlite/viewer.js";
import { startViewer } from "../dist/transport/viewer/server.js";
import { openLocal } from "../dist/runtime/local/app.js";
import { fixture, project, run, checkpoint } from "./helpers.mjs";

test("recent activity never asserts liveness or turns a closed task into active", () => {
  const now = Date.parse("2026-10-21T10:00:00Z");
  assert.equal(activityFor("active", "2026-10-21T09:56:00Z", now), "recent");
  assert.equal(activityFor("active", "2026-10-21T09:54:59Z", now), "unfinished");
  assert.equal(activityFor("active", "2026-10-21T10:01:00Z", now), "unfinished");
  assert.equal(activityFor("active", "invalid", now), "unfinished");
  assert.equal(activityFor("completed", "2026-10-21T10:00:00Z", now), "completed");
  assert.equal(activityFor("interrupted", "2026-10-21T10:00:00Z", now), "interrupted");
});

test("actor is optional, immutable across reports and recovered with the original failed begin", async t => {
  const f = fixture(t), pid = await project(f.call);
  const legacy = await run(f.call, pid);
  const input = { project_id: pid, goal: "상태 표시", mode: "change", actor: "Codex", idempotency_key: "actor-start" };
  const raw = new DatabaseSync(f.path);
  t.after(() => raw.close());
  raw.exec("CREATE TRIGGER test_begin_failure BEFORE INSERT ON runs BEGIN SELECT RAISE(ABORT, 'test'); END;");
  await assert.rejects(f.call("memory_begin_task", input), { code: "storage_error" });
  const pending = await f.call("memory_recovery_status", { project_id: pid });
  assert.equal(pending.requests.length, 1);
  raw.exec("DROP TRIGGER test_begin_failure;");
  const saved = await f.call("memory_retry_write", { project_id: pid, request_id: pending.requests[0].request_id });
  assert.equal(saved.run.actor, "Codex");
  assert.equal((await f.call("memory_begin_task", input)).run.id, saved.run.id);
  await assert.rejects(f.call("memory_begin_task", { ...input, actor: "Cursor" }), { code: "idempotency_conflict" });
  await f.call("memory_checkpoint", checkpoint(pid, saved.run.id));
  await f.call("memory_finish_task", { project_id: pid, run_id: saved.run.id, outcome: "completed", summary: "끝", idempotency_key: "finish" });
  const reader = new SqliteViewer(f.path);
  t.after(() => reader.close());
  assert.equal(reader.detail(pid, saved.run.id).run.actor, "Codex");
  assert.equal(reader.detail(pid, saved.run.id).run.actor_source, "self_reported");
  assert.equal(reader.detail(pid, legacy).run.actor, null);
  for (const actor of ["", "  ", "a".repeat(81), { name: "fake" }]) {
    await assert.rejects(f.call("memory_begin_task", { ...input, actor, idempotency_key: "bad" }), { code: "invalid_input" });
  }
});

test("reader supports legacy schemas without migration; writer upgrade preserves v2 rows and 9-column inserts", async t => {
  const directory = mkdtempSync(join(tmpdir(), "skilly-viewer-legacy-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "memory.sqlite"), pid = randomUUID(), rid = randomUUID();
  const db = new DatabaseSync(path);
  db.exec(readFileSync(new URL("../migrations/001-local-memory.sql", import.meta.url), "utf8"));
  const date = "2026-10-20T00:00:00.000Z";
  db.prepare("INSERT INTO projects VALUES (?, 'legacy', '이전 기록', 1, ?)").run(pid, date);
  db.prepare("INSERT INTO runs VALUES (?, ?, '이전 작업', 'change', 'test', 'main', 'active', ?, ?)").run(rid, pid, date, date);
  db.prepare("INSERT INTO records (id, project_id, run_id, topic, kind, body, environment, repository, observed_at, recorded_at) VALUES (?, ?, ?, 'task', 'note', '이전 본문', 'test', 'main', ?, ?)").run(randomUUID(), pid, rid, date, date);
  for (const version of [1, 2]) {
    if (version === 2) db.exec(readFileSync(new URL("../migrations/002-recovery.sql", import.meta.url), "utf8"));
    const before = readFileSync(path);
    const reader = new SqliteViewer(path);
    assert.equal(reader.detail(pid, rid).run.actor, null);
    assert.equal(reader.detail(pid, rid).records.items[0].report_origin, "unspecified");
    reader.close();
    assert.deepEqual(readFileSync(path), before);
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, version);
  }
  const oldRows = db.prepare("SELECT * FROM runs").all();
  const app = openLocal(path);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 6);
  assert.deepEqual(db.prepare("SELECT * FROM runs").all(), oldRows);
  db.prepare("INSERT INTO runs VALUES (?, ?, '구형 실행 SQL', 'change', 'test', 'main', 'active', ?, ?)").run(randomUUID(), pid, date, date);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  await app.close(); db.close();
});

test("viewer isolates projects, paginates full reports and distinguishes origins without verifying them", async t => {
  const f = fixture(t), pid = await project(f.call), other = await project(f.call, "other");
  const first = await run(f.call, pid, { actor: "<img src=x onerror=alert(1)>", goal: "<script>hostile</script>" });
  const foreign = await run(f.call, other);
  for (let i = 0; i < 43; i++) await f.call("memory_checkpoint", checkpoint(pid, first, {
    idempotency_key: `record-${i}`, body: i === 42 ? "<img src=x onerror=alert(1)>" : `기록 ${i}`,
    report_origin: i === 41 ? "retrospective" : "contemporaneous",
  }));
  const reader = new SqliteViewer(f.path);
  t.after(() => reader.close());
  assert.equal(reader.projects().items.length, 2);
  assert.equal(reader.runs(pid).items.length, 1);
  assert.equal(reader.runs(pid, { query: "<script>" }).items.length, 1);
  assert.equal(reader.runs(pid, { state: "interrupted" }).items.length, 0);
  const detail = reader.detail(pid, first);
  assert.equal(detail.records.items.length, 40);
  const cursor = detail.records.next_before;
  assert.equal(typeof cursor, "number");
  await f.call("memory_checkpoint", checkpoint(pid, first, { idempotency_key: "during-pagination" }));
  const next = reader.detail(pid, first, cursor).records.items;
  assert.equal(next.length, 3);
  assert.ok(next.every(record => !detail.records.items.some(previous => previous.id === record.id)));
  assert.equal(detail.records.items[0].body, "<img src=x onerror=alert(1)>");
  assert.equal(detail.records.items[1].report_origin, "retrospective");
  assert.equal(detail.record_counts.change, 43);
  assert.equal(detail.claims_verified, false);
  assert.ok(detail.records.items.every(record => record.verified === false));
  assert.throws(() => reader.detail(pid, foreign), { code: "not_found" });
  assert.throws(() => reader.runs("' OR 1=1"), { code: "invalid_input" });
  assert.throws(() => reader.projects(-1), { code: "invalid_input" });
  assert.throws(() => reader.runs(pid, { query: "x".repeat(201) }), { code: "invalid_input" });
  assert.throws(() => reader.runs(pid, { state: "verified" }), { code: "invalid_input" });
});

test("recovery view checks receipts first and distinguishes missing from unreadable journals", async t => {
  const f = fixture(t), pid = await project(f.call), rid = await run(f.call, pid);
  const reader = new SqliteViewer(f.path);
  t.after(() => reader.close());
  const raw = new DatabaseSync(f.path), journal = new DatabaseSync(`${f.path}.recovery.sqlite`);
  t.after(() => { raw.close(); journal.close(); });
  raw.exec("CREATE TRIGGER test_report_failure BEFORE INSERT ON records BEGIN SELECT RAISE(ABORT, 'test'); END;");
  await assert.rejects(f.call("memory_checkpoint", checkpoint(pid, rid)), { code: "storage_error" });
  assert.equal(reader.recovery(pid).items[0].state, "retry_required");
  assert.equal(reader.recovery(pid).items[0].delivery_status, "recovery_pending");
  raw.exec("DROP TRIGGER test_report_failure;");
  const beforeRetry = journal.prepare("SELECT * FROM requests WHERE input_json IS NOT NULL").get();
  await f.call("memory_retry_write", { project_id: pid, request_id: beforeRetry.id });
  // Simulate a saved receipt whose journal acknowledgement was not cleared.
  journal.prepare("UPDATE requests SET input_json = ?, last_error = 'busy' WHERE id = ?").run(beforeRetry.input_json, beforeRetry.id);
  assert.equal(reader.recovery(pid).items[0].state, "saved");
  assert.equal(reader.recovery(pid).items[0].delivery_status, "saved");
  assert.equal(reader.recovery(pid).items[0].original_input_retained, true);
  assert.equal("input_json" in reader.recovery(pid).items[0], false);
  journal.prepare("UPDATE requests SET payload_hash = ? WHERE id = ?").run("f".repeat(64), beforeRetry.id);
  assert.equal(reader.recovery(pid).items[0].delivery_status, "recovery_blocked");
  assert.equal(reader.recovery(pid).items[0].state, "conflict");

  const separate = join(f.directory, "separate.sqlite");
  const copy = new DatabaseSync(separate);
  copy.exec(readFileSync(new URL("../migrations/001-local-memory.sql", import.meta.url), "utf8"));
  copy.prepare("INSERT INTO projects VALUES (?, 'copy', 'copy', 0, ?)").run(pid, new Date().toISOString());
  copy.close();
  const missing = new SqliteViewer(separate);
  t.after(() => missing.close());
  assert.equal(missing.recovery(pid).status, "missing");
  assert.equal(missing.recovery(pid).recording_coverage.missing_record_count, null);
  new DatabaseSync(`${separate}.recovery.sqlite`).close();
  assert.equal(missing.recovery(pid).status, "unavailable");
  assert.equal(missing.recovery(pid).recording_coverage.completeness, "unknown");
});

function request(origin, path, headers = {}, method = "GET") {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${origin}${path}`, { method, headers, agent: false }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.once("error", reject); req.end();
  });
}

test("local HTTP is authenticated, read-only, origin-bound and preserves existing DB bytes", async t => {
  const f = fixture(t), pid = await project(f.call), rid = await run(f.call, pid, {
    components: [{ key: "web", name: "Web" }], features: [{ key: "comments", name: "댓글" }], title: "댓글 수정",
  });
  await f.call("memory_checkpoint", checkpoint(pid, rid, { report_origin: "contemporaneous",
    report: { title: "댓글 변경 보고", summary: "댓글 저장 처리 변경", next_steps: ["실제 화면 확인"], checks: [{ name: "검사", result: "passed" }] } }));
  await f.app.close();
  const before = readFileSync(f.path), journalBefore = readFileSync(`${f.path}.recovery.sqlite`);
  const viewer = await startViewer({ db: f.path });
  t.after(() => viewer.close());
  const token = new URLSearchParams(new URL(viewer.url).hash.slice(1)).get("token");
  const auth = { Authorization: `Bearer ${token}` };
  assert.match(viewer.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const shell = await request(viewer.origin, "/");
  assert.equal(shell.status, 200);
  const layout = await request(viewer.origin, "/layout.js");
  assert.equal(layout.status, 200);
  assert.match(layout.headers["content-type"], /javascript/);
  const featureAsset = await request(viewer.origin, "/features.js");
  assert.equal(featureAsset.status, 200);
  assert.match(featureAsset.headers["content-type"], /javascript/);
  assert.match(shell.headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(shell.headers["cache-control"], "no-store");
  assert.equal(shell.headers["referrer-policy"], "no-referrer");
  assert.equal((await request(viewer.origin, "/api/projects")).status, 401);
  assert.equal((await request(viewer.origin, "/api/projects", { Authorization: "Bearer invalid" })).status, 401);
  for (const headers of [{ Host: "evil.example" }, { Origin: "https://evil.example" }, { "Sec-Fetch-Site": "cross-site" }]) {
    assert.equal((await request(viewer.origin, "/api/projects", { ...auth, ...headers })).status, 403);
  }
  assert.equal((await request(viewer.origin, "/api/projects", auth, "POST")).status, 405);
  assert.equal((await request(viewer.origin, "/api/projects?db=/tmp/other", auth)).status, 400);
  assert.equal((await request(viewer.origin, "/../../package.json", auth)).status, 404);
  assert.equal((await request(viewer.origin, "/api/projects", auth)).status, 200);
  assert.equal((await request(viewer.origin, `/api/runs/${rid}?project=${pid}`, auth)).status, 200);
  const components = await request(viewer.origin, `/api/overview?project=${pid}&view=components`, auth);
  assert.equal(components.status, 200); assert.equal(JSON.parse(components.body).items[0].key, "web");
  const filtered = await request(viewer.origin, `/api/runs?project=${pid}&component=web&feature=comments`, auth);
  assert.equal(filtered.status, 200); assert.equal(JSON.parse(filtered.body).items[0].id, rid);
  const featureOverview = JSON.parse((await request(viewer.origin, `/api/overview?project=${pid}&view=features`, auth)).body);
  assert.equal(featureOverview.items[0].latest_activity.report.next_steps[0], "실제 화면 확인");
  assert.equal(featureOverview.items[0].latest_activity.verified, false);
  assert.equal(featureOverview.items[0].execution_evidence.status, "not_collected");
  assert.equal((await request(viewer.origin, `/api/overview?project=${pid}&view=invalid`, auth)).status, 400);
  assert.equal((await request(viewer.origin, `/api/runs?project=${pid}&component=../web`, auth)).status, 400);
  assert.equal((await request(viewer.origin, `/api/recovery?project=${pid}`, auth)).status, 200);
  assert.equal((await request(viewer.origin, "/app.js")).status, 200);
  const workstream = await request(viewer.origin, "/workstream.js");
  assert.equal(workstream.status, 200);
  assert.match(workstream.headers["content-type"], /javascript/);
  assert.match(workstream.body, /export function renderWorkstream/);
  const session = await request(viewer.origin, "/session.js");
  assert.equal(session.status, 200);
  assert.match(session.body, /export function createViewerSession/);
  await viewer.close();
  assert.deepEqual(readFileSync(f.path), before);
  assert.deepEqual(readFileSync(`${f.path}.recovery.sqlite`), journalBefore);
  const restarted = await startViewer({ db: f.path, port: Number(new URL(viewer.origin).port) });
  t.after(() => restarted.close());
  assert.equal((await request(restarted.origin, "/api/projects", auth)).status, 401);
  const newToken = new URLSearchParams(new URL(restarted.url).hash.slice(1)).get("token");
  assert.equal((await request(restarted.origin, "/api/projects", { Authorization: `Bearer ${newToken}` })).status, 200);
  await restarted.close();
  assert.deepEqual(readFileSync(f.path), before);
});

test("viewer never creates, migrates or follows a linked database", async t => {
  const f = fixture(t);
  const missing = join(f.directory, "missing.sqlite");
  assert.throws(() => new SqliteViewer(missing)); assert.equal(existsSync(missing), false);
  const link = join(f.directory, "linked.sqlite");
  symlinkSync(f.path, link);
  assert.throws(() => new SqliteViewer(link), { code: "invalid_input" });
  assert.throws(() => new SqliteViewer("relative.sqlite"), { code: "invalid_input" });
  const path = join(f.directory, "future.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version=7; PRAGMA application_id=1397446988;"); db.close();
  const before = readFileSync(path);
  assert.throws(() => new SqliteViewer(path), { code: "unavailable" });
  assert.deepEqual(readFileSync(path), before);
});

test("skill HTTP routes remain authenticated, project-isolated and read-only", async t => {
  const f = fixture(t), pid = await project(f.call);
  await f.call("memory_register_skill", { project_id: pid, skill_key: "sample", version: "1.0", source: "local:test", name: "샘플",
    body: "<script>not executed</script>", install_instructions: "설치 안내", idempotency_key: "register-skill" });
  const other = await project(f.call, "other-skills"), viewer = await startViewer({ db: f.path }); t.after(() => viewer.close());
  const token = new URLSearchParams(new URL(viewer.url).hash.slice(1)).get("token"), auth = { Authorization: `Bearer ${token}` };
  const before = readFileSync(f.path);
  assert.equal((await request(viewer.origin, `/api/skills?project=${pid}`)).status, 401);
  const list = await request(viewer.origin, `/api/skills?project=${pid}`, auth); assert.equal(list.status, 200);
  assert.equal(JSON.parse(list.body).items[0].skill_key, "sample");
  const detail = await request(viewer.origin, `/api/skill?project=${pid}&skill=sample&version=1.0`, auth);
  assert.equal(detail.status, 200); assert.equal(JSON.parse(detail.body).skill.body, "<script>not executed</script>");
  assert.equal((await request(viewer.origin, `/api/skill?project=${other}&skill=sample`, auth)).status, 404);
  assert.equal((await request(viewer.origin, `/api/skill?project=${pid}&skill=sample`, auth, "POST")).status, 405);
  assert.deepEqual(readFileSync(f.path), before);
});
