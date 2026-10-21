import test from 'node:test';
import assert from 'node:assert/strict';
import { validationEvidence } from '../ui/reports.js';
const checks = [{ name: 'test', result: 'passed' }];
const empty = { items: [], next_offset: null };
test('a report without observations is not proof of execution or nonexecution', () => {
  const result = validationEvidence({ checks, executions: empty });
  assert.equal(result.state, 'reported'); assert.equal(result.reports, 1);
  assert.match(result.detail, /미실행을 뜻하지 않습니다/);
  assert.equal(validationEvidence({ checks: [{ result: 'not_run' }], executions: empty }).state, 'reported');
});
test('unavailable, unfinished and incomplete reads stay unknown even with a passed AI report', () => {
  for (const executions of [undefined, null, { items: [{ outcome: 'unconfirmed' }], next_offset: null }, { items: [], next_offset: 20 }]) {
    assert.equal(validationEvidence({ checks, executions }).state, 'unknown');
  }
  assert.equal(validationEvidence({ checks, executions: empty, partial: true }).state, 'unknown');
  assert.equal(validationEvidence({ executions: empty }).state, 'unknown');
});
test('observed failures count as observations; pending items and report results remain separate', () => {
  const input = { checks, executions: { items: [{ outcome: 'exited', exit_code: 7 }, { outcome: 'unconfirmed' }], next_offset: null } };
  const before = JSON.stringify(input), result = validationEvidence(input);
  assert.equal(result.state, 'observed'); assert.equal(result.observed, 1); assert.equal(result.pending, 1);
  assert.match(result.detail, /개별/); assert.equal(JSON.stringify(input), before);
  assert.equal(validationEvidence({ executions: { items: [{ outcome: 'unexpected' }] } }).state, 'unknown');
});
test('feature aggregates distinguish finished, unconfirmed, absent and invalid counts', () => {
  assert.equal(validationEvidence({ checks, aggregate: { status: 'not_collected', total: 0, unconfirmed: 0 } }).state, 'reported');
  assert.equal(validationEvidence({ checks, aggregate: { status: 'observations_available', total: 2, unconfirmed: 2 } }).state, 'unknown');
  assert.equal(validationEvidence({ checks, aggregate: { status: 'observations_available', total: 2, unconfirmed: 1 } }).state, 'observed');
  assert.equal(validationEvidence({ checks, aggregate: { status: 'observations_available', total: 1, unconfirmed: 2 } }).state, 'unknown');
});
