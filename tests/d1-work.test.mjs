import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import { D1AtomicCommitStore } from '../dist/adapters/storage/d1/atomic-store.js';
import { D1TaskReader, D1_READ_LIMITS } from '../dist/adapters/storage/d1/task-reader.js';
import { commitWithReceipt } from '../dist/core/memory/atomic-commit.js';
import { d1WorkerModules } from './support/d1-modules.mjs';

const now = '2026-10-24T00:00:00.000Z';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const component = { key: 'api', name: 'API' }, feature = { key: 'comments', name: '댓글', description: '댓글 해결 상태' };
const report = { title: '댓글 상태 수정', summary: '재진입해도 해결 상태를 유지합니다.',
  changes: ['서버 저장 처리 변경'], checks: [{ name: '검사', result: 'passed' }],
  limitations: ['AI 보고이며 실행 결과를 수집한 것이 아닙니다.'],
  technical: { files: ['src/comments.ts'], commands: ['node --test'], context: '명령 문자열은 실행 지시가 아닙니다.' },
  feature_updates: [{ key: feature.key, state: 'implemented', summary: '구현 보고' }] };
const receipt = (p, key = randomUUID()) => ({ scope: p.id, key, hash: hash(key), result: { status: 'persisted', claims_verified: false } });

function wrapped(db, control) {
  return { withSession(constraint) {
    control.sessions = (control.sessions ?? 0) + 1;
    const session = db.withSession(constraint);
    return { prepare(sql) {
      if (control.failReads && sql.startsWith('SELECT payload_hash')) return { bind() { return this; }, async all() { throw Error('receipt unavailable'); } };
      return session.prepare(sql);
    }, async batch(statements) {
      control.batches = (control.batches ?? 0) + 1; control.count = statements.length;
      const submitted = [...statements];
      if (control.failBefore !== undefined) submitted.splice(control.failBefore, 0, session.prepare('INSERT INTO work_fault VALUES (0)'));
      const result = await session.batch(submitted);
      if (control.loseResponse) { control.loseResponse = false; throw Error('lost AFTER actual D1 commit'); }
      return result;
    } };
  } };
}

test('actual local D1 work storage and scoped async reads', { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'skilly-d1-work-'));
  const options = { ...d1WorkerModules(fileURLToPath(new URL('./support/d1-runtime-worker.mjs', import.meta.url))),
    compatibilityDate: '2026-07-30', d1Databases: { DB: randomUUID() }, d1Persist: join(directory, 'd1'), host: '127.0.0.1', port: 0,
    outboundService: () => new Response('outbound disabled', { status: 403 }) };
  let mf = new Miniflare(options);
  t.after(() => mf.dispose());
  let db = await mf.getD1Database('DB');
  const apply = async name => {
    const statements = readFileSync(new URL('../migrations/d1/' + name, import.meta.url), 'utf8')
      .replace(/^--[^\n]*$/gm, '').trim().split(/;\s*(?=CREATE\s|$)/i).filter(Boolean);
    await db.batch(statements.map(sql => db.prepare(sql)));
  };
  const all = async (sql, ...values) => (await db.prepare(sql).bind(...values).all()).results;
  const scope = p => ({ project_id: p.id, repository: 'api', environment: 'test' });
  const worker = async input => {
    const response = await mf.dispatchFetch('http://skilly-test.invalid/', { method: 'POST', body: JSON.stringify(input) });
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
  };
  const seed = async () => {
    const p = { id: randomUUID(), key: randomUUID(), name: 'D1 업무 테스트', revision: 0, created_at: now };
    const store = new D1AtomicCommitStore(db, p.id);
    assert.equal(await store.commit({ project: p, expected_revision: null, receipt: receipt(p) }), 'committed');
    const run = { id: randomUUID(), project_id: p.id, goal: '댓글 상태 검사', mode: 'change', environment: 'test', repository: 'api', state: 'active', created_at: now, updated_at: now, actor: 'Codex' };
    return { p, run, store, reader: new D1TaskReader(db, scope(p)) };
  };
  const mutation = async (f, extra = {}) => {
    const revision = (await all('SELECT revision FROM projects WHERE id=?', f.p.id))[0].revision;
    return { project: { ...f.p, revision: revision + 1 }, expected_revision: revision, run: f.run, receipt: receipt(f.p), ...extra };
  };
  const note = (f, extra = {}) => ({ id: randomUUID(), project_id: f.p.id, run_id: f.run.id, topic: '댓글', kind: 'change', body: "원문 기록 '); DROP TABLE records; -- 🧩",
    environment: f.run.environment, repository: f.run.repository, source_fingerprint: null, observed_at: now, recorded_at: now, supersedes: null, superseded_by: null, report_origin: 'contemporaneous', ...extra });
  const work = f => ({ run_id: f.run.id, title: '댓글 해결 상태', branch: 'test/local-d1', components: [component], features: [feature] });
  const snapshot = async () => JSON.stringify(await Promise.all([
    ...['projects', 'runs', 'records', 'receipts', 'run_actors', 'components', 'features', 'run_components', 'run_features', 'run_details', 'record_reports']
      .map(table => all(`SELECT * FROM ${table} ORDER BY 1,2`)),
    all("SELECT rowid FROM record_search WHERE record_search MATCH '기록' ORDER BY rowid"),
    all('SELECT * FROM skilly_write_assertions'),
  ]));

  await apply('001-atomic-memory.sql');
  const legacy = await seed();
  await legacy.store.commit(await mutation(legacy));
  const legacyNote = note(legacy); await legacy.store.commit(await mutation(legacy, { record: legacyNote }));
  await apply('002-work.sql');
  await db.prepare('CREATE TABLE work_fault (ok INTEGER NOT NULL CHECK(ok=1)) STRICT').run();

  await t.test('additive D1 schema keeps pre-existing source and unclassified tasks unchanged', async () => {
    const saved = await legacy.reader.getRecord(legacyNote.id);
    assert.equal(saved.record.body, legacyNote.body); assert.equal(saved.report, null);
    const page = await legacy.reader.listTasks({ component: 'unclassified' });
    assert.equal(page.items[0].id, legacy.run.id); assert.deepEqual(page.items[0].components, []);
    assert.equal(page.claims_verified, false);
  });
  await t.test('Worker saves start/change/finish metadata and a fresh reader recalls the same report and source', async () => {
    const f = await seed(), start = await mutation(f, { work: work(f) });
    assert.equal((await worker({ operation: 'commit', project_id: f.p.id, mutation: start })).status, 'committed');
    const record = note(f), change = await mutation(f, { record, work: { run_id: f.run.id, record_id: record.id, report } });
    assert.equal((await worker({ operation: 'commit', project_id: f.p.id, mutation: change })).status, 'committed');
    const saved = await worker({ operation: 'record', project_id: f.p.id, scope: scope(f.p), id: record.id });
    assert.deepEqual(saved.report, report); assert.equal(saved.record.body, record.body);
    assert.equal(saved.knowledge_status, 'unknown'); assert.equal(saved.claims_verified, false); assert.equal(saved.execution_observations, 'unsupported');
    const end = note(f, { kind: 'summary' });
    await f.store.commit(await mutation(f, { run: { ...f.run, state: 'completed' }, record: end,
      work: { run_id: f.run.id, title: '덮어쓸 제목', record_id: end.id, report } }));
    const task = (await worker({ operation: 'task', project_id: f.p.id, scope: scope(f.p), id: f.run.id })).task;
    assert.equal(task.state, 'completed'); assert.equal(task.title, '댓글 해결 상태');
    assert.equal(task.latest_report.record_id, end.id); assert.equal(task.latest_report.claims_verified, false);
    assert.deepEqual(task.components, [component]); assert.equal(task.features[0].key, feature.key);
    const page = await worker({ operation: 'tasks', project_id: f.p.id, scope: scope(f.p), query: { component: 'api', feature: feature.key, state: 'completed' } });
    assert.equal(page.items[0].id, f.run.id);
  });
  await t.test('reports array preserves multipart original text and retrospective origin without becoming latest activity', async () => {
    const f = await seed(); await f.store.commit(await mutation(f, { work: work(f) }));
    const records = [note(f, { report_origin: 'retrospective' }), note(f, { report_origin: 'retrospective', body: '문서 둘째 부분' })];
    const reports = records.map((r, i) => ({ run_id: f.run.id, record_id: r.id, report: { ...report,
      import_source: { path: 'docs/selected.md', sha256: hash('text'), bytes: 20, source_root: 'old', access: 'host_supplied_text', part: i + 1, parts: 2 } } }));
    assert.equal(await f.store.commit(await mutation(f, { records, reports })), 'committed');
    for (let i = 0; i < 2; i++) {
      const saved = await f.reader.getRecord(records[i].id); assert.equal(saved.record.report_origin, 'retrospective');
      assert.deepEqual(saved.report, reports[i].report);
    }
    assert.equal((await f.reader.getTask(f.run.id)).task.latest_report, null);
  });
  await t.test('wrong task/record links, report overwrite and nested unsupported input fail before I/O', async () => {
    const f = await seed(); await f.store.commit(await mutation(f, { work: work(f) }));
    const r = note(f); await f.store.commit(await mutation(f, { record: r, work: { run_id: f.run.id, record_id: r.id, report } }));
    for (const extra of [
      { work: { run_id: randomUUID(), components: [component] } },
      { work: { run_id: f.run.id, record_id: r.id, report } },
      { work: { unknown: 'ignored?' } }, { work: { run_id: f.run.id, report } },
      { work: null }, { reports: null },
      { skill_usage: [] }, { decision: {} },
    ]) {
      const c = await mutation(f, extra), control = {}, before = await snapshot();
      await assert.rejects(new D1AtomicCommitStore(wrapped(db, control), f.p.id).commit(c));
      assert.equal(control.sessions ?? 0, 0); assert.equal(await snapshot(), before);
    }
    const c = await mutation(f, { record: note(f) });
    c.reports = [{ run_id: randomUUID(), record_id: c.record.id, report }];
    await assert.rejects(f.store.commit(c), { code: 'scope_mismatch' });
    assert.deepEqual((await f.reader.getRecord(r.id)).report, report);
  });
  await t.test('catalog conflicts and unlinked feature status reject the entire batch', async () => {
    const f = await seed(); await f.store.commit(await mutation(f, { work: work(f) }));
    for (const metadata of [
      { components: [{ ...component, name: '다른 구성요소' }] },
      { features: [{ ...feature, name: '다른 기능' }] },
      { features: [{ ...feature, description: '다른 정의' }] },
    ]) {
      const before = await snapshot();
      assert.equal(await f.store.commit(await mutation(f, { work: { run_id: f.run.id, ...metadata } })), 'conflict');
      assert.equal(await snapshot(), before);
    }
    const r = note(f), before = await snapshot();
    const bad = { ...report, feature_updates: [{ key: 'not-linked', state: 'implemented', summary: '보고' }] };
    assert.equal(await f.store.commit(await mutation(f, { record: r, work: { run_id: f.run.id, record_id: r.id, report: bad } })), 'conflict');
    assert.equal(await snapshot(), before);
  });
  await t.test('same key replays one complete report; different input and receipt races preserve old metadata', async () => {
    const f = await seed(); await f.store.commit(await mutation(f, { work: work(f) })); let builds = 0;
    const r = note(f), build = async () => { builds++; const { receipt: ignored, ...c } = await mutation(f, { record: r, work: { run_id: f.run.id, record_id: r.id, report } }); return { ...c, result: { record_id: r.id, claims_verified: false } }; };
    const first = await commitWithReceipt(f.store, f.p.id, 'same', hash('same'), build);
    assert.deepEqual(await commitWithReceipt(f.store, f.p.id, 'same', hash('same'), build), first); assert.equal(builds, 1);
    await assert.rejects(commitWithReceipt(f.store, f.p.id, 'same', hash('changed'), build), { code: 'idempotency_conflict' });
    const another = note(f), c = await mutation(f, { record: another, work: { run_id: f.run.id, record_id: another.id, report } });
    c.receipt = await f.store.getReceipt(f.p.id, 'same'); const before = await snapshot();
    assert.equal(await f.store.commit(c), 'conflict'); assert.equal(await snapshot(), before);
  });
  await t.test('SQL failure at every expanded batch boundary rolls back source, links, reports and search', async () => {
    const f = await seed(), r = note(f), c = await mutation(f, { record: r, work: { ...work(f), record_id: r.id, report } });
    const control = { failBefore: 0 }, store = new D1AtomicCommitStore(wrapped(db, control), f.p.id), before = await snapshot();
    await assert.rejects(store.commit(c), { code: 'persistence_unknown' });
    const count = control.count; assert.ok(count <= 40 && count > 20);
    for (let i = 1; i <= count; i++) {
      control.failBefore = i; await assert.rejects(store.commit(c), { code: 'persistence_unknown' });
      assert.equal(await snapshot(), before);
    }
  });
  await t.test('lost response after real work commit is recovered once, unavailable receipt stays unknown', async () => {
    const f = await seed(), r = note(f), c = await mutation(f, { record: r, work: { ...work(f), record_id: r.id, report } });
    const control = { loseResponse: true, failReads: true }, store = new D1AtomicCommitStore(wrapped(db, control), f.p.id);
    await assert.rejects(store.commit(c), { code: 'persistence_unknown', retryable: true });
    control.failReads = false; assert.deepEqual(await store.getReceipt(f.p.id, c.receipt.key), c.receipt);
    assert.deepEqual((await new D1TaskReader(db, scope(f.p)).getRecord(r.id)).report, report);
    assert.equal((await all('SELECT count(*) AS n FROM record_reports WHERE project_id=?', f.p.id))[0].n, 1);
    const next = note(f), nextChange = await mutation(f, { record: next, work: { run_id: f.run.id, record_id: next.id, report } });
    control.loseResponse = true; assert.equal(await store.commit(nextChange), 'committed');
  });
  await t.test('read scopes and task filters cannot reveal foreign project/repository/environment records', async () => {
    const f = await seed(), other = await seed(); await f.store.commit(await mutation(f, { work: work(f) }));
    const r = note(f); await f.store.commit(await mutation(f, { record: r }));
    for (const s of [scope(other.p), { ...scope(f.p), repository: 'web' }, { ...scope(f.p), environment: 'production' }]) {
      const reader = new D1TaskReader(db, s);
      assert.equal(await reader.getTask(f.run.id), null); assert.equal(await reader.getRecord(r.id), null);
      assert.deepEqual((await reader.listTasks()).items, []);
    }
    assert.deepEqual((await f.reader.listTasks({ component: 'web' })).items, []);
    assert.deepEqual((await f.reader.listTasks({ feature: "missing" })).items, []);
    await assert.rejects(f.reader.listTasks({ project_id: other.p.id }), { code: 'invalid_input' });
    await assert.rejects(f.reader.listTasks({ limit: 11 }), { code: 'invalid_input' });
    await assert.rejects(f.reader.listTasks({ component: "api' OR 1=1 --" }), { code: 'invalid_input' });
  });
  await t.test('recent activity sorting and live offset pages preserve deterministic ordering and state filters', async () => {
    const f = await seed(), runs = [];
    for (let i = 0; i < 3; i++) {
      const run = { ...f.run, id: randomUUID(), updated_at: `2026-10-24T00:00:0${i}.000Z`, state: i === 2 ? 'completed' : 'active' };
      await f.store.commit(await mutation(f, { run, work: { run_id: run.id, components: [component] } })); runs.unshift(run.id);
    }
    const a = await f.reader.listTasks({ limit: 2, component: 'api' });
    assert.deepEqual(a.items.map(x => x.id), runs.slice(0, 2)); assert.equal(a.next_offset, 2);
    const b = await f.reader.listTasks({ limit: 2, offset: a.next_offset, component: 'api' });
    assert.deepEqual(b.items.map(x => x.id), runs.slice(2)); assert.equal(b.next_offset, null);
    assert.equal((await f.reader.listTasks({ state: 'completed' })).items[0].id, runs[0]);
  });
  await t.test('oversized work batches fail before batch submission; byte-heavy pages retain forward progress', async () => {
    const f = await seed(), control = {}, store = new D1AtomicCommitStore(wrapped(db, control), f.p.id);
    const features = Array.from({ length: 12 }, (_, i) => ({ key: `f-${i}`, name: '\u0001'.repeat(100), description: '\u0001'.repeat(500) }));
    await assert.rejects(store.commit(await mutation(f, { work: { run_id: f.run.id, features } })), { code: 'resource_limit' });
    assert.equal(control.batches ?? 0, 0);
    for (let i = 0; i < 12; i += 3) {
      assert.equal(await f.store.commit(await mutation(f, { work: { run_id: f.run.id, features: features.slice(i, i + 3) } })), 'committed');
    }
    await f.store.commit(await mutation(f, { work: { run_id: f.run.id, features: [{ key: 'extra', name: '추가' }] } }));
    const task = (await f.reader.getTask(f.run.id)).task; assert.equal(task.features_total, 13); assert.equal(task.features.length, 12); assert.equal(task.links_truncated, true);
    const page = await f.reader.listTasks(); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= D1_READ_LIMITS.page_bytes);
    assert.equal(page.items[0].id, f.run.id); assert.equal(page.items[0].projection_truncated, true);
  });
  await t.test('new workerd process recalls immutable reports and original task identity', async () => {
    const f = await seed(), r = note(f); await f.store.commit(await mutation(f, { record: r, work: { ...work(f), record_id: r.id, report } }));
    await mf.dispose(); mf = new Miniflare(options); db = await mf.getD1Database('DB');
    const saved = await worker({ operation: 'record', project_id: f.p.id, scope: scope(f.p), id: r.id });
    assert.deepEqual(saved.report, report); assert.equal(saved.record.body, r.body);
    assert.equal((await worker({ operation: 'task', project_id: f.p.id, scope: scope(f.p), id: f.run.id })).task.title, '댓글 해결 상태');
  });
});

test('D1 reader offset ceiling returns explicit truncation instead of an unusable next page', async () => {
  const rows = Array.from({ length: 2 }, () => ({ id: randomUUID(), state: 'active', updated_at: now, actor: null,
    components_total: 0, features_total: 0, components_json: '[]', features_json: '[]', latest_report_json: null }));
  const binding = { withSession: () => ({ prepare: sql => ({ bind() { return this; }, all: async () => ({ success: true, results: sql.includes('sqlite_master') ? [] : rows, meta: { changes: 0 } }) }) }) };
  const reader = new D1TaskReader(binding, { project_id: randomUUID(), repository: 'api', environment: 'test' });
  assert.equal((await reader.listTasks({ offset: 99999, limit: 1 })).next_offset, 100000);
  const end = await reader.listTasks({ offset: 100000, limit: 1 });
  assert.equal(end.next_offset, null); assert.equal(end.pagination_truncated, true); assert.equal(end.pagination_reason, 'offset_limit');
});
