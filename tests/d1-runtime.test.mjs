import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Miniflare } from 'miniflare';
import workerd, { version as workerdVersion } from 'workerd';
import { D1AtomicCommitStore } from '../dist/adapters/storage/d1/atomic-store.js';
import { commitWithReceipt } from '../dist/core/memory/atomic-commit.js';

const now = '2026-10-24T00:00:00.000Z';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const receipt = (p, key, result = { status: 'persisted', claims_verified: false }) => ({ scope: p.id, key, hash: hash(key), result });

// Applies only the checked-in schema: split BETWEEN its CREATE statements, never inside trigger bodies.
// Not a public migration parser or an import path for user-supplied SQL.
const schemaStatements = () => readFileSync(new URL('../migrations/d1/001-atomic-memory.sql', import.meta.url), 'utf8')
  .replace(/^--[^\n]*$/gm, '').trim().split(/;\s*(?=CREATE\s|$)/i).filter(Boolean);

function faultBinding(db, control) {
  return { withSession(constraint) {
    control.sessions = (control.sessions ?? 0) + 1;
    const session = db.withSession(constraint);
    return {
      prepare(sql) {
        if (control.failReads && sql.startsWith('SELECT payload_hash')) {
          return { bind() { return this; }, async all() { throw Error('injected receipt transport failure'); } };
        }
        return session.prepare(sql);
      },
      async batch(statements) {
        control.statements = statements.length;
        const submitted = [...statements];
        if (control.failBefore !== undefined) submitted.splice(control.failBefore, 0, session.prepare('INSERT INTO runtime_fault VALUES (0)'));
        const result = await session.batch(submitted);
        if (control.loseResponse) { control.loseResponse = false; throw Error('injected response loss AFTER real commit'); }
        if (control.malformedResponse) return [];
        return result;
      },
    };
  } };
}

test('Miniflare/workerd local D1 storage contract', { timeout: 90000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'skilly-real-d1-'));
  const options = {
    modules: true,
    scriptPath: fileURLToPath(new URL('./support/d1-runtime-worker.mjs', import.meta.url)),
    modulesRoot: fileURLToPath(new URL('../', import.meta.url)),
    modulesRules: [{ type: 'ESModule', include: ['**/*.js'], fallthrough: true }],
    compatibilityDate: '2026-07-30',
    d1Databases: { DB: randomUUID() }, d1Persist: join(directory, 'd1'),
    host: '127.0.0.1', port: 0,
    outboundService: () => new Response('external fetch disabled in local D1 tests', { status: 403 }),
  };
  let mf = new Miniflare(options), db = await mf.getD1Database('DB');
  t.after(() => mf.dispose());
  await db.batch(schemaStatements().map(sql => db.prepare(sql)));
  await db.prepare('CREATE TABLE runtime_fault (ok INTEGER NOT NULL CHECK(ok=1)) STRICT').run();
  const one = async (sql, ...values) => (await db.prepare(sql).bind(...values).all()).results[0];
  const snapshot = async p => JSON.stringify(await Promise.all([
    ...[['projects', 'id'], ['runs', 'project_id'], ['records', 'project_id'], ['receipts', 'scope']]
      .map(async ([table, column]) => (await db.prepare(`SELECT * FROM ${table} WHERE ${column}=? ORDER BY 1`).bind(p.id).all()).results),
    db.prepare('SELECT a.* FROM run_actors a JOIN runs r ON r.id=a.run_id WHERE r.project_id=? ORDER BY a.run_id').bind(p.id).all().then(r => r.results),
    // Read the actual FTS index, not its external-content records view. Subtests run sequentially.
    db.prepare("SELECT rowid FROM record_search WHERE record_search MATCH '기록' ORDER BY rowid").all().then(r => r.results),
  ]));
  const fixture = async () => {
    const p = { id: randomUUID(), key: randomUUID(), name: '실제 로컬 D1 합성 과제', revision: 0, created_at: now };
    const store = new D1AtomicCommitStore(db, p.id);
    assert.equal(await store.commit({ project: p, expected_revision: null, receipt: receipt(p, 'create') }), 'committed');
    const begin = { project: { ...p, revision: 1 }, expected_revision: 0,
      run: { id: randomUUID(), project_id: p.id, goal: '테스트 전용 작업', mode: 'change', repository: 'api', environment: 'test', state: 'active', created_at: now, updated_at: now, actor: 'Codex' },
      receipt: receipt(p, 'begin') };
    return { p, store, begin };
  };
  const change = async (f, extra = {}) => {
    const p = { ...f.p, revision: (await one('SELECT revision FROM projects WHERE id=?', f.p.id)).revision };
    return { project: { ...p, revision: p.revision + 1 }, expected_revision: p.revision, run: f.begin.run,
      record: { id: randomUUID(), project_id: p.id, run_id: f.begin.run.id, topic: '실제D1계약', kind: 'change', body: '원문 기록 🧩', repository: 'api', environment: 'test', source_fingerprint: null, observed_at: now, recorded_at: now, supersedes: null, superseded_by: null, report_origin: 'contemporaneous' },
      receipt: receipt(p, randomUUID()), ...extra };
  };
  const worker = async input => {
    const response = await mf.dispatchFetch('http://skilly-test.invalid/', { method: 'POST', body: JSON.stringify(input) });
    const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data;
  };

  await t.test('pinned native workerd and the complete STRICT/FK/CHECK/FTS schema run locally', async () => {
    assert.equal(workerdVersion, '1.20260730.1');
    assert.match(execFileSync(workerd.default, ['--version'], { encoding: 'utf8' }), /2026-07-30/);
    await assert.rejects(db.prepare('INSERT INTO projects VALUES (?,?,?,?,?)').bind(randomUUID(), randomUUID(), 'strict', 'not-an-integer', now).run());
    await assert.rejects(db.prepare('INSERT INTO run_actors VALUES (?,?)').bind(randomUUID(), 'unowned').run());
    await assert.rejects(db.prepare('INSERT INTO skilly_write_assertions VALUES (1,0)').run(), /skilly_atomic_change/);
    assert.equal((await one('SELECT count(*) AS n FROM skilly_write_assertions')).n, 0);
  });

  await t.test('actual Worker imports production ESM and saves start, change and finish through env.DB', async () => {
    const f = await fixture();
    assert.equal((await worker({ operation: 'commit', project_id: f.p.id, mutation: f.begin })).status, 'committed');
    const note = await change(f); assert.equal((await worker({ operation: 'commit', project_id: f.p.id, mutation: note })).status, 'committed');
    const end = await change(f, { run: { ...f.begin.run, state: 'completed' } }); end.record.kind = 'summary';
    assert.equal((await worker({ operation: 'commit', project_id: f.p.id, mutation: end })).status, 'committed');
    assert.deepEqual((await worker({ operation: 'receipt', project_id: f.p.id, key: note.receipt.key })).receipt, note.receipt);
    assert.equal((await one('SELECT state FROM runs WHERE id=?', f.begin.run.id)).state, 'completed');
    assert.equal((await one("SELECT count(*) AS n FROM record_search WHERE record_search MATCH '기록'")).n, 2);
  });
  await t.test('same request replays its receipt; another input with the same key is rejected', async () => {
    const f = await fixture(); let builds = 0;
    const build = async () => { builds++; return { project: f.begin.project, expected_revision: 0, run: f.begin.run, result: { run_id: f.begin.run.id, claims_verified: false } }; };
    const first = await commitWithReceipt(f.store, f.p.id, 'same', hash('input'), build);
    assert.deepEqual(await commitWithReceipt(f.store, f.p.id, 'same', hash('input'), build), first); assert.equal(builds, 1);
    await assert.rejects(commitWithReceipt(f.store, f.p.id, 'same', hash('changed'), build), { code: 'idempotency_conflict' });
  });
  await t.test('zero-row CAS fails inside the real batch, including the already-proposed revision case', async () => {
    const f = await fixture(); const stale = { ...f.begin, run: { ...f.begin.run, id: randomUUID() }, receipt: receipt(f.p, 'stale') };
    await f.store.commit(f.begin); const before = await snapshot(f.p);
    assert.equal(await f.store.commit(stale), 'conflict'); assert.equal(await snapshot(f.p), before);
    assert.equal((await worker({ operation: 'commit', project_id: f.p.id, mutation: stale })).status, 'conflict');
    assert.equal(await snapshot(f.p), before);
    assert.equal(await f.store.getReceipt(f.p.id, 'stale'), undefined);
  });
  await t.test('last receipt UNIQUE collision rolls back new records even when the old hash and result match', async () => {
    const f = await fixture(); await f.store.commit(f.begin);
    const attempted = await change(f, { receipt: f.begin.receipt }), before = await snapshot(f.p);
    assert.equal(await f.store.commit(attempted), 'conflict'); assert.equal(await snapshot(f.p), before);
    assert.equal((await worker({ operation: 'commit', project_id: f.p.id, mutation: attempted })).status, 'conflict');
    assert.equal(await snapshot(f.p), before);
    assert.equal((await one('SELECT count(*) AS n FROM records WHERE project_id=?', f.p.id)).n, 0);
  });
  await t.test('concurrent same-key requests create only one run and return the same result', async () => {
    const f = await fixture();
    const attempt = () => commitWithReceipt(new D1AtomicCommitStore(db, f.p.id), f.p.id, 'concurrent', hash('same'), async () => {
      const p = await one('SELECT revision FROM projects WHERE id=?', f.p.id), run = { ...f.begin.run, id: randomUUID() };
      return { project: { ...f.p, revision: p.revision + 1 }, expected_revision: p.revision, run, result: { run_id: run.id, claims_verified: false } };
    });
    const [a, b] = await Promise.all([attempt(), attempt()]); assert.deepEqual(a, b);
    assert.equal((await one('SELECT count(*) AS n FROM runs WHERE project_id=?', f.p.id)).n, 1);
  });
  await t.test('different-key concurrent writes rebuild after CAS and preserve both original bodies', async () => {
    const f = await fixture(); await f.store.commit(f.begin);
    const attempt = body => commitWithReceipt(f.store, f.p.id, body, hash(body), async () => {
      const c = await change(f); c.record.body = body;
      return { project: c.project, expected_revision: c.expected_revision, run: c.run, record: c.record, result: { record_id: c.record.id, claims_verified: false } };
    });
    const bodies = ["기록 '); DROP TABLE records; --", '다른 기록']; await Promise.all(bodies.map(attempt));
    const rows = (await db.prepare('SELECT body FROM records WHERE project_id=?').bind(f.p.id).all()).results;
    assert.deepEqual(rows.map(r => r.body).sort(), [...bodies].sort());
  });
  await t.test('competing corrections have one winner while preserving the original source', async () => {
    const f = await fixture(); await f.store.commit(f.begin); const original = await change(f); await f.store.commit(original);
    const a = await change(f), b = await change(f); a.record.supersedes = b.record.supersedes = original.record.id;
    const results = await Promise.all([f.store.commit(a), f.store.commit(b)]); assert.deepEqual(results.sort(), ['committed', 'conflict']);
    const row = await one('SELECT body,superseded_by FROM records WHERE id=?', original.record.id);
    assert.equal(row.body, original.record.body); assert.ok([a.record.id, b.record.id].includes(row.superseded_by));
  });
  await t.test('foreign run IDs and record-only repository/environment mismatches cannot cross scopes', async () => {
    const f = await fixture(), other = await fixture(); await f.store.commit(f.begin);
    const foreign = { ...other.begin, run: { ...f.begin.run, project_id: other.p.id } }, before = await snapshot(other.p);
    assert.equal(await other.store.commit(foreign), 'conflict'); assert.equal(await snapshot(other.p), before);
    for (const extra of [{ repository: 'web' }, { environment: 'production' }]) {
      const c = await change(f); delete c.run; Object.assign(c.record, extra);
      const previous = await snapshot(f.p); assert.equal(await f.store.commit(c), 'conflict'); assert.equal(await snapshot(f.p), previous);
    }
    await assert.rejects(f.store.getReceipt(other.p.id, 'begin'), { code: 'scope_mismatch' });
  });
  await t.test('real SQL failures at every batch boundary roll back state, receipts, FTS and guard rows', async () => {
    const f = await fixture(); await f.store.commit(f.begin); const c = await change(f, { run: { ...f.begin.run, state: 'completed' } });
    const control = {}, s = new D1AtomicCommitStore(faultBinding(db, control), f.p.id), before = await snapshot(f.p);
    for (let i = 0; i <= 11; i++) {
      control.failBefore = i; await assert.rejects(s.commit(c), { code: 'persistence_unknown' });
      assert.equal(await snapshot(f.p), before); assert.equal((await one('SELECT count(*) AS n FROM skilly_write_assertions')).n, 0);
    }
  });
  await t.test('injected loss AFTER a real commit is confirmed by the same attempt token without duplication', async () => {
    const f = await fixture(), control = { loseResponse: true }, s = new D1AtomicCommitStore(faultBinding(db, control), f.p.id);
    assert.equal(await s.commit(f.begin), 'committed');
    assert.deepEqual(await s.getReceipt(f.p.id, 'begin'), f.begin.receipt);
    assert.equal((await one('SELECT count(*) AS n FROM runs WHERE project_id=?', f.p.id)).n, 1);
  });
  await t.test('lost commit response plus blocked receipt lookup remains unknown until reconnection', async () => {
    const f = await fixture(), control = { loseResponse: true, failReads: true }, s = new D1AtomicCommitStore(faultBinding(db, control), f.p.id);
    await assert.rejects(s.commit(f.begin), { code: 'persistence_unknown', retryable: true });
    control.failReads = false; assert.deepEqual(await s.getReceipt(f.p.id, 'begin'), f.begin.receipt);
    assert.equal((await one('SELECT count(*) AS n FROM runs WHERE project_id=?', f.p.id)).n, 1);
  });
  await t.test('a malformed reply cannot claim success until the saved receipt is read again', async () => {
    const f = await fixture(), s = new D1AtomicCommitStore(faultBinding(db, { malformedResponse: true }), f.p.id);
    await assert.rejects(s.commit(f.begin), { code: 'persistence_unknown' });
    assert.deepEqual(await f.store.getReceipt(f.p.id, 'begin'), f.begin.receipt);
  });
  await t.test('unsupported fields and UTF-8 byte overflow are rejected before real SQL submission', async () => {
    const f = await fixture(), before = await snapshot(f.p), control = {};
    const s = new D1AtomicCommitStore(faultBinding(db, control), f.p.id);
    await assert.rejects(s.commit({ ...f.begin, reports: [] }), { code: 'unsupported_capability' });
    await assert.rejects(s.commit({ ...f.begin, run: { ...f.begin.run, goal: '🧩'.repeat(17000) } }), { code: 'resource_limit' });
    assert.equal(control.sessions ?? 0, 0); assert.equal(control.statements, undefined);
    assert.equal(await snapshot(f.p), before);
  });
  await t.test('disposal and a new workerd process preserve original source and receipt IDs', async () => {
    const f = await fixture(); await f.store.commit(f.begin); const note = await change(f); await f.store.commit(note);
    await mf.dispose(); mf = new Miniflare(options); db = await mf.getD1Database('DB');
    assert.deepEqual(await new D1AtomicCommitStore(db, f.p.id).getReceipt(f.p.id, note.receipt.key), note.receipt);
    assert.equal((await one('SELECT body FROM records WHERE id=?', note.record.id)).body, note.record.body);
    assert.deepEqual((await worker({ operation: 'receipt', project_id: f.p.id, key: note.receipt.key })).receipt, note.receipt);
  });
});
