import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { checkCandidate, checkRelease } from '../../scripts/check-migration-targets.mjs';

const recorded = JSON.parse(
  fs.readFileSync(
    new URL('../../operations/migration-release-state.json', import.meta.url),
    'utf8',
  ),
);
const complete = () => ({
  ...recorded,
  maintenance_started: true,
  confirmed_maintenance_window: {
    start: '2026-10-11T00:00:00+08:00',
    end: '2026-10-11T02:00:00+08:00',
    confirmed_by_user: true,
  },
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
  assert.throws(() => checkRelease({ ...complete(), confirmed_maintenance_window: null }, now));
  assert.throws(() => checkRelease(complete(), Date.parse('2026-10-11T02:00:00+08:00')));
});

test('closed candidate needs prior evidence and separate approval but can precede final acceptance', () => {
  const now = Date.parse('2026-10-11T00:00:00+08:00');
  const state = { ...complete(), closed_candidate_authorization_approved: true };
  state.gates.new_delta_preservation_rollback = false;
  state.gates.final_new_acceptance = false;
  checkCandidate(state, now);
  assert.throws(() => checkRelease(state, now));
  assert.throws(() =>
    checkCandidate({ ...state, closed_candidate_authorization_approved: false }, now),
  );
  for (const gate of Object.keys(state.gates).slice(0, -2)) {
    assert.throws(() =>
      checkCandidate({ ...state, gates: { ...state.gates, [gate]: false } }, now),
    );
  }
});
