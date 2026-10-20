import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MemoryService } from "../dist/core/memory/service.js";
import { SqliteMemoryStore } from "../dist/adapters/storage/sqlite/store.js";
import { ToolDispatcher } from "../dist/transport/tools.js";
import { fixture, project, run, checkpoint } from "./helpers.mjs";

test("new feature: register, begin, save, search, finish and reopen the same database", async t => {
  const f = fixture(t);
  const projectId = await project(f.call);
  const runId = await run(f.call, projectId);
  const saved = await f.call("memory_checkpoint", checkpoint(projectId, runId));
  assert.equal(saved.status, "persisted");
  const query = await f.call("memory_query_context", { project_id: projectId, query: "해결" });
  assert.equal(query.records[0].id, saved.record_id);
  assert.equal(query.records[0].knowledge_status, "unknown");
  assert.deepEqual(query.current_knowledge, []);
  const finish = await f.call("memory_finish_task", {
    project_id: projectId, run_id: runId, outcome: "completed", summary: "구현 완료, 검증은 별도로 확인 필요",
    idempotency_key: "finish",
  });
  assert.equal(finish.knowledge_status, "unknown");
  const reopened = f.open();
  const status = await reopened.dispatcher.call("memory_get_status", { project_id: projectId, run_id: runId });
  assert.equal(status.run.state, "completed");
  assert.equal(status.capture, "agent_reports_only");
  assert.equal(statSync(f.path).mode & 0o777, 0o600);
});

test("projects, repositories and environments cannot be mixed by supplied record/run IDs", async t => {
  const f = fixture(t);
  const a = await project(f.call, "a");
  const b = await project(f.call, "b");
  const aRun = await run(f.call, a);
  const bRun = await run(f.call, b);
  const saved = await f.call("memory_checkpoint", checkpoint(a, aRun));
  await f.call("memory_checkpoint", checkpoint(b, bRun, { body: "B만의 비공개 기록" }));
  await assert.rejects(f.call("memory_checkpoint", checkpoint(b, aRun, { idempotency_key: "wrong" })), { code: "not_found" });
  await assert.rejects(f.call("memory_get_evidence", { project_id: b, record_id: saved.record_id }), { code: "not_found" });
  await assert.rejects(f.call("memory_checkpoint", checkpoint(b, bRun, { supersedes: saved.record_id, idempotency_key: "cross-project" })), { code: "not_found" });
  assert.equal((await f.call("memory_query_context", { project_id: a, query: "비공개" })).records.length, 0);
  assert.equal((await f.call("memory_query_context", { project_id: a, repository: "another" })).records.length, 0);
  assert.equal((await f.call("memory_query_context", { project_id: a, environment: "production" })).records.length, 0);
});

test("idempotent writes replay receipts, reject altered payload and survive concurrent replay", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const r = await run(f.call, p);
  const input = checkpoint(p, r);
  const [first, second] = await Promise.all([
    f.call("memory_checkpoint", input),
    f.open().dispatcher.call("memory_checkpoint", input),
  ]);
  assert.deepEqual(first, second);
  assert.deepEqual(await f.call("memory_checkpoint", input), first);
  await assert.rejects(f.call("memory_checkpoint", { ...input, body: "different" }), { code: "idempotency_conflict" });
  assert.equal((await f.call("memory_query_context", { project_id: p, history: true })).records.length, 1);
});

test("existing feature correction preserves history and rejects stale or conflicting replacement", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const r = await run(f.call, p);
  const first = await f.call("memory_checkpoint", checkpoint(p, r, {
    body: "해결 상태는 메모리에만 보관", observed_at: "2025-01-02T00:00:00Z",
  }));
  await assert.rejects(f.call("memory_checkpoint", checkpoint(p, r, {
    supersedes: first.record_id, observed_at: "2025-01-01T00:00:00Z", idempotency_key: "old",
  })), { code: "older_observation" });
  await assert.rejects(f.call("memory_checkpoint", checkpoint(p, r, {
    supersedes: first.record_id, topic: "another-feature", idempotency_key: "scope",
  })), { code: "scope_mismatch" });
  const second = await f.call("memory_checkpoint", checkpoint(p, r, {
    body: "해결 상태를 DB에 저장", supersedes: first.record_id, idempotency_key: "correction",
  }));
  const current = await f.call("memory_query_context", { project_id: p });
  assert.deepEqual(current.records.map(item => item.id), [second.record_id]);
  assert.equal((await f.call("memory_query_context", { project_id: p, query: "메모리" })).records.length, 0);
  const history = await f.call("memory_query_context", { project_id: p, history: true });
  assert.equal(history.records.find(item => item.id === first.record_id).knowledge_status, "superseded");
  assert.equal((await f.call("memory_get_evidence", { project_id: p, record_id: first.record_id })).record.body, "해결 상태는 메모리에만 보관");
  await assert.rejects(f.call("memory_checkpoint", checkpoint(p, r, {
    supersedes: first.record_id, idempotency_key: "late-correction",
  })), { code: "conflict" });
});

test("two competing corrections do not silently overwrite each other", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const r = await run(f.call, p);
  const original = await f.call("memory_checkpoint", checkpoint(p, r));
  const results = await Promise.allSettled(["left", "right"].map(value =>
    f.call("memory_checkpoint", checkpoint(p, r, { body: value, supersedes: original.record_id, idempotency_key: value }))));
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(results.find(item => item.status === "rejected").reason.code, "conflict");
  assert.equal((await f.call("memory_query_context", { project_id: p, history: true })).records.length, 2);
});

test("an agent claim and a matching fingerprint never become verified facts", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const r = await run(f.call, p);
  await f.call("memory_checkpoint", checkpoint(p, r, { body: "모든 테스트 통과", source_fingerprint: "commit+dirty-hash-a" }));
  const same = await f.call("memory_query_context", { project_id: p, source_fingerprint: "commit+dirty-hash-a" });
  assert.equal(same.records[0].knowledge_status, "unknown");
  assert.equal((await f.call("memory_query_context", { project_id: p, source_fingerprint: "commit+dirty-hash-b" })).records.length, 0);
  const history = await f.call("memory_query_context", { project_id: p, source_fingerprint: "commit+dirty-hash-b", history: true });
  assert.equal(history.records[0].knowledge_status, "stale");
  await assert.rejects(f.call("memory_checkpoint", { ...checkpoint(p, r), verified: true }), { code: "invalid_input" });
});

test("Korean partial words and quoted punctuation work without exposing FTS syntax", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const r = await run(f.call, p);
  await f.call("memory_checkpoint", checkpoint(p, r, { body: "댓글해결됨 상태가 새로고침 뒤 유지됨" }));
  assert.equal((await f.call("memory_query_context", { project_id: p, query: "해결" })).records.length, 1);
  assert.equal((await f.call("memory_query_context", { project_id: p, query: '"새로고침"' })).records.length, 1);
  assert.equal((await f.call("memory_query_context", { project_id: p, query: '*") OR (' })).records.length, 0);
  assert.equal((await f.call("memory_query_context", { project_id: p, query: "***" })).records.length, 0);
});

test("context pagination obeys UTF-8 byte budget and invalidates after a write", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const r = await run(f.call, p);
  for (let index = 0; index < 40; index++) {
    await f.call("memory_checkpoint", checkpoint(p, r, {
      body: `${index} ${"😀한글".repeat(300)}`, idempotency_key: `item:${index}`,
    }));
  }
  const input = { project_id: p, limit: 50 };
  const first = await f.call("memory_query_context", input);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 32 * 1024);
  assert.equal(first.truncated, true);
  const ids = new Set(first.records.map(item => item.id));
  let cursor = first.next_cursor;
  while (cursor) {
    const page = await f.call("memory_query_context", { ...input, cursor });
    for (const record of page.records) { assert.equal(ids.has(record.id), false); ids.add(record.id); }
    cursor = page.next_cursor;
  }
  assert.equal(ids.size, 40);
  await assert.rejects(f.call("memory_query_context", { ...input, query: "different", cursor: first.next_cursor }), { code: "invalid_cursor" });
  await f.call("memory_checkpoint", checkpoint(p, r, { idempotency_key: "new" }));
  await assert.rejects(f.call("memory_query_context", { ...input, cursor: first.next_cursor }), { code: "invalid_cursor" });
});

test("record, index and receipt commit atomically even when the final insert fails", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const r = await run(f.call, p);
  const raw = new DatabaseSync(f.path);
  try {
    raw.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON receipts BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    await assert.rejects(f.call("memory_checkpoint", checkpoint(p, r)), { code: "storage_error" });
    assert.equal(raw.prepare("SELECT count(*) AS n FROM records").get().n, 0);
    assert.equal(raw.prepare("SELECT count(*) AS n FROM record_search WHERE record_search MATCH '댓글'").get().n, 0);
    raw.exec("DROP TRIGGER fail_receipt");
    await f.call("memory_checkpoint", checkpoint(p, r));
    assert.equal(raw.prepare("SELECT count(*) AS n FROM records").get().n, 1);
    assert.equal(raw.prepare("PRAGMA foreign_key_check").all().length, 0);
    const plan = raw.prepare("EXPLAIN QUERY PLAN SELECT * FROM records WHERE project_id = ? AND environment = ? AND repository = ? AND topic = ? ORDER BY seq DESC LIMIT 10")
      .all(p, "development", "default", "comments-resolution");
    assert.ok(plan.some(row => row.detail.includes("records_topic")));
  } finally { raw.close(); }
});

test("database lock is bounded and never reported as saved", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const r = await run(f.call, p);
  const raw = new DatabaseSync(f.path);
  try {
    raw.exec("BEGIN IMMEDIATE");
    await assert.rejects(f.call("memory_checkpoint", checkpoint(p, r)), { code: "busy", retryable: true });
  } finally { raw.exec("ROLLBACK"); raw.close(); }
  assert.equal((await f.call("memory_query_context", { project_id: p })).records.length, 0);
  await f.call("memory_checkpoint", checkpoint(p, r));
});

test("closed tasks reject new records but replay an already saved finish receipt", async t => {
  const f = fixture(t);
  const p = await project(f.call);
  const r = await run(f.call, p);
  const input = { project_id: p, run_id: r, summary: "중단됨", outcome: "interrupted", idempotency_key: "finish" };
  const result = await f.call("memory_finish_task", input);
  assert.deepEqual(await f.call("memory_finish_task", input), result);
  await assert.rejects(f.call("memory_checkpoint", checkpoint(p, r)), { code: "run_closed" });
});

test("a duplicate finish replays a receipt committed between its read and state checks", async t => {
  const store = new SqliteMemoryStore(":memory:");
  t.after(() => store.close());
  const context = { id: randomUUID, now: () => new Date().toISOString(), hash: JSON.stringify };
  const original = new ToolDispatcher(new MemoryService(store, context));
  const call = (name, input) => original.call(name, input);
  const p = await project(call);
  const r = await run(call, p);
  const input = { project_id: p, run_id: r, summary: "마감", outcome: "completed", idempotency_key: "finish" };
  let committed;
  let injected = false;
  const interleaved = new Proxy(store, {
    get(target, property) {
      if (property === "getReceipt") return async (scope, key) => {
        const receipt = await target.getReceipt(scope, key);
        if (!injected && key === "finish") {
          injected = true;
          committed = await call("memory_finish_task", input);
        }
        return receipt;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const retry = new ToolDispatcher(new MemoryService(interleaved, context));
  assert.deepEqual(await retry.call("memory_finish_task", input), committed);
  assert.equal((await call("memory_query_context", { project_id: p, history: true })).records.length, 1);
});

test("input, burst and drain limits reject excess work before persistence", async t => {
  const f = fixture(t);
  await assert.rejects(f.call("memory_register_project", { key: "a", name: "x".repeat(140 * 1024), idempotency_key: "a" }), { code: "payload_too_large" });
  await assert.rejects(f.call("memory_register_project", { key: "a", name: "a", idempotency_key: "a", unexpected: true }), { code: "invalid_input" });
  const calls = Array.from({ length: 33 }, () => f.call("memory_list_projects", {}));
  const results = await Promise.allSettled(calls);
  assert.equal(results.filter(item => item.status === "rejected").length, 1);
  assert.equal(results.at(-1).reason.code, "busy");
  await f.app.dispatcher.drain();
  await assert.rejects(f.call("memory_list_projects", {}), { code: "busy" });
});
