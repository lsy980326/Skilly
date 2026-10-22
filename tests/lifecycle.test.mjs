import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, renameSync, writeFileSync, existsSync, mkdirSync, symlinkSync, chmodSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { recordLifecycle, readLifecycle } from '../dist/adapters/storage/sqlite/lifecycle.js';
import { openLocal } from '../dist/runtime/local/app.js';
import { setupCodexHooks } from '../scripts/setup-codex-hooks.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const binding = { version: 1, key: 'lifecycle-test', name: 'Lifecycle test', repository: 'web', environment: 'development' };
const main = new URL('../dist/runtime/local/main.js', import.meta.url).pathname;
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'skilly-lifecycle-'));
  writeFileSync(join(root, 'skilly.project.json'), JSON.stringify(binding));
  return { root, db: join(root, 'test.sqlite'), event: { cwd: root, session_id: 'test-session', turn_id: 'test-turn', hook_event_name: 'SessionStart', source: 'startup' } };
}
test('allowlisted hook metadata survives reconnect; task receipts and unobserved omissions stay separate', async () => {
  const f = fixture();
  assert.equal(readLifecycle(f.db, binding, f.root).status, 'not_observed');
  assert.equal(existsSync(`${f.db}.events.sqlite`), false);
  const app = openLocal(f.db, binding, f.root);
  const p = (await app.dispatcher.call('memory_resolve_project', {})).project.id;
  const r = (await app.dispatcher.call('memory_begin_task', { project_id: p, goal: '테스트용 작업', mode: 'change', idempotency_key: 'start' })).run.id;
  recordLifecycle(f.db, f.root, { ...f.event, transcript_path: '/private/do-not-read', prompt: 'SECRET', tool_input: { command: 'SECRET' }, last_assistant_message: 'SECRET' });
  const post = { ...f.event, hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_use_id: 'test-edit' };
  const first = recordLifecycle(f.db, f.root, post);
  assert.equal(first.observation_id, recordLifecycle(f.db, f.root, post).observation_id);
  const lock = new DatabaseSync(f.db); lock.exec('BEGIN IMMEDIATE');
  let failed;
  try { await app.dispatcher.call('memory_checkpoint', { project_id: p, run_id: r, topic: 'test', kind: 'change', body: '실패 후 복구할 테스트 기록', idempotency_key: 'change' }); }
  catch (error) { failed = error; }
  finally { lock.exec('ROLLBACK'); lock.close(); }
  assert.equal(failed.recovery.pending_retained, true);
  recordLifecycle(f.db, f.root, { ...f.event, hook_event_name: 'Interrupt' });
  await app.close();
  const next = openLocal(f.db, binding, f.root);
  try {
    const status = await next.dispatcher.call('memory_recovery_status', { project_id: p });
    assert.equal(status.requests[0].delivery_status, 'recovery_pending');
    assert.equal(status.lifecycle_observations.items.length, 3);
    assert.equal(status.lifecycle_observations.items[0].event, 'Interrupt');
    assert.equal(status.lifecycle_observations.work_record_linkage, 'not_observed');
    assert.equal(status.unfinished_runs[0].state, 'active');
    assert.equal(status.recording_coverage.missing_record_count, null);
    const saved = await next.dispatcher.call('memory_retry_write', { project_id: p, request_id: failed.recovery.request_id });
    assert.equal(saved.status, 'persisted');
    assert.equal((await next.dispatcher.call('memory_retry_write', { project_id: p, request_id: failed.recovery.request_id })).record_id, saved.record_id);
    recordLifecycle(f.db, f.root, { ...f.event, hook_event_name: 'SessionStart', source: 'resume' });
    recordLifecycle(f.db, f.root, { ...f.event, hook_event_name: 'Stop' });
    assert.equal((await next.dispatcher.call('memory_get_status', { project_id: p, run_id: r })).run.state, 'active');
    await next.dispatcher.call('memory_finish_task', { project_id: p, run_id: r, summary: '테스트 종료. 내용은 AI 보고.', outcome: 'completed', idempotency_key: 'finish' });
    const statusAfter = await next.dispatcher.call('memory_recovery_status', { project_id: p, request_id: failed.recovery.request_id });
    assert.equal(statusAfter.requests[0].delivery_status, 'saved');
    assert.equal(statusAfter.lifecycle_observations.claims_verified, false);
    const wrong = readLifecycle(f.db, { ...binding, repository: 'api' }, f.root);
    assert.equal(wrong.items.length, 0);
    const raw = readFileSync(`${f.db}.events.sqlite`);
    assert.equal(raw.includes(Buffer.from('SECRET')), false);
    assert.equal(raw.includes(Buffer.from('/private/do-not-read')), false);
  } finally { await next.close(); }
});

test('invalid, locked and unavailable event stores never become queued work records', () => {
  const f = fixture();
  assert.throws(() => recordLifecycle(f.db, f.root, { ...f.event, hook_event_name: 'Unknown' }));
  assert.equal(existsSync(`${f.db}.events.sqlite`), false);
  assert.throws(() => recordLifecycle(f.db, f.root, { ...f.event, cwd: dirnameFixture() }), error => error.code === 'scope_mismatch');
  recordLifecycle(f.db, f.root, f.event);
  const lock = new DatabaseSync(`${f.db}.events.sqlite`); lock.exec('BEGIN IMMEDIATE');
  try { assert.throws(() => recordLifecycle(f.db, f.root, { ...f.event, hook_event_name: 'Interrupt' })); }
  finally { lock.exec('ROLLBACK'); lock.close(); }
  assert.equal(readLifecycle(f.db, binding, f.root).items.length, 1);
  const bad = fixture(); writeFileSync(`${bad.db}.events.sqlite`, 'not a database');
  assert.equal(readLifecycle(bad.db, binding, bad.root).status, 'unavailable');
  assert.throws(() => recordLifecycle(bad.db, bad.root, bad.event));
  assert.equal(readFileSync(`${bad.db}.events.sqlite`, 'utf8'), 'not a database');
  const link = fixture(); symlinkSync(`${f.db}.events.sqlite`, `${link.db}.events.sqlite`);
  assert.throws(() => recordLifecycle(link.db, link.root, link.event));
  if (process.getuid?.() !== 0) {
    const denied = fixture(); recordLifecycle(denied.db, denied.root, denied.event);
    chmodSync(denied.root, 0);
    try { assert.equal(readLifecycle(denied.db, binding, denied.root).status, 'unavailable'); }
    finally { chmodSync(denied.root, 0o700); }
  }
});
function dirnameFixture() { return mkdtempSync(join(tmpdir(), 'skilly-other-scope-')); }

test('event capacity refuses additional writes without deletion or false retention', () => {
  const f = fixture(); recordLifecycle(f.db, f.root, f.event);
  const db = new DatabaseSync(`${f.db}.events.sqlite`);
  try { db.exec(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<9999)
    INSERT INTO events SELECT NULL, 'fixture-'||x, project_key, repository, environment, root_hash, session_hash, turn_hash, event, source, tool_group, received_at FROM n CROSS JOIN events WHERE seq=1;`); }
  finally { db.close(); }
  assert.throws(() => recordLifecycle(f.db, f.root, f.event), error => error.code === 'event_store_full');
});

test('hook CLI emits valid reminders, respects disabled collection and bounds input', () => {
  const f = fixture();
  const invoke = (event, extra = {}) => spawnSync(process.execPath, [main, 'codex-hook', '--project', f.root, '--db', f.db], { input: JSON.stringify(event), encoding: 'utf8', ...extra });
  assert.equal(JSON.parse(invoke(f.event).stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  const stopped = invoke({ ...f.event, hook_event_name: 'Stop' });
  assert.equal(stopped.status, 0); assert.equal(JSON.parse(stopped.stdout).decision, undefined);
  const count = readLifecycle(f.db, binding, f.root).items.length;
  const disabled = invoke({ ...f.event, hook_event_name: 'Interrupt' }, { env: { ...process.env, SKILLY_RECORDING: 'off' } });
  assert.equal(disabled.status, 0);
  assert.equal(readLifecycle(f.db, binding, f.root).items.length, count);
  assert.equal(invoke({ ...f.event, prompt: 'x'.repeat(140000) }).status, 1);
});

test('fresh candidate and relocation preserve settings, reject old cwd, and do not claim host loading', () => {
  const f = fixture(), output = join(f.root, 'candidate');
  mkdirSync(join(f.root, '.codex')); writeFileSync(join(f.root, '.codex/config.toml'), 'existing-settings');
  const candidate = setupCodexHooks({ project: f.root, db: f.db, output });
  assert.equal(candidate.candidate_applied, false); assert.equal(candidate.hook_loading_verified, false);
  assert.equal(candidate.existing_project_settings_changed, false);
  assert.equal(readFileSync(join(f.root, '.codex/config.toml'), 'utf8'), 'existing-settings');
  const hooks = JSON.parse(readFileSync(candidate.path, 'utf8')).hooks;
  assert.equal(hooks.Interrupt[0].hooks[0].timeout, 3);
  assert.match(hooks.SessionStart[0].hooks[0].command, /codex-hook/);
  assert.throws(() => setupCodexHooks({ project: f.root, db: f.db, output }));
  recordLifecycle(f.db, f.root, f.event);
  const moved = f.root + '-moved', oldDb = f.db;
  renameSync(f.root, moved);
  assert.throws(() => recordLifecycle(oldDb, f.root, { ...f.event, cwd: moved }));
  const movedDb = join(moved, 'test.sqlite');
  assert.equal(readLifecycle(movedDb, binding, moved).status, 'not_observed');
  const fresh = setupCodexHooks({ project: moved, db: movedDb, output: join(moved, 'candidate-moved') });
  assert.equal(fresh.hook_loading_verified, false);
  recordLifecycle(movedDb, moved, { ...f.event, cwd: moved });
  assert.equal(readLifecycle(movedDb, binding, moved).items.length, 1);
  assert.equal(readFileSync(join(moved, '.codex/config.toml'), 'utf8'), 'existing-settings');
});

test('existing repository and isolated DB survive actual stdio server interruption and new MCP retrieval', { timeout: 20000 }, async () => {
  const f = fixture(), root = process.cwd();
  const clients = [];
  const connect = async () => {
    const client = new Client({ name: 'skilly-local-lifecycle-cycle', version: '1' });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [main, 'serve', '--project', root, '--db', f.db], stderr: 'pipe' });
    transport.stderr?.resume(); clients.push(client); await client.connect(transport);
    return { client, transport };
  };
  const call = async (c, name, args) => {
    const result = await c.client.callTool({ name, arguments: args });
    return { ...JSON.parse(result.content[0].text), isError: Boolean(result.isError) };
  };
  try {
    let c = await connect();
    const p = (await call(c, 'memory_resolve_project', {})).project.id;
    const started = await call(c, 'memory_begin_task', { project_id: p, goal: '이벤트 검증용 테스트 작업', mode: 'change', idempotency_key: 'stdio-start' });
    assert.equal(started.status, 'persisted');
    const r = started.run.id;
    const event = { cwd: root, session_id: 'fixture-not-real-codex-session', turn_id: 'fixture-turn', hook_event_name: 'SessionStart', source: 'startup' };
    recordLifecycle(f.db, root, event);
    const lock = new DatabaseSync(f.db); lock.exec('BEGIN IMMEDIATE');
    let failure;
    try { failure = await call(c, 'memory_checkpoint', { project_id: p, run_id: r, kind: 'change', topic: 'test', body: '테스트용 변경 기록', idempotency_key: 'stdio-change' }); }
    finally { lock.exec('ROLLBACK'); lock.close(); }
    assert.equal(failure.recovery.pending_retained, true);
    recordLifecycle(f.db, root, { ...event, hook_event_name: 'Interrupt' });
    process.kill(c.transport.pid, 'SIGKILL'); await c.client.close();
    c = await connect();
    const status = await call(c, 'memory_recovery_status', { project_id: p });
    assert.equal(status.lifecycle_observations.items[0].event, 'Interrupt');
    assert.equal(status.requests[0].delivery_status, 'recovery_pending');
    assert.equal(status.recording_coverage.completeness, 'unknown');
    assert.equal(status.recording_coverage.missing_record_count, null);
    const saved = await call(c, 'memory_retry_write', { project_id: p, request_id: failure.recovery.request_id });
    assert.equal(saved.status, 'persisted');
    const finished = await call(c, 'memory_finish_task', { project_id: p, run_id: r, summary: '테스트용 작업 종료. 실제 Codex 훅 로딩은 미검증.', outcome: 'completed', idempotency_key: 'stdio-finish' });
    assert.equal(finished.status, 'persisted');
    await c.client.close(); c = await connect();
    const recall = await call(c, 'memory_query_context', { project_id: p, topic: 'task-summary' });
    assert.equal(recall.records[0].id, finished.record_id);
    assert.equal((await call(c, 'memory_get_evidence', { project_id: p, record_id: saved.record_id })).verified, false);
    const absent = await call(c, 'memory_recovery_status', { project_id: p, request_id: 'f'.repeat(64) });
    assert.equal(absent.error.code, 'not_found');
    assert.equal((await call(c, 'memory_get_status', { project_id: p, run_id: r })).run.state, 'completed');
  } finally { for (const client of clients) await client.close(); }
});
