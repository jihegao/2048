import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { checkRelease } from '../../scripts/check-migration-targets.mjs';

const recorded = JSON.parse(
  fs.readFileSync(
    new URL('../../operations/migration-release-state.json', import.meta.url),
    'utf8',
  ),
);
const complete = () => ({
  ...recorded,
  maintenance_started: true,
  gates: Object.fromEntries(Object.keys(recorded.gates).map((name) => [name, true])),
  verified_worker_sha256: 'a'.repeat(64),
  frozen_bookmark: '00000001-00000002-00000003-00000004',
});
test('preparation state cannot release production even after 22:00', () => {
  assert.throws(() => checkRelease(recorded, Date.parse('2026-10-11T00:00:00+08:00')));
});
test('every required gate and the window independently block release', () => {
  const now = Date.parse('2026-10-11T00:00:00+08:00');
  checkRelease(complete(), now);
  for (const name of Object.keys(recorded.gates)) {
    const state = complete();
    state.gates[name] = false;
    assert.throws(() => checkRelease(state, now), name);
  }
  assert.throws(() => checkRelease(complete(), Date.parse('2026-10-10T21:59:59+08:00')));
  const wrong = complete();
  wrong.new_account = recorded.old_account;
  assert.throws(() => checkRelease(wrong, now));
});
