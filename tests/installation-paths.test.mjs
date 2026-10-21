import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, readFileSync, writeFileSync, renameSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { setupCodex } from '../scripts/setup-codex.mjs';
import { diagnoseLocal } from '../scripts/doctor.mjs';
import { installationRelativePath, readInstallation, diagnoseExecutionAccess } from '../scripts/local-installation.mjs';

const identity = { key: 'installation-cycle', name: 'Installation cycle', repository: 'web', environment: 'test' };
function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'skilly-path-access-')));
  const root = join(base, 'project'); mkdirSync(root); mkdirSync(join(base, 'data'));
  const db = join(base, 'data', 'memory.sqlite');
  setupCodex({ project: root, db, identity });
  return { base, root, db };
}
async function connect(t, config) {
  // This file was generated in this test, never a user's private config.
  const candidate = readFileSync(config, 'utf8');
  const command = JSON.parse(candidate.match(/^command = (.*)$/m)[1]);
  const args = JSON.parse(candidate.match(/^args = (.*)$/m)[1]);
  const cwd = JSON.parse(candidate.match(/^cwd = (.*)$/m)[1]);
  const transport = new StdioClientTransport({ command, args, cwd, stderr: 'pipe' });
  transport.stderr.resume();
  const client = new Client({ name: 'installation-path-cycle', version: '1' });
  t.after(() => client.close()); await client.connect(transport);
  const call = async (name, input) => {
    const result = await client.callTool({ name, arguments: input });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  call.close = () => client.close();
  return call;
}
const configAt = root => join(root, '.codex/config.toml');
function execute(paths, run, record, marker, sandbox = false) {
  const args = [paths.runtime, 'exec', '--db', paths.db, '--project', paths.project, '--run-id', run,
    ...(record ? ['--record-id', record] : []), '--', process.execPath, '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`];
  return spawnSync(sandbox ? '/usr/bin/sandbox-exec' : paths.node,
    sandbox ? ['-p', `(version 1)(allow default)(deny network*)(deny file-write* (subpath ${JSON.stringify(join(paths.db, '..'))}))`, paths.node, ...args] : args,
    { encoding: 'utf8', timeout: 15000 });
}

test('new installation supplies explicit execution paths without initializing DB or granting host permissions', async () => {
  const f = fixture(), paths = readInstallation(join(f.root, installationRelativePath));
  assert.equal(paths.project, f.root); assert.equal(paths.db, f.db); assert.equal(paths.node, process.execPath);
  assert.ok(existsSync(paths.runtime)); assert.equal(existsSync(f.db), false);
  const report = await diagnoseLocal({ project: f.root, db: f.db });
  assert.equal(report.installation.status, 'paths_match'); assert.equal(report.execution_access.status, 'appears_writable');
  assert.equal(report.execution_access.write_verified, false); assert.equal(report.execution_access.host_sandbox, 'not_checked');
  assert.equal(report.connection_status, 'not_checked'); assert.equal(existsSync(f.db), false);
});

test('moved checkout is detected; separate candidate preserves old settings and reconnects to original records and executions', async t => {
  const f = fixture(), first = await connect(t, configAt(f.root));
  const pid = (await first('memory_resolve_project', {})).project.id;
  const run = (await first('memory_begin_task', { project_id: pid, mode: 'change', goal: '이동 검증용 작업', idempotency_key: 'start' })).run.id;
  const record = (await first('memory_checkpoint', { project_id: pid, run_id: run, topic: 'path-cycle', kind: 'note', body: '이동 전 원문', idempotency_key: 'note' })).record_id;
  const moved = join(f.base, 'moved project'); renameSync(f.root, moved);
  const oldConfig = readFileSync(configAt(moved)), oldSkill = readFileSync(join(moved, '.agents/skills/use-skilly/SKILL.md'));
  const oldMetadata = readFileSync(join(moved, installationRelativePath));
  const before = await diagnoseLocal({ project: moved, db: f.db });
  assert.equal(before.installation.status, 'path_mismatch'); assert.deepEqual(before.installation.mismatched_fields, ['project']);
  assert.throws(() => setupCodex({ project: moved, db: f.db }), /Destination exists/);
  const output = join(f.base, 'connection candidate');
  const created = setupCodex({ project: moved, db: f.db, output });
  assert.equal(created.status, 'candidate_created'); assert.equal(created.candidate_applied, false);
  const metadata = join(output, installationRelativePath);
  assert.equal((await diagnoseLocal({ project: moved, db: f.db, installation: metadata })).installation.status, 'paths_match');
  assert.deepEqual(readFileSync(configAt(moved)), oldConfig); assert.deepEqual(readFileSync(join(moved, installationRelativePath)), oldMetadata);
  assert.deepEqual(readFileSync(join(moved, '.agents/skills/use-skilly/SKILL.md')), oldSkill);
  assert.throws(() => setupCodex({ project: moved, db: f.db, output }), /already exists/);
  const call = await connect(t, configAt(output)); assert.equal((await call('memory_resolve_project', {})).project.id, pid);
  assert.equal((await call('memory_get_evidence', { project_id: pid, record_id: record })).record.body, '이동 전 원문');
  const paths = readInstallation(metadata), marker = join(moved, 'check-once');
  const result = execute(paths, run, record, marker); assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout); assert.equal(receipt.status, 'persisted'); assert.equal(receipt.claims_verified, false);
  await call('memory_finish_task', { project_id: pid, run_id: run, outcome: 'completed', summary: '연결 후보를 통한 검사 정상 종료', idempotency_key: 'end' });
  const fresh = await connect(t, configAt(output));
  const rows = (await fresh('memory_list_executions', { project_id: pid, run_id: run })).items;
  assert.equal(rows.length, 1); assert.equal(rows[0].id, receipt.execution_id); assert.equal(rows[0].exit_code, 0);
  const evidence = await fresh('memory_get_evidence', { project_id: pid, record_id: record });
  assert.equal(evidence.record.body, '이동 전 원문'); assert.equal(evidence.verified, false);
  assert.equal(evidence.executions.items[0].id, receipt.execution_id);
});

test('an offline DB directory move reconnects through an explicit candidate without rewriting reports', async t => {
  const f = fixture(), call = await connect(t, configAt(f.root));
  const pid = (await call('memory_resolve_project', {})).project.id;
  const run = (await call('memory_begin_task', { project_id: pid, mode: 'answer', goal: 'DB 이동 전 원문 보존', idempotency_key: 'start' })).run.id;
  const saved = await call('memory_finish_task', { project_id: pid, run_id: run, outcome: 'completed', summary: '이동 전 원문 보존', idempotency_key: 'end' });
  await call.close();
  const destination = join(f.base, 'moved data'); renameSync(join(f.base, 'data'), destination);
  const db = join(destination, 'memory.sqlite'), configBefore = readFileSync(configAt(f.root));
  const report = await diagnoseLocal({ project: f.root, db });
  assert.equal(report.installation.status, 'path_mismatch'); assert.deepEqual(report.installation.mismatched_fields, ['db']);
  const output = join(f.base, 'db move candidate'); setupCodex({ project: f.root, db, output });
  const fresh = await connect(t, configAt(output)); assert.equal((await fresh('memory_resolve_project', {})).project.id, pid);
  const evidence = await fresh('memory_get_evidence', { project_id: pid, record_id: saved.record_id });
  assert.equal(evidence.record.body, '이동 전 원문 보존'); assert.equal(evidence.verified, false);
  assert.deepEqual(readFileSync(configAt(f.root)), configBefore);
  assert.equal(existsSync(f.db), false);
});

test('missing runtime, malformed metadata and unsafe access paths are distinct from connectivity', async t => {
  const f = fixture(), call = await connect(t, configAt(f.root));
  await call('memory_resolve_project', {});
  const metadata = join(f.root, installationRelativePath), paths = readInstallation(metadata);
  const mismatch = await diagnoseLocal({ project: f.root, db: join(f.base, 'data', 'other.sqlite') });
  assert.ok(mismatch.installation.mismatched_fields.includes('db')); assert.equal(mismatch.connection_status, 'not_checked');
  writeFileSync(metadata, JSON.stringify({ ...paths, runtime: join(f.base, 'missing-main.js') }));
  assert.equal((await diagnoseLocal({ project: f.root, db: f.db })).installation.runtime_available, false);
  writeFileSync(metadata, JSON.stringify({ ...paths, command: 'not allowed' }));
  assert.equal((await diagnoseLocal({ project: f.root, db: f.db })).installation.status, 'invalid');
  writeFileSync(metadata, 'x'.repeat(17000)); assert.throws(() => readInstallation(metadata));
  const link = join(f.base, 'linked.sqlite'); symlinkSync(f.db, link);
  assert.equal(diagnoseExecutionAccess(link).status, 'unsafe_or_unavailable');
  assert.equal(diagnoseExecutionAccess(join(f.base, 'missing', 'db.sqlite')).status, 'parent_missing');
  const linkedMetadata = join(f.base, 'linked-installation.json'); symlinkSync(metadata, linkedMetadata);
  assert.throws(() => readInstallation(linkedMetadata));
});

test('host DB write denial never runs the check, while a permitted execution records exactly one result', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(), call = await connect(t, configAt(f.root));
  const pid = (await call('memory_resolve_project', {})).project.id;
  const run = (await call('memory_begin_task', { project_id: pid, mode: 'change', goal: '접근 경계 검사', idempotency_key: 'start' })).run.id;
  const paths = readInstallation(join(f.root, installationRelativePath)), marker = join(f.root, 'must-run-only-once');
  const original = readFileSync(f.db);
  const preflight = spawnSync('/usr/bin/sandbox-exec', ['-p',
    `(version 1)(allow default)(deny network*)(deny file-write* (subpath ${JSON.stringify(join(f.db, '..'))}))`,
    process.execPath, new URL('../scripts/doctor.mjs', import.meta.url).pathname, '--project', f.root, '--db', f.db],
    { encoding: 'utf8', timeout: 15000 });
  const diagnosis = JSON.parse(preflight.stdout);
  assert.equal(diagnosis.execution_access.write_verified, false);
  assert.equal(diagnosis.execution_access.host_sandbox, 'not_checked');
  assert.equal(diagnosis.connection_status, 'not_checked');
  const denied = execute(paths, run, undefined, marker, true);
  assert.equal(denied.status, 1, denied.stderr); assert.equal(existsSync(marker), false);
  assert.deepEqual(readFileSync(f.db), original);
  assert.equal((await call('memory_list_executions', { project_id: pid, run_id: run })).items.length, 0);
  const result = execute(paths, run, undefined, marker);
  assert.equal(result.status, 0, result.stderr); assert.equal(readFileSync(marker, 'utf8'), 'executed');
  assert.equal((await call('memory_list_executions', { project_id: pid, run_id: run })).items.length, 1);
});
