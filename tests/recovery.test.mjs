import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SqliteRecoveryJournal } from "../dist/adapters/storage/sqlite/recovery-journal.js";
import { SqliteMemoryStore } from "../dist/adapters/storage/sqlite/store.js";
import { SqliteViewer } from "../dist/adapters/storage/sqlite/viewer.js";
import { openLocal } from "../dist/runtime/local/app.js";
import { WriteRecovery } from "../dist/core/memory/recovery.js";
import { MemoryError } from "../dist/core/memory/model.js";
import { inspectMemory, formatInspection } from "../scripts/inspect-memory.mjs";
import { fixture, project, run, checkpoint } from "./helpers.mjs";

const scope = project_id => ({ project_id, repository: "default", environment: "development" });
const canonical = value => value !== null && typeof value === "object"
  ? Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`
  : JSON.stringify(value);
const hash = value => createHash("sha256").update(canonical(value)).digest("hex");

test("bound test project distinguishes a saved start, pending write and unobserved omission after abrupt server loss", { timeout: 20_000 }, async t => {
  const f = fixture(t), p = await project(f.call);
  writeFileSync(join(f.directory, "skilly.project.json"), JSON.stringify({ version: 1, key: "example", name: "example", repository: "default", environment: "development" }));
  await f.app.close();
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); });
  async function connect() {
    const client = new Client({ name: "recording-health-cycle", version: "1" });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ["dist/runtime/local/main.js", "serve", "--db", f.path, "--project", f.directory], stderr: "pipe" });
    transport.stderr?.on("data", () => {});
    clients.push(client);
    await client.connect(transport);
    return { client, transport };
  }
  async function call(connection, name, args) {
    const response = await connection.client.callTool({ name, arguments: args });
    return { isError: response.isError === true, ...JSON.parse(response.content[0].text) };
  }
  let connection = await connect();
  assert.equal((await call(connection, "memory_resolve_project", {})).project.id, p);
  const begin = await call(connection, "memory_begin_task", { project_id: p, goal: "테스트 전용 복구 사이클", mode: "change", idempotency_key: "health-begin" });
  assert.equal(begin.status, "persisted");
  const r = begin.run.id;
  const lock = new DatabaseSync(f.path);
  lock.exec("BEGIN IMMEDIATE");
  let failure;
  try {
    failure = await call(connection, "memory_checkpoint", checkpoint(p, r, { report_origin: "contemporaneous" }));
    assert.equal(failure.error.code, "busy");
    assert.equal(failure.recovery.pending_retained, true);
  } finally { lock.exec("ROLLBACK"); lock.close(); }
  const view = new SqliteViewer(f.path);
  assert.equal(view.recovery(p).items[0].delivery_status, "recovery_pending");
  view.close();
  // Only the server we just created is terminated; no real project process is touched.
  process.kill(connection.transport.pid, "SIGKILL");
  await connection.client.close();
  connection = await connect();
  const status = await call(connection, "memory_recovery_status", scope(p));
  assert.equal(status.requests[0].delivery_status, "recovery_pending");
  assert.equal(status.unfinished_runs[0].state, "active");
  assert.equal(status.unfinished_runs[0].attention, "unfinished_or_still_running");
  assert.equal(status.recording_coverage.missing_record_count, null);
  assert.equal(status.recording_coverage.unreceived_writes, "not_observable");
  assert.equal(status.recording_coverage.execution_events, "not_collected");
  // A write never sent to MCP leaves no request to retry; do not manufacture it.
  const absent = await call(connection, "memory_recovery_status", { ...scope(p), request_id: "f".repeat(64) });
  assert.equal(absent.error.code, "not_found");
  const args = { ...scope(p), request_id: failure.recovery.request_id };
  const recovered = await call(connection, "memory_retry_write", args);
  assert.equal(recovered.status, "persisted");
  assert.equal((await call(connection, "memory_retry_write", args)).record_id, recovered.record_id);
  const saved = await call(connection, "memory_recovery_status", args);
  assert.equal(saved.requests[0].delivery_status, "saved");
  assert.equal(saved.requests[0].original_input_retained, false);
  const secondLock = new DatabaseSync(f.path);
  secondLock.exec("BEGIN IMMEDIATE");
  const noResponse = call(connection, "memory_checkpoint", checkpoint(p, r, { idempotency_key: "no-response", body: "응답 전 중단 테스트", report_origin: "contemporaneous" }))
    .catch(() => ({ transport_error: true }));
  const rawJournal = new DatabaseSync(`${f.path}.recovery.sqlite`, { readOnly: true });
  let retained;
  try {
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      retained = rawJournal.prepare("SELECT id, last_error FROM requests WHERE request_key = ? AND input_json IS NOT NULL").get("no-response");
      if (retained) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(retained, "Wait for durable prepare before terminating the test child.");
    assert.equal(retained.last_error, null);
    process.kill(connection.transport.pid, "SIGKILL");
    await connection.client.close();
  } finally { rawJournal.close(); secondLock.exec("ROLLBACK"); secondLock.close(); }
  assert.equal((await noResponse).transport_error, true);
  connection = await connect();
  const crashedArgs = { ...scope(p), request_id: retained.id };
  const crashed = await call(connection, "memory_recovery_status", crashedArgs);
  assert.equal(crashed.requests[0].recovery_state, "unconfirmed");
  assert.equal(crashed.requests[0].delivery_status, "recovery_pending");
  assert.equal(crashed.requests[0].receipt, null);
  const crashRecovered = await call(connection, "memory_retry_write", crashedArgs);
  assert.equal(crashRecovered.status, "persisted");
  assert.equal((await call(connection, "memory_retry_write", crashedArgs)).record_id, crashRecovered.record_id);
  const finish = await call(connection, "memory_finish_task", { project_id: p, run_id: r, outcome: "interrupted",
    summary: "테스트 서버 강제 종료 후 복구 확인. 작업 결과의 정확성은 미검증.", report_origin: "retrospective", idempotency_key: "health-finish" });
  assert.equal(finish.status, "persisted");
  const history = await call(connection, "memory_query_context", { project_id: p, history: true });
  assert.equal(history.records.length, 3);
  assert.ok(history.records.every(row => row.knowledge_status === "unknown"));
  assert.deepEqual(new Set(history.records.map(row => row.report_origin)), new Set(["contemporaneous", "retrospective"]));
  const after = await call(connection, "memory_recovery_status", scope(p));
  assert.equal(after.requests.length, 0);
  assert.equal(after.recording_coverage.completeness, "unknown");
  assert.equal(after.unfinished_runs[0].attention, "reported_interruption");
});

async function failWrite(f, input, tool = "memory_checkpoint") {
  const lock = new DatabaseSync(f.path);
  lock.exec("BEGIN IMMEDIATE");
  try {
    await assert.rejects(f.call(tool, input), error => {
      assert.equal(error.code, "busy");
      assert.equal(error.recovery.pending_retained, true);
      assert.equal(error.recovery.persistence, "unconfirmed");
      return true;
    });
  } finally { lock.exec("ROLLBACK"); lock.close(); }
}

test("failed begin survives restart, retries its exact input once, and can be queried after recovery", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const input = { project_id: p, goal: "중단 전 시작 요청", mode: "change", idempotency_key: "failed-begin" };
  await failWrite(f, input, "memory_begin_task");
  await f.app.close();
  const app = f.open();
  const call = (name, args) => app.dispatcher.call(name, args);
  const before = await call("memory_recovery_status", scope(p));
  assert.equal(before.unfinished_runs.length, 0);
  assert.equal(before.requests.length, 1);
  assert.equal(before.requests[0].persistence, "not_found");
  const retry = { ...scope(p), request_id: before.requests[0].request_id };
  const first = await call("memory_retry_write", retry);
  assert.equal(first.status, "persisted");
  assert.equal(first.run.goal, input.goal);
  assert.deepEqual(await call("memory_retry_write", retry), first);
  assert.deepEqual(await call("memory_begin_task", input), first);
  const after = await call("memory_recovery_status", { ...scope(p), request_id: retry.request_id });
  assert.equal(after.requests[0].persistence, "persisted");
  assert.equal(after.requests[0].run_id, first.run.id);
  assert.equal(after.requests[0].original_input_retained, false);
  assert.equal(after.unfinished_runs.length, 1);
  assert.equal(after.unfinished_runs[0].attention, "unfinished_or_still_running");
  assert.equal(statSync(`${f.path}.recovery.sqlite`).mode & 0o777, 0o600);
});

test("checkpoint and finish failures recover across real MCP server processes without duplicate reports", { timeout: 20_000 }, async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const r = await run(f.call, p);
  await f.app.close();
  const clients = [];
  t.after(async () => { for (const client of clients) await client.close(); });
  const connect = async () => {
    const client = new Client({ name: "recovery-fixture", version: "1" });
    clients.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["dist/runtime/local/main.js", "serve", "--db", f.path], stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    await client.connect(transport);
    return client;
  };
  const call = async (client, name, args) => {
    const result = await client.callTool({ name, arguments: args });
    return { isError: result.isError === true, ...JSON.parse(result.content[0].text) };
  };
  let client = await connect();
  for (const [tool, input] of [
    ["memory_checkpoint", checkpoint(p, r, { report_origin: "contemporaneous", observed_at: "2026-01-01T00:00:00Z" })],
    ["memory_finish_task", { project_id: p, run_id: r, outcome: "completed", summary: "실행 검증 안 함", report_origin: "contemporaneous", idempotency_key: "finish" }],
  ]) {
    const lock = new DatabaseSync(f.path);
    lock.exec("BEGIN IMMEDIATE");
    let failure;
    try {
      failure = await call(client, tool, input);
      assert.equal(failure.isError, true);
      assert.equal(failure.error.code, "busy");
      assert.equal(failure.recovery.pending_retained, true);
    } finally { lock.exec("ROLLBACK"); lock.close(); }
    await client.close();
    client = await connect();
    const status = await call(client, "memory_recovery_status", scope(p));
    assert.equal(status.requests.length, 1);
    const args = { ...scope(p), request_id: failure.recovery.request_id };
    const recovered = await call(client, "memory_retry_write", args);
    assert.equal(recovered.isError, false);
    assert.equal(recovered.status, "persisted");
    assert.deepEqual(await call(client, "memory_retry_write", args), recovered);
  }
  const records = await call(client, "memory_query_context", { project_id: p, history: true });
  assert.equal(records.records.length, 2);
  assert.ok(records.records.every(record => record.report_origin === "contemporaneous" && record.knowledge_status === "unknown"));
  const saved = records.records.find(record => record.kind === "change");
  assert.equal(saved.observed_at, "2026-01-01T00:00:00.000Z");
  assert.equal((await call(client, "memory_get_status", { project_id: p, run_id: r })).run.state, "completed");
  await client.close();
});

test("a lost acknowledgement returns the real committed receipt, not a new record", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const r = await run(f.call, p);
  const journal = new DatabaseSync(`${f.path}.recovery.sqlite`);
  journal.exec("CREATE TRIGGER lose_ack BEFORE UPDATE OF input_json ON requests BEGIN SELECT RAISE(ABORT, 'lost ack'); END;");
  const input = checkpoint(p, r);
  const saved = await f.call("memory_checkpoint", input);
  assert.equal(saved.recovery.journal_acknowledged, false);
  assert.equal(saved.status, "persisted");
  journal.exec("DROP TRIGGER lose_ack");
  journal.close();
  await f.app.close();
  const next = f.open();
  const status = await next.dispatcher.call("memory_recovery_status", scope(p));
  assert.equal(status.requests[0].persistence, "persisted");
  assert.equal(status.requests[0].receipt.record_id, saved.record_id);
  const recovered = await next.dispatcher.call("memory_retry_write", { ...scope(p), request_id: status.requests[0].request_id });
  assert.equal(recovered.record_id, saved.record_id);
  assert.equal((await next.dispatcher.call("memory_query_context", { project_id: p, history: true })).records.length, 1);
});

test("read-only status and inspection do not close active runs, retry writes, or confuse retrospective reports", async t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, "skilly.project.json"), JSON.stringify({ version: 1, key: "example", name: "example", repository: "default", environment: "development" }));
  const p = await project(f.call);
  const r = await run(f.call, p);
  const live = await f.call("memory_checkpoint", checkpoint(p, r, { report_origin: "contemporaneous" }));
  const backfill = await f.call("memory_checkpoint", checkpoint(p, r, { report_origin: "retrospective", body: "나중에 정리한 보고, 실행 관측 아님", idempotency_key: "backfill" }));
  await failWrite(f, checkpoint(p, r, { idempotency_key: "pending" }));
  for (const id of [live.record_id, backfill.record_id]) {
    const evidence = await f.call("memory_get_evidence", { project_id: p, record_id: id });
    assert.equal(evidence.verified, false);
    assert.equal(evidence.knowledge_status, "unknown");
  }
  const status = await f.call("memory_recovery_status", scope(p));
  assert.equal(status.unfinished_runs[0].state, "active");
  assert.equal(status.requests[0].persistence, "not_found");
  await f.app.close();
  const before = [f.path, `${f.path}.recovery.sqlite`].map(path => readFileSync(path));
  const report = inspectMemory({ project: f.directory, db: f.path, attention: true });
  assert.equal(report.runs[0].state, "active");
  assert.deepEqual(report.runs[0].record_counts, { change: 2 });
  assert.equal(report.recovery_requests.length, 1);
  assert.match(formatInspection(report), /소급 작성 보고/);
  assert.match(formatInspection(report), /당시 작성 보고/);
  assert.deepEqual([f.path, `${f.path}.recovery.sqlite`].map(path => readFileSync(path)), before);
});

test("retained payload conflicts, cross-project access and forged input are refused", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const other = await project(f.call, "other");
  const r = await run(f.call, p);
  const input = checkpoint(p, r);
  await failWrite(f, input);
  const pending = (await f.call("memory_recovery_status", scope(p))).requests[0];
  await assert.rejects(f.call("memory_checkpoint", { ...input, body: "변경된 입력" }), { code: "idempotency_conflict" });
  await assert.rejects(f.call("memory_retry_write", { ...scope(other), request_id: pending.request_id }), { code: "scope_mismatch" });
  const bound = openLocal(f.path, { version: 1, key: "example", name: "example", repository: "another", environment: "development" });
  t.after(() => bound.close());
  await bound.dispatcher.call("memory_resolve_project", {});
  for (const tool of ["memory_retry_write", "memory_recovery_status"]) {
    await assert.rejects(bound.dispatcher.call(tool, { project_id: p, request_id: pending.request_id }), { code: "scope_mismatch" });
  }
  const raw = new DatabaseSync(`${f.path}.recovery.sqlite`);
  raw.prepare("UPDATE requests SET input_json = ? WHERE id = ?").run(JSON.stringify({ ...input, body: "위조" }), pending.request_id);
  raw.close();
  await assert.rejects(f.call("memory_retry_write", { ...scope(p), request_id: pending.request_id }), { code: "invalid_data" });
  assert.equal((await f.call("memory_query_context", { project_id: p })).records.length, 0);
});

test("a full or unavailable recovery journal rejects new writes without pretending they were retained", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const journal = new SqliteRecoveryJournal(`${f.path}.recovery.sqlite`);
  t.after(() => journal.close());
  for (let i = 0; i < 100; i++) {
    await journal.prepare({
      ...scope(p), id: hash(i), tool: "memory_begin_task", key: `pending-${i}`, hash: hash(`input-${i}`),
      input: { project_id: p }, received_at: "2026-01-01T00:00:00.000Z", last_error: null,
    });
  }
  await assert.rejects(f.call("memory_begin_task", { project_id: p, goal: "보관 실패", mode: "change", idempotency_key: "over-cap" }), error => {
    assert.equal(error.code, "recovery_full");
    assert.equal(error.recovery, undefined);
    return true;
  });
  assert.equal((await f.call("memory_recovery_status", { ...scope(p), limit: 20 })).requests.length, 20);
  assert.equal((await f.call("memory_recovery_status", { ...scope(p), limit: 20 })).next_offset, 20);
  assert.equal((await f.call("memory_recovery_status", scope(p))).unfinished_runs.length, 0);
  const linked = new SqliteRecoveryJournal(join(f.directory, "linked.sqlite"));
  symlinkSync(f.path, join(f.directory, "linked.sqlite"));
  await assert.rejects(linked.get("x"), { code: "recovery_unavailable" });
});

test("new permanently rejected writes do not exhaust retry capacity; earlier failed originals remain blocked", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const r = await run(f.call, p);
  await failWrite(f, checkpoint(p, r, { idempotency_key: "original-pending" }));
  const original = (await f.call("memory_recovery_status", scope(p))).requests[0];
  await f.call("memory_finish_task", { project_id: p, run_id: r, summary: "다른 세션에서 마감", outcome: "completed", idempotency_key: "close" });
  for (let i = 0; i < 101; i++) {
    await assert.rejects(f.call("memory_checkpoint", checkpoint(p, r, { idempotency_key: `invalid-${i}` })), error => {
      assert.equal(error.code, "run_closed");
      assert.equal(error.recovery.pending_retained, false);
      assert.equal(error.recovery.persistence, "rejected");
      return true;
    });
  }
  const next = await run(f.call, p, { idempotency_key: "valid-new-run" });
  assert.notEqual(next, r);
  await assert.rejects(f.call("memory_retry_write", { ...scope(p), request_id: original.request_id }), error => {
    assert.equal(error.code, "run_closed");
    assert.equal(error.recovery.pending_retained, true);
    return true;
  });
  const after = await f.call("memory_recovery_status", scope(p));
  assert.equal(after.requests.length, 1);
  assert.equal(after.requests[0].recovery_state, "blocked");
  assert.equal(after.requests[0].original_input_retained, true);
});

test("a concurrent receipt arriving while prepare fails is returned without a second write", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const r = await run(f.call, p);
  const input = checkpoint(p, r);
  const store = new SqliteMemoryStore(f.path);
  const journal = new SqliteRecoveryJournal(`${f.path}.recovery.sqlite`);
  t.after(() => { journal.close(); store.close(); });
  let saved;
  const race = new Proxy(journal, {
    get(target, property) {
      if (property === "prepare") return async () => {
        saved = await f.call("memory_checkpoint", input);
        throw new MemoryError("receipt_missing", "simulated prepare race");
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const recovery = new WriteRecovery(store, race, { id: randomUUID, now: () => new Date().toISOString(), hash });
  const result = await recovery.execute("memory_checkpoint", input, async () => { assert.fail("should replay the receipt"); });
  assert.deepEqual(result, saved);
  assert.equal((await f.call("memory_query_context", { project_id: p, history: true })).records.length, 1);
});

test("retained byte budget is enforced independently of the request count", async t => {
  const f = fixture(t);
  const journal = new SqliteRecoveryJournal(`${f.path}.recovery.sqlite`);
  t.after(() => journal.close());
  const p = randomUUID();
  for (let i = 0; i < 16; i++) {
    await journal.prepare({
      ...scope(p), id: hash(i), tool: "memory_checkpoint", key: `${i}`, hash: hash(`payload-${i}`),
      input: { body: "x".repeat(60 * 1024) }, received_at: new Date().toISOString(), last_error: null,
    });
  }
  await assert.rejects(journal.prepare({
    ...scope(p), id: hash("too-large"), tool: "memory_checkpoint", key: "large", hash: hash("large"),
    input: { body: "x".repeat(70 * 1024) }, received_at: new Date().toISOString(), last_error: null,
  }), { code: "recovery_full" });
});

test("a stale new caller cannot discard input used by a concurrent retry", async t => {
  const f = fixture(t);
  const journal = new SqliteRecoveryJournal(`${f.path}.recovery.sqlite`);
  t.after(() => journal.close());
  const request = { ...scope(randomUUID()), id: hash("concurrent"), tool: "memory_checkpoint", key: "concurrent",
    hash: hash("original"), input: { body: "원래 요청" }, received_at: new Date().toISOString(), last_error: null };
  assert.equal(await journal.prepare(request), "new");
  assert.equal(await journal.prepare(request), "existing");
  // Both orders preserve the original, even if the second failure hasn't been recorded yet.
  assert.equal(await journal.markFailed(request.id, "run_closed", false), true);
  assert.equal(await journal.markFailed(request.id, "busy", true), true);
  assert.deepEqual((await journal.get(request.id)).input, request.input);
  assert.equal(await journal.markFailed(request.id, "run_closed", false), true);
  assert.deepEqual((await journal.get(request.id)).input, request.input);
});

test("version 1 migration preserves records and receipt retries without relabeling historical content", async t => {
  const directory = mkdtempSync(join(tmpdir(), "skilly-migration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "v1.sqlite");
  const p = randomUUID(), r = randomUUID(), id = randomUUID(), date = "2026-01-01T00:00:00.000Z";
  const raw = new DatabaseSync(path);
  raw.exec(readFileSync(new URL("../migrations/001-local-memory.sql", import.meta.url), "utf8"));
  raw.prepare("INSERT INTO projects VALUES (?, 'legacy', 'legacy', 2, ?)").run(p, date);
  raw.prepare("INSERT INTO runs VALUES (?, ?, 'legacy', 'change', 'development', 'default', 'active', ?, ?)").run(r, p, date, date);
  raw.prepare("INSERT INTO records (id, project_id, run_id, topic, kind, body, environment, repository, observed_at, recorded_at) VALUES (?, ?, ?, 'old', 'note', '【소급 작성】본문만으로 유형 확정 금지', 'development', 'default', ?, ?)").run(id, p, r, date, date);
  const input = { project_id: p, run_id: r, topic: "old", kind: "note", body: "【소급 작성】본문만으로 유형 확정 금지", idempotency_key: "legacy" };
  const receipt = { status: "persisted", record_id: id, knowledge_status: "unknown", provenance: "agent_report", project_revision: 2 };
  raw.prepare("INSERT INTO receipts VALUES (?, ?, ?, ?)").run(p, "legacy", hash({ operation: "checkpoint", ...input }), JSON.stringify(receipt));
  raw.close();
  const app = openLocal(path);
  t.after(() => app.close());
  const evidence = await app.dispatcher.call("memory_get_evidence", { project_id: p, record_id: id });
  assert.equal(evidence.record.report_origin, "unspecified");
  assert.equal(evidence.record.body, input.body);
  assert.equal(evidence.record.recorded_at, date);
  assert.equal(evidence.verified, false);
  const retry = await app.dispatcher.call("memory_checkpoint", input);
  assert.equal(retry.record_id, id);
  assert.equal(retry.recovery.request_id, null);
  assert.equal(retry.recovery.journal_acknowledged, false);
  const migrated = new DatabaseSync(path);
  assert.equal(migrated.prepare("PRAGMA user_version").get().user_version, 10);
  assert.equal(migrated.prepare("SELECT count(*) AS n FROM records").get().n, 1);
  assert.deepEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
  migrated.close();
});

test("newer and foreign databases are preserved rather than migrated", () => {
  const directory = mkdtempSync(join(tmpdir(), "skilly-foreign-"));
  try {
    const path = join(directory, "future.sqlite");
    const db = new DatabaseSync(path);
    db.exec("PRAGMA application_id = 1397446988; PRAGMA user_version = 11;");
    db.close();
    assert.throws(() => new SqliteMemoryStore(path), { code: "schema_too_new" });
    const after = new DatabaseSync(path, { readOnly: true });
    assert.equal(after.prepare("PRAGMA user_version").get().user_version, 11);
    after.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
