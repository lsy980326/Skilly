import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteMemoryStore } from '../dist/adapters/storage/sqlite/store.js';
import { D1AtomicCommitStore } from '../dist/adapters/storage/d1/atomic-store.js';
import { commitWithReceipt } from '../dist/core/memory/atomic-commit.js';
import { LocalD1Binding, openD1Database } from './support/d1-binding.mjs';

const now = '2026-10-24T00:00:00.000Z';
const hash = input => createHash('sha256').update(JSON.stringify(input)).digest('hex');
function fixture(t, kind) {
  const path = join(mkdtempSync(join(tmpdir(), 'skilly-storage-contract-')), 'test.sqlite');
  const stores = [];
  if (kind === 'sqlite') stores.push(new SqliteMemoryStore(path));
  const db = openD1Database(path);
  if (kind === 'd1-shape') db.exec(readFileSync(new URL('../migrations/d1/001-atomic-memory.sql', import.meta.url), 'utf8'));
  const binding = new LocalD1Binding(db);
  const store = projectId => {
    if (kind === 'd1-shape') return new D1AtomicCommitStore(binding, projectId);
    const next = new SqliteMemoryStore(path); stores.push(next); return next;
  };
  t.after(() => { for (const s of stores.reverse()) s.close(); db.close(); });
  const p = { id: randomUUID(), key: randomUUID(), name: '계약 테스트', revision: 0, created_at: now };
  const project = () => { const r = db.prepare('SELECT * FROM projects WHERE id=?').get(p.id); return { ...p, revision: r.revision }; };
  const snapshot = () => JSON.stringify(['projects', 'runs', 'records', 'receipts', 'run_actors'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
  return { db, binding, store, p, project, snapshot, kind };
}
function receipt(p, key, result = { status: 'persisted', claims_verified: false }) { return { scope: p.id, key, hash: hash(key), result }; }
async function seed(f) { assert.equal(await f.store(f.p.id).commit({ project: f.p, expected_revision: null, receipt: receipt(f.p, 'create') }), 'committed'); }
function start(f, extra = {}) {
  const p = f.project();
  const run = { id: randomUUID(), project_id: p.id, goal: '합성 계약 과제', mode: 'change', environment: 'test', repository: 'api', state: 'active', created_at: now, updated_at: now, actor: 'Codex' };
  return { project: { ...p, revision: p.revision + 1 }, expected_revision: p.revision, run, receipt: receipt(p, 'begin'), ...extra };
}
function change(f, run, extra = {}) {
  const p = f.project(), record = { id: randomUUID(), project_id: p.id, run_id: run.id, topic: '계약', kind: 'change', body: '저장 기록 🧩', environment: run.environment, repository: run.repository, source_fingerprint: null, observed_at: now, recorded_at: now, supersedes: null, superseded_by: null, report_origin: 'contemporaneous' };
  return { project: { ...p, revision: p.revision + 1 }, expected_revision: p.revision, run, record, receipt: receipt(p, randomUUID()), ...extra };
}

for (const kind of ['sqlite', 'd1-shape']) {
  test(`${kind}: create, begin, change, finish and a fresh connection preserve original records and receipts`, async t => {
    const f = fixture(t, kind); await seed(f); const s = f.store(f.p.id), begin = start(f);
    assert.equal(await s.commit(begin), 'committed'); const note = change(f, begin.run);
    assert.equal(await s.commit(note), 'committed');
    const finish = change(f, { ...begin.run, state: 'completed' }); finish.record.kind = 'summary';
    assert.equal(await s.commit(finish), 'committed');
    assert.equal(f.db.prepare('SELECT state FROM runs WHERE id=?').get(begin.run.id).state, 'completed');
    assert.equal(f.db.prepare('SELECT body FROM records WHERE id=?').get(note.record.id).body, note.record.body);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM record_search WHERE record_search MATCH '기록'").get().n, 2);
    assert.deepEqual(await f.store(f.p.id).getReceipt(f.p.id, note.receipt.key), note.receipt);
    if (kind === 'd1-shape') assert.ok(f.binding.constraints.every(c => c === 'first-primary'));
  });
  test(`${kind}: same key retries return the original result, different input conflicts`, async t => {
    const f = fixture(t, kind); await seed(f); const s = f.store(f.p.id); let builds = 0;
    const build = async () => { builds++; const c = start(f); return { ...c, receipt: undefined, result: { run_id: c.run.id, claims_verified: false } }; };
    const first = await commitWithReceipt(s, f.p.id, 'request-1', hash('input-1'), build);
    assert.deepEqual(await commitWithReceipt(s, f.p.id, 'request-1', hash('input-1'), build), first);
    assert.equal(builds, 1); assert.equal(f.project().revision, 1);
    await assert.rejects(commitWithReceipt(s, f.p.id, 'request-1', hash('different'), build), { code: 'idempotency_conflict' });
  });
  test(`${kind}: stale revision, including one already advanced to the proposed value, commits nothing`, async t => {
    const f = fixture(t, kind); await seed(f); const stale = start(f), winner = start(f);
    stale.receipt = receipt(f.p, 'stale-begin');
    assert.equal(await f.store(f.p.id).commit(winner), 'committed');
    const before = f.snapshot(); assert.equal(await f.store(f.p.id).commit(stale), 'conflict'); assert.equal(f.snapshot(), before);
    assert.equal(await f.store(f.p.id).getReceipt(f.p.id, stale.receipt.key), undefined);
  });
  test(`${kind}: a last-statement receipt collision rolls back all preceding writes and index changes`, async t => {
    const f = fixture(t, kind); await seed(f); const begin = start(f); await f.store(f.p.id).commit(begin);
    const attempted = change(f, begin.run); attempted.receipt = begin.receipt;
    const before = f.snapshot(); assert.equal(await f.store(f.p.id).commit(attempted), 'conflict');
    assert.equal(f.snapshot(), before); assert.equal(f.db.prepare("SELECT count(*) AS n FROM record_search WHERE record_search MATCH '기록'").get().n, 0);
  });
  test(`${kind}: concurrent same-key requests save one run and return one receipt`, async t => {
    const f = fixture(t, kind); await seed(f); const a = f.store(f.p.id), b = f.store(f.p.id);
    const build = async () => { const c = start(f); return { project: c.project, expected_revision: c.expected_revision, run: c.run, result: { run_id: c.run.id, claims_verified: false } }; };
    const [x, y] = await Promise.all([commitWithReceipt(a, f.p.id, 'same-key', hash('same'), build), commitWithReceipt(b, f.p.id, 'same-key', hash('same'), build)]);
    assert.deepEqual(x, y); assert.equal(f.project().revision, 1); assert.equal(f.db.prepare('SELECT count(*) AS n FROM runs').get().n, 1);
  });
  test(`${kind}: competing corrections preserve original content and have one winner`, async t => {
    const f = fixture(t, kind); await seed(f); const s = f.store(f.p.id), begin = start(f); await s.commit(begin);
    const original = change(f, begin.run); await s.commit(original);
    const a = change(f, begin.run), b = change(f, begin.run); a.record.supersedes = b.record.supersedes = original.record.id;
    a.record.body = '정정 A'; b.record.body = '정정 B';
    const results = await Promise.all([s.commit(a), f.store(f.p.id).commit(b)]);
    assert.deepEqual(results.sort(), ['committed', 'conflict']);
    const old = f.db.prepare('SELECT body,superseded_by FROM records WHERE id=?').get(original.record.id);
    assert.equal(old.body, original.record.body); assert.ok([a.record.id, b.record.id].includes(old.superseded_by));
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM records').get().n, 2);
  });
  test(`${kind}: project/run ownership and colliding foreign run IDs cannot mutate another project`, async t => {
    const f = fixture(t, kind); await seed(f); const s = f.store(f.p.id), begin = start(f); await s.commit(begin);
    const before = f.snapshot(), invalid = change(f, { ...begin.run, project_id: randomUUID() });
    await assert.rejects(s.commit(invalid), { code: 'scope_mismatch' }); assert.equal(f.snapshot(), before);
    const other = { ...f.p, id: randomUUID(), key: randomUUID() }; const otherStore = f.store(other.id);
    await otherStore.commit({ project: other, expected_revision: null, receipt: receipt(other, 'create-other') });
    const foreignId = { ...start(f), project: { ...other, revision: 1 }, expected_revision: 0, run: { ...begin.run, project_id: other.id }, receipt: receipt(other, 'collision') };
    const previous = f.snapshot(); assert.equal(await otherStore.commit(foreignId), 'conflict'); assert.equal(f.snapshot(), previous);
  });
  test(`${kind}: a receipt racing with closed-state validation returns the saved original`, async t => {
    const f = fixture(t, kind); await seed(f); const real = f.store(f.p.id); let reads = 0;
    const stored = receipt(f.p, 'closed-race', { status: 'persisted', run_id: 'original', claims_verified: false });
    const wrapper = { getReceipt: async (...args) => ++reads === 1 ? undefined : real.getReceipt(...args), commit: (...args) => real.commit(...args) };
    const result = await commitWithReceipt(wrapper, f.p.id, stored.key, stored.hash, async () => {
      const c = start(f); c.receipt = stored; await real.commit(c); throw Error('run closed after initial receipt read');
    });
    assert.deepEqual(result, stored.result);
  });
  test(`${kind}: record-only changes cannot use a stored run from a different repository or environment`, async t => {
    const f = fixture(t, kind); await seed(f); const s = f.store(f.p.id), begin = start(f); await s.commit(begin);
    for (const extra of [{ repository: 'mobile' }, { environment: 'production' }]) {
      const c = change(f, begin.run); delete c.run; Object.assign(c.record, extra);
      const before = f.snapshot(); assert.equal(await s.commit(c), 'conflict'); assert.equal(f.snapshot(), before);
    }
    const valid = change(f, begin.run); delete valid.run; assert.equal(await s.commit(valid), 'committed');
  });
  test(`${kind}: corrections cannot change topic or replace a newer observation`, async t => {
    const f = fixture(t, kind); await seed(f); const s = f.store(f.p.id), begin = start(f); await s.commit(begin);
    const original = change(f, begin.run); await s.commit(original);
    for (const extra of [{ topic: 'different' }, { observed_at: '2026-10-23T00:00:00.000Z' }]) {
      const c = change(f, begin.run); Object.assign(c.record, { supersedes: original.record.id }, extra);
      const before = f.snapshot(); assert.equal(await s.commit(c), 'conflict'); assert.equal(f.snapshot(), before);
    }
  });
  test(`${kind}: same-key concurrent different inputs never share a successful receipt`, async t => {
    const f = fixture(t, kind); await seed(f);
    const attempt = input => commitWithReceipt(f.store(f.p.id), f.p.id, 'competing-input', hash(input), async () => {
      const c = start(f); return { project: c.project, expected_revision: c.expected_revision, run: c.run, result: { run_id: c.run.id, claims_verified: false } };
    });
    const results = await Promise.allSettled([attempt('A'), attempt('B')]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'idempotency_conflict');
    assert.equal(f.project().revision, 1); assert.equal(f.db.prepare('SELECT count(*) AS n FROM runs').get().n, 1);
  });
  test(`${kind}: different request keys rebuild after a revision race and preserve both literal bodies`, async t => {
    const f = fixture(t, kind); await seed(f); const begin = start(f); await f.store(f.p.id).commit(begin);
    const bodies = ["원문 '); DROP TABLE records; -- 🧩", '두 번째 기록'];
    const attempt = (body, index) => commitWithReceipt(f.store(f.p.id), f.p.id, 'append-'+index, hash(body), async () => {
      const c = change(f, begin.run); c.record.body = body;
      return { project: c.project, expected_revision: c.expected_revision, run: c.run, record: c.record, result: { record_id: c.record.id, claims_verified: false } };
    });
    const results = await Promise.all(bodies.map(attempt));
    assert.equal(f.project().revision, 3);
    assert.deepEqual(f.db.prepare('SELECT body FROM records ORDER BY seq').all().map(r => r.body).sort(), [...bodies].sort());
    assert.equal(new Set(results.map(r => r.record_id)).size, 2);
    assert.ok(results.every(r => r.claims_verified === false));
  });
}

test('D1 shape: unsupported metadata, wrong binding and UTF-8 byte limits fail before any database call', async t => {
  const f = fixture(t, 'd1-shape'); await seed(f); const s = f.store(f.p.id), base = start(f), calls = f.binding.constraints.length;
  for (const extra of [{ work: {} }, { reports: [] }, { skill_usage: [] }, { decision: {} }, { unrecognized: true }]) {
    await assert.rejects(s.commit({ ...base, ...extra }), { code: 'unsupported_capability' });
  }
  await assert.rejects(s.getReceipt(randomUUID(), 'x'), { code: 'scope_mismatch' });
  await assert.rejects(s.commit({ ...base, run: { ...base.run, goal: '🧩'.repeat(17000) } }), { code: 'resource_limit' });
  await assert.rejects(s.commit({ ...base, receipt: { ...base.receipt, result: { output: '🧩'.repeat(4200) } } }), { code: 'resource_limit' });
  assert.equal(f.binding.constraints.length, calls);
});

test('D1 shape: each batch failure position rolls back revision, run, record, FTS and receipt', async t => {
  const f = fixture(t, 'd1-shape'); await seed(f); const s = f.store(f.p.id), begin = start(f); await s.commit(begin);
  const c = change(f, { ...begin.run, state: 'completed' }), before = f.snapshot();
  // project + guard/delete + run + guard/delete + actor + record + guard/delete + receipt.
  for (let i = 0; i < 11; i++) {
    f.binding.failAfter = i; await assert.rejects(s.commit(c), { code: 'persistence_unknown' });
    assert.equal(f.snapshot(), before); assert.equal(f.db.prepare('SELECT count(*) AS n FROM skilly_write_assertions').get().n, 0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM record_search WHERE record_search MATCH '기록'").get().n, 0);
  }
});

test('D1 shape: direct commit reports confirmed persistence after losing only the response', async t => {
  const f = fixture(t, 'd1-shape'); await seed(f); const s = f.store(f.p.id), c = start(f); f.binding.loseResponse = true;
  assert.equal(await s.commit(c), 'committed');
  assert.equal(f.project().revision, 1); assert.deepEqual(await s.getReceipt(f.p.id, c.receipt.key), c.receipt);
});

test('D1 shape: response lost after commit is recovered from the original receipt without duplicate writes', async t => {
  const f = fixture(t, 'd1-shape'); await seed(f); const s = f.store(f.p.id); f.binding.loseResponse = true;
  const first = await commitWithReceipt(s, f.p.id, 'lost', hash('input'), async () => {
    const c = start(f); return { project: c.project, expected_revision: c.expected_revision, run: c.run, result: { run_id: c.run.id, claims_verified: false } };
  });
  assert.equal(f.project().revision, 1); assert.equal(f.db.prepare('SELECT count(*) AS n FROM runs').get().n, 1);
  assert.deepEqual((await s.getReceipt(f.p.id, 'lost')).result, first);
});

test('D1 shape: malformed post-commit response is unknown until the same receipt is rechecked', async t => {
  const f = fixture(t, 'd1-shape'); await seed(f); const s = f.store(f.p.id), c = start(f); f.binding.malformedResponse = true;
  await assert.rejects(s.commit(c), { code: 'persistence_unknown', retryable: true });
  assert.equal(f.project().revision, 1); assert.deepEqual(await s.getReceipt(f.p.id, c.receipt.key), c.receipt);
});

test('D1 shape: failures during correction keep the old source and search index intact', async t => {
  const f = fixture(t, 'd1-shape'); await seed(f); const s = f.store(f.p.id), begin = start(f); await s.commit(begin);
  const original = change(f, begin.run); await s.commit(original);
  const c = change(f, begin.run); c.record.supersedes = original.record.id;
  const before = f.snapshot();
  for (const position of [10, 11, 12, 13]) {
    f.binding.failAfter = position; await assert.rejects(s.commit(c), { code: 'persistence_unknown' });
    assert.equal(f.snapshot(), before);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM record_search WHERE record_search MATCH '기록'").get().n, 1);
  }
});

test('D1 shape: a lost response plus failed receipt read stays unknown until reconnection', async t => {
  const f = fixture(t, 'd1-shape'); await seed(f); const s = f.store(f.p.id), c = start(f);
  f.binding.loseResponse = true; f.binding.failReads = true;
  await assert.rejects(s.commit(c), { code: 'persistence_unknown', retryable: true });
  f.binding.failReads = false;
  assert.deepEqual(await s.getReceipt(f.p.id, c.receipt.key), c.receipt);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM runs').get().n, 1);
});
