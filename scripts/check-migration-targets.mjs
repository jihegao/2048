import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTarget, targets, root } from './migration-deployment-targets.mjs';

const requiredGates = [
  'original_source_keys',
  'closed_new_keys',
  'deployment_isolation',
  'active_match_and_timed_drain',
  'full_write_freeze_and_actor_quiescence',
  'login_guard_window_elapsed',
  'secure_backup_and_integrity',
  'all_table_import_and_comparison',
  'original_version_restore',
  'new_delta_preservation_rollback',
  'final_new_acceptance',
];
export function checkRelease(state, now = Date.now()) {
  assert.equal(state.old_account, targets['old-frozen'].account);
  assert.equal(state.new_account, targets['new-production'].account);
  assert.equal(state.new_database, targets['new-production'].database);
  assert.equal(state.original_version, 'b7bd3120-fc51-4c62-8fbd-34b6f1242a78');
  assert.equal(state.not_before, '2026-10-10T22:00:00+08:00');
  assert.ok(now >= Date.parse(state.not_before), 'Maintenance window has not started');
  const window = state.confirmed_maintenance_window;
  assert.equal(window?.confirmed_by_user, true, 'A later maintenance window is unconfirmed');
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  assert.ok(Number.isFinite(start) && Number.isFinite(end) && end > start);
  assert.ok(start >= Date.parse(state.not_before));
  assert.ok(now >= start && now < end, 'Confirmed maintenance window is not active');
  assert.equal(state.maintenance_started, true, 'Verified maintenance has not started');
  for (const name of requiredGates)
    assert.equal(state.gates?.[name], true, `${name} is incomplete`);
  assert.match(state.verified_worker_sha256 ?? '', /^[a-f0-9]{64}$/u);
  assert.match(state.frozen_bookmark ?? '', /^[a-f0-9-]{20,}$/u);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const name of Object.keys(targets)) checkTarget(name);
    const state = JSON.parse(
      fs.readFileSync(path.join(root, 'operations/migration-release-state.json'), 'utf8'),
    );
    if (process.argv.includes('--require-ready')) checkRelease(state);
    console.log(
      JSON.stringify({
        fixed_targets_ok: true,
        production_migration_ready: process.argv.includes('--require-ready'),
      }),
    );
  } catch {
    console.error(
      'Migration release blocked: fixed target or required online evidence is incomplete',
    );
    process.exitCode = 1;
  }
}
