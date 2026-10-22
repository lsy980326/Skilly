import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { fixture, project, run, checkpoint } from "./helpers.mjs";
import { openLocal } from "../dist/runtime/local/app.js";
import { SqliteViewer } from "../dist/adapters/storage/sqlite/viewer.js";

const components = [{ key: "web", name: "Web" }, { key: "api", name: "API" }];
const features = [{ key: "comments", name: "댓글 해결", description: "해결 상태 유지" }];
const report = {
  title: "댓글 해결 상태 수정", summary: "복귀해도 해결 상태를 유지한다.", changes: ["API 저장 처리 수정"],
  checks: [{ name: "API 검사", result: "passed" }, { name: "배포", result: "not_run" }],
  limitations: ["브라우저 확인 미실행"], next_steps: ["Web 복귀 동작 확인"],
  feature_updates: [{ key: "comments", state: "in_progress", summary: "API 수정, Web 검사 필요" }],
  technical: { files: ["src/comments.ts"], symbols: ["resolveComment"], commands: ["node --test comments.test.mjs"], context: "브라우저 복귀 시 저장 상태 재조회 필요" },
};

test("v3 migration preserves original rows and receipt replay without classifying history", async t => {
  const dir = mkdtempSync(join(tmpdir(), "skilly-work-migration-")), path = join(dir, "memory.sqlite");
  const pid = randomUUID(), rid = randomUUID(), recordId = randomUUID(), date = "2026-10-20T00:00:00Z";
  const raw = new DatabaseSync(path);
  for (const name of ["001-local-memory", "002-recovery", "003-run-actors"]) raw.exec(readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), "utf8"));
  raw.prepare("INSERT INTO projects VALUES (?, 'legacy', 'Legacy', 0, ?)").run(pid, date);
  raw.prepare("INSERT INTO runs VALUES (?, ?, '원래 작업', 'change', 'development', 'default', 'active', ?, ?)").run(rid, pid, date, date);
  raw.prepare("INSERT INTO records (id,project_id,run_id,topic,kind,body,environment,repository,observed_at,recorded_at,report_origin) VALUES (?,?,?,'old','note','보존 원문','development','default',?,?,'unspecified')").run(recordId, pid, rid, date, date);
  const input = { project_id: pid, goal: "원래 작업", mode: "change", environment: "development", repository: "default", idempotency_key: "legacy" };
  const payload = { operation: "begin", ...input };
  const hash = createHash("sha256").update(JSON.stringify(Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b))))).digest("hex");
  const oldResult = { status: "persisted", run: { id: rid, project_id: pid } };
  raw.prepare("INSERT INTO receipts VALUES (?,?,?,?)").run(pid, input.idempotency_key, hash, JSON.stringify(oldResult));
  const before = Object.fromEntries(["runs", "records", "receipts"].map(table => [table, raw.prepare(`SELECT * FROM ${table}`).all()]));
  const viewer = new SqliteViewer(path);
  assert.deepEqual(viewer.runs(pid).items[0].components, []);
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 3); viewer.close();
  const app = openLocal(path); t.after(() => app.close()); t.after(() => raw.close());
  assert.equal(raw.prepare("PRAGMA user_version").get().user_version, 10);
  for (const table of Object.keys(before)) assert.deepEqual(raw.prepare(`SELECT * FROM ${table}`).all(), before[table]);
  const replay = await app.dispatcher.call("memory_begin_task", input);
  assert.deepEqual(replay.run, oldResult.run);
  assert.equal(raw.prepare("SELECT count(*) AS n FROM run_components").get().n, 0);
  raw.prepare("INSERT INTO runs VALUES (?,?, '구형 9열 쓰기', 'change','test','default','active',?,?)").run(randomUUID(),pid,date,date);
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
});

test("one task links multiple components and features; people and AI share structured reports", async t => {
  const f = fixture(t), pid = await project(f.call);
  const rid = await run(f.call, pid, { components, features, title: "댓글 상태 수정", branch: "fix/comments", actor: "Codex" });
  const saved = await f.call("memory_checkpoint", checkpoint(pid, rid, { report, report_origin: "contemporaneous" }));
  const reader = new SqliteViewer(f.path); t.after(() => reader.close());
  assert.equal(reader.runs(pid, { component: "web", feature: "comments" }).items.length, 1);
  assert.equal(reader.runs(pid, { component: "api" }).items.length, 1);
  const detail = reader.detail(pid, rid);
  assert.deepEqual(detail.records.items[0].report, report);
  assert.equal(detail.run.title, "댓글 상태 수정");
  assert.equal(detail.run.branch, "fix/comments");
  assert.equal(detail.records.items[0].verified, false);
  const ai = await f.call("memory_query_overview", { project_id: pid, component: "web", feature: "comments" });
  assert.equal(ai.items[0].id, rid); assert.equal(ai.items[0].latest_report.id, saved.record_id);
  assert.equal(ai.items[0].latest_report.verified, false); assert.equal(ai.claims_verified, false);
  const evidence = await f.call("memory_get_evidence", { project_id: pid, record_id: saved.record_id });
  assert.equal(evidence.record.body, "댓글 해결 상태 저장 처리 추가"); assert.deepEqual(evidence.record.report, report);
  const feature = await f.call("memory_query_overview", { project_id: pid, view: "features" });
  assert.equal(feature.items[0].latest_report.update.state, "in_progress");
  assert.equal(feature.items[0].latest_activity.record_id, saved.record_id);
  assert.deepEqual(feature.items[0].latest_activity.report.next_steps, report.next_steps);
  assert.equal(feature.items[0].latest_activity.verified, false);
  assert.equal(feature.items[0].execution_evidence.status, "not_collected");
  await f.call("memory_finish_task", { project_id: pid, run_id: rid, summary: "작업 마감, 기능 구현 미완료", outcome: "completed", idempotency_key: "finish" });
  const after = await f.call("memory_query_overview", { project_id: pid, view: "features" });
  assert.equal(after.items[0].unfinished, 0); assert.equal(after.items[0].latest_report.update.state, "in_progress");
});

test("feature activity respects scope and never promotes retrospective or superseded task reports", async t => {
  const f = fixture(t), pid = await project(f.call);
  const web = await run(f.call, pid, { features, components: [{ key: "web", name: "Web" }] });
  const saved = await f.call("memory_checkpoint", checkpoint(pid, web, { report_origin: "contemporaneous", observed_at: "2026-01-01T00:00:00Z", report }));
  const api = await run(f.call, pid, { features, components: [{ key: "api", name: "API" }], idempotency_key: "api-begin" });
  await f.call("memory_checkpoint", checkpoint(pid, api, { report_origin: "contemporaneous", observed_at: "2026-01-02T00:00:00Z", report: { title: "API 보고", summary: "API 변경", next_steps: ["API 후속"] }, idempotency_key: "api-report" }));
  const other = await run(f.call, pid, { features, repository: "another", idempotency_key: "another-begin" });
  await f.call("memory_checkpoint", checkpoint(pid, other, { report_origin: "contemporaneous", observed_at: "2026-01-03T00:00:00Z", report: { title: "다른 저장소", summary: "섞이면 안 됨" }, idempotency_key: "another-report" }));
  const query = extra => f.call("memory_query_overview", { project_id: pid, view: "features", ...extra });
  let result = await query({ component: "web" });
  assert.equal(result.items[0].latest_activity.record_id, saved.record_id);
  assert.equal((await query({})).items[0].latest_activity.report.summary, "API 변경");
  await f.call("memory_checkpoint", checkpoint(pid, web, { report_origin: "retrospective", observed_at: "2026-01-04T00:00:00Z", report: { title: "소급 완료 주장", summary: "현재 보고로 쓰지 않음" }, idempotency_key: "retro-web" }));
  assert.equal((await query({ component: "web" })).items[0].latest_activity.record_id, saved.record_id);
  await f.call("memory_checkpoint", checkpoint(pid, web, { supersedes: saved.record_id, report_origin: "retrospective", observed_at: "2026-01-05T00:00:00Z", report: { title: "소급 정정", summary: "과거 보고 정정" }, idempotency_key: "correct-web" }));
  result = await query({ component: "web" });
  assert.equal(result.items[0].latest_activity, null);
  assert.equal(result.items[0].latest_report, null);
});

test("a newly discovered feature can be linked in a report and invalid links roll back the whole write", async t => {
  const f = fixture(t), pid = await project(f.call), other = await project(f.call, "other");
  const rid = await run(f.call, pid);
  await run(f.call, other, { components, features });
  await assert.rejects(f.call("memory_checkpoint", checkpoint(pid, rid, { report })), { code: "scope_mismatch" });
  const reader = new SqliteViewer(f.path); t.after(() => reader.close());
  assert.equal(reader.detail(pid, rid).records.items.length, 0);
  assert.deepEqual(reader.overview(pid, "features").items, []);
  await f.call("memory_checkpoint", checkpoint(pid, rid, { features, components, report, idempotency_key: "linked" }));
  assert.equal(reader.runs(pid, { component: "api", feature: "comments" }).items.length, 1);
  await assert.rejects(f.call("memory_checkpoint", checkpoint(pid, rid, { features: [{ key: "comments", name: "別機能" }], idempotency_key: "conflict" })), { code: "catalog_conflict" });
  assert.equal(reader.detail(pid, rid).records.items.length, 1);
});

test("feature-filtered briefs do not borrow newer status or activity from unshared tasks", async t => {
  const f = fixture(t), pid = await project(f.call);
  const both = [{ key: "a", name: "기능 A" }, { key: "b", name: "기능 B" }];
  const shared = await run(f.call, pid, { features: both });
  const first = await f.call("memory_checkpoint", checkpoint(pid, shared, { report_origin: "contemporaneous", observed_at: "2026-01-01T00:00:00Z",
    report: { title: "공동 작업", summary: "A와 B의 공통 보고", feature_updates: [{ key: "b", state: "in_progress", summary: "공동 확인 필요" }] } }));
  const onlyB = await run(f.call, pid, { features: [both[1]], idempotency_key: "only-b" });
  await f.call("memory_checkpoint", checkpoint(pid, onlyB, { report_origin: "contemporaneous", observed_at: "2026-01-02T00:00:00Z", idempotency_key: "b-report",
    report: { title: "B 단독 작업", summary: "A 범위에 섞이면 안 됨", feature_updates: [{ key: "b", state: "implemented", summary: "B 단독 구현" }] } }));
  const scoped = await f.call("memory_query_overview", { project_id: pid, view: "features", feature: "a" });
  const b = scoped.items.find(item => item.key === "b");
  assert.equal(b.latest_report.record_id, first.record_id);
  assert.equal(b.latest_activity.record_id, first.record_id);
  assert.equal(b.latest_report.update.state, "in_progress");
});

test("readable note and change reports preserve originals, exact retry inputs and technical references", async t => {
  const f = fixture(t), pid = await project(f.call), rid = await run(f.call, pid);
  const original = "  API.foo=bar; exit1\n원래 공백과 기술 기록  ";
  const note = checkpoint(pid, rid, { kind: "note", body: original, idempotency_key: "note", report: {
    title: "저장 실패 원인 확인", summary: "저장 요청이 거절되는 원인을 확인했습니다. 수정 후 다시 검사해야 합니다.",
    checks: [{ name: "저장 검사", result: "failed", detail: "node --test save.test.mjs: exit 1" }],
    technical: { files: ["src/save.ts"], symbols: ["save"], commands: ["node --test save.test.mjs"] },
  } });
  const saved = await f.call("memory_checkpoint", note);
  assert.deepEqual(await f.call("memory_checkpoint", note), saved);
  const change = checkpoint(pid, rid, { body: original, idempotency_key: "change", report: {
    title: "입력 처리 수정", summary: "잘못된 입력을 저장 전에 확인하도록 수정했습니다. 실제 배포는 하지 않았습니다.",
    technical: { record_ids: [saved.record_id] }, limitations: ["배포 미실행"],
  } });
  const next = await f.call("memory_checkpoint", change);
  const reopened = f.open();
  for (const [id, input] of [[saved.record_id, note], [next.record_id, change]]) {
    const evidence = await reopened.dispatcher.call("memory_get_evidence", { project_id: pid, record_id: id });
    assert.equal(evidence.record.body, original);
    assert.deepEqual(evidence.record.report, input.report);
    assert.equal(evidence.verified, false); assert.equal(evidence.knowledge_status, "unknown");
  }
  await assert.rejects(f.call("memory_checkpoint", { ...note, report: undefined }), { code: "idempotency_conflict" });
  for (const technical of [{ files: Array(9).fill("x") }, { record_ids: ["invented"] }, { context: "x".repeat(1201) }, { verified: true }]) {
    await assert.rejects(f.call("memory_checkpoint", { ...note, idempotency_key: "invalid", report: { ...note.report, technical } }), { code: "invalid_input" });
  }
});

test("failed structured writes recover exact metadata after restart and leave no partial catalogs", async t => {
  const f = fixture(t), pid = await project(f.call);
  const db = new DatabaseSync(f.path); t.after(() => db.close());
  db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT,'test'); END");
  const input = { project_id: pid, goal: "새 기능", mode: "change", components, features, title: "새 기능 시작", idempotency_key: "recover" };
  await assert.rejects(f.call("memory_begin_task", input), { code: "storage_error" });
  for (const table of ["components", "features", "run_components", "run_features"]) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
  db.exec("DROP TRIGGER fail_receipt");
  const pending = await f.call("memory_recovery_status", { project_id: pid });
  const reopened = f.open();
  const recovered = await reopened.dispatcher.call("memory_retry_write", { project_id: pid, request_id: pending.requests[0].request_id });
  assert.deepEqual(recovered.run.components, components);
  assert.deepEqual((await reopened.dispatcher.call("memory_get_status", { project_id: pid, run_id: recovered.run.id })).run.features.map(x => x.key), ["comments"]);
});

test("retrospective reports never replace feature state; corrected reports leave latest selection", async t => {
  const f = fixture(t), pid = await project(f.call), rid = await run(f.call, pid, { features });
  const saved = await f.call("memory_checkpoint", checkpoint(pid, rid, { report, report_origin: "contemporaneous" }));
  const retrospective = { ...report, feature_updates: [{ key: "comments", state: "implemented", summary: "나중에 재구성한 완료 주장" }] };
  await f.call("memory_checkpoint", checkpoint(pid, rid, { report: retrospective, report_origin: "retrospective", idempotency_key: "retro" }));
  let result = await f.call("memory_query_overview", { project_id: pid, view: "features" });
  assert.equal(result.items[0].latest_report.record_id, saved.record_id);
  await f.call("memory_checkpoint", checkpoint(pid, rid, { supersedes: saved.record_id, report: retrospective, report_origin: "retrospective", idempotency_key: "correct" }));
  result = await f.call("memory_query_overview", { project_id: pid, view: "features" });
  assert.equal(result.items[0].latest_report, null);
});

test("bound component defaults only new work without changing legacy retries; reads remain project-bound", async t => {
  const f = fixture(t), pid = await project(f.call);
  const legacy = await run(f.call, pid);
  const binding = { version: 1, key: "example", name: "example", repository: "default", environment: "development", component: components[0] };
  const app = openLocal(f.path, binding); t.after(() => app.close());
  const call = (name, input) => app.dispatcher.call(name, input);
  const resolved = await call("memory_resolve_project", {}); assert.deepEqual(resolved.component, components[0]);
  assert.equal(await run(call, pid), legacy, "Original omitted-component retry returns its original receipt.");
  assert.deepEqual((await call("memory_get_status", { project_id: pid, run_id: legacy })).run.components, []);
  const automatic = await run(call, pid, { idempotency_key: "automatic" });
  assert.deepEqual((await call("memory_get_status", { project_id: pid, run_id: automatic })).run.components, [components[0]]);
  const explicit = await run(call, pid, { components: [components[1]], idempotency_key: "explicit" });
  assert.deepEqual((await call("memory_get_status", { project_id: pid, run_id: explicit })).run.components, [components[1]]);
  const api = await run(f.call, pid, { components: [components[1]], repository: "api", idempotency_key: "api" });
  assert.equal((await call("memory_query_overview", { project_id: pid })).items.some(x => x.id === api), false);
  assert.equal((await call("memory_query_overview", { project_id: pid, coverage: "service" })).items.some(x => x.id === api), true);
  const other = await project(f.call, "other");
  await assert.rejects(call("memory_query_overview", { project_id: other, coverage: "service" }), { code: "scope_mismatch" });
  await assert.rejects(call("memory_query_context", { project_id: pid, repository: "api" }), { code: "scope_mismatch" });
});

test("overview pagination is bounded, long Korean text fits context budget, invalid report input is rejected", async t => {
  const f = fixture(t), pid = await project(f.call);
  for (let n = 0; n < 42; n++) await run(f.call, pid, { goal: "작업".repeat(950), components, idempotency_key: `run-${n}` });
  const ids = [], input = { project_id: pid, limit: 40 };
  let offset = 0;
  do {
    const page = await f.call("memory_query_overview", { ...input, offset });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 32 * 1024);
    assert.ok(page.items.length > 0); ids.push(...page.items.map(x => x.id)); offset = page.next_offset;
  } while (offset !== null);
  assert.equal(new Set(ids).size, 42); assert.equal(ids.length, 42);
  await assert.rejects(f.call("memory_begin_task", { project_id: pid, goal: "bad", mode: "change", components: [{ key: "../api", name: "API" }], idempotency_key: "bad" }), { code: "invalid_input" });
});

test("maximum metadata and accumulated links cannot stall a single task page", async t => {
  const f = fixture(t), pid = await project(f.call);
  const many = start => Array.from({ length: 12 }, (_, n) => ({ key: `f-${start + n}`, name: "기".repeat(100), description: "설".repeat(500) }));
  const rid = await run(f.call, pid, { goal: "작".repeat(2000), features: many(0),
    components: Array.from({ length: 12 }, (_, n) => ({ key: `c-${n}`, name: "구".repeat(80) })) });
  await f.call("memory_checkpoint", checkpoint(pid, rid, { features: many(12), report_origin: "contemporaneous", report: { title: "긴 작업", summary: "요".repeat(800) } }));
  const result = await f.call("memory_query_overview", { project_id: pid, limit: 40 });
  assert.equal(result.items.length, 1); assert.equal(result.next_offset, null);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 32 * 1024);
  assert.equal(result.items[0].features_total, 24); assert.equal(result.items[0].links_truncated, true);
  assert.equal(result.items[0].features.length, 12);
  assert.equal(result.items[0].features[0].description, undefined);
});

test("unclassified feature reports and repository catalog scope stay consistent", async t => {
  const f = fixture(t), pid = await project(f.call), rid = await run(f.call, pid, { features });
  await f.call("memory_checkpoint", checkpoint(pid, rid, { report, report_origin: "contemporaneous" }));
  await run(f.call, pid, { repository: "api", features: [{ key: "api-only", name: "API 전용" }], idempotency_key: "api" });
  const result = await f.call("memory_query_overview", { project_id: pid, view: "features", component: "unclassified" });
  assert.equal(result.items[0].latest_report.update.state, "in_progress");
  assert.deepEqual(result.items.map(x => x.key), ["comments"]);
  const service = await f.call("memory_query_overview", { project_id: pid, view: "features", coverage: "service" });
  assert.equal(service.items.length, 2);
  await assert.rejects(f.call("memory_begin_task", { project_id: pid, goal: "bad", mode: "change", components: [{ key: "unclassified", name: "충돌" }], idempotency_key: "sentinel" }), { code: "invalid_input" });
});

test("JSON escape expansion returns an explicit compact item and advances the page", async t => {
  const f = fixture(t), pid = await project(f.call);
  const rid = await run(f.call, pid, { goal: "x" + "\u0001".repeat(1999), actor: "x" + "\u0001".repeat(79), title: "\u0001".repeat(160), branch: "\u0001".repeat(100),
    features: Array.from({ length: 12 }, (_, n) => ({ key: `f-${n}`, name: "\u0001".repeat(100), description: "\u0001".repeat(500) })),
    components: Array.from({ length: 12 }, (_, n) => ({ key: `c-${n}`, name: "\u0001".repeat(80) })) });
  await f.call("memory_checkpoint", checkpoint(pid, rid, { report: { title: "escape", summary: "\u0001".repeat(800) }, report_origin: "contemporaneous" }));
  const result = await f.call("memory_query_overview", { project_id: pid, limit: 40 });
  assert.equal(result.items.length, 1); assert.equal(result.next_offset, null);
  assert.equal(result.items[0].projection_truncated, true);
  assert.equal(result.items[0].id, rid); assert.equal(result.items[0].components_total, 12);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024);
  const searched=await f.call('memory_query_overview',{project_id:pid,query:'x',limit:40});
  assert.ok(searched.items[0].match_reasons.length);assert.equal(searched.items[0].match_reasons[0].kind,'goal');
  assert.ok(Buffer.byteLength(JSON.stringify(searched))<=32*1024);
});

test("large feature briefs remain byte-bounded and paginate without losing features", async t => {
  const f = fixture(t), pid = await project(f.call);
  const catalog = Array.from({ length: 12 }, (_, n) => ({ key: `brief-${n}`, name: `기능 ${n}` }));
  const rid = await run(f.call, pid, { features: catalog });
  const lines = Array.from({ length: 8 }, () => "x".repeat(400));
  await f.call("memory_checkpoint", checkpoint(pid, rid, { report_origin: "contemporaneous", report: {
    title: "긴 보고", summary: "s".repeat(800), changes: lines, next_steps: lines, limitations: lines,
  } }));
  const found = [];
  let offset = 0;
  for (let page = 0; page < 12; page++) {
    const result = await f.call("memory_query_overview", { project_id: pid, view: "features", limit: 40, offset });
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 32 * 1024);
    assert.ok(result.items.length > 0);
    found.push(...result.items.map(item => item.key));
    if (result.next_offset === null) break;
    assert.ok(result.next_offset > offset); offset = result.next_offset;
  }
  assert.deepEqual(new Set(found), new Set(catalog.map(item => item.key)));
  assert.equal(found.length, 12);
});
