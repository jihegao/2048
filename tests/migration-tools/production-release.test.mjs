import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { checkRelease, requiredGates } from '../../scripts/check-migration-targets.mjs';
import { checkTarget, root, targets } from '../../scripts/migration-deployment-targets.mjs';
import {
  checkRoutineEvidence,
  checkSource,
  checkProduction,
  checkCandidate,
  uploadedVersion,
  main,
} from '../../scripts/production-release.mjs';

const state = JSON.parse(
  fs.readFileSync(
    new URL('../../operations/migration-release-state.json', import.meta.url),
    'utf8',
  ),
);
const { config } = checkTarget('new-production');
const headers = fs.readFileSync(path.join(root, 'public/_headers'), 'utf8');
const commit = 'a'.repeat(40);
const versionId = '11111111-1111-4111-8111-111111111111';
function production() {
  const bindings = [
    { name: 'DB', type: 'd1', database_id: targets['new-production'].database },
    {
      name: 'ROOMS',
      type: 'durable_object_namespace',
      namespace_id: targets['new-preparation'].roomNamespace,
      class_name: 'RoomSession',
    },
    {
      name: 'LOGIN_GUARD',
      type: 'durable_object_namespace',
      namespace_id: targets['new-preparation'].loginNamespace,
      class_name: 'LoginGuard',
    },
    { name: 'ASSETS', type: 'assets' },
    { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
    ...Object.entries(config.vars).map(([name, text]) => ({ name, type: 'plain_text', text })),
    ...[
      'BOOTSTRAP_TEACHER_NAME',
      'BOOTSTRAP_TEACHER_USERNAME',
      'BOOTSTRAP_TEACHER_PASSWORD',
      'PASSWORD_PEPPER',
      'INITIAL_STUDENT_PASSWORD',
      'PRACTICE_SIGNING_KEY',
      'IMPORT_SIGNING_KEY',
    ].map((name) => ({ name, type: 'secret_text' })),
  ];
  return {
    version: {
      id: versionId,
      resources: {
        bindings,
        script_runtime: {
          compatibility_date: config.compatibility_date,
          compatibility_flags: config.compatibility_flags,
          migration_tag: 'v1',
          usage_model: 'standard',
          assets: {
            not_found_handling: config.assets.not_found_handling,
            raw_headers: headers,
            raw_run_worker_first: config.assets.run_worker_first,
          },
        },
      },
    },
    deployment: { id: 'baseline', versions: [{ version_id: versionId, percentage: 100 }] },
    domains: [
      {
        hostname: 'mingcheng1024.cn',
        service: '2048-challenge-platform',
        enabled: true,
        previews_enabled: false,
      },
    ],
    subdomain: { enabled: false, previews_enabled: false },
    schedules: [{ cron: '* * * * *' }],
    status: { mode: 'normal', newGamesAllowed: true },
    observability: { enabled: true },
    bindings,
  };
}
function source() {
  return {
    expected: commit,
    checkout: commit,
    main: commit,
    ref: 'refs/heads/main',
    repo: 'jihegao/2048',
    runs: [
      {
        id: 1,
        head_sha: commit,
        head_branch: 'main',
        event: 'push',
        status: 'completed',
        conclusion: 'success',
      },
    ],
  };
}

test('completed cutover permits routine updates after its historical window, while migration activation stays blocked', () => {
  checkRoutineEvidence(state);
  assert.throws(() => checkRelease(state, Date.parse('2026-10-20T00:00:00Z')));
  for (const gate of requiredGates)
    assert.throws(() =>
      checkRoutineEvidence({ ...state, gates: { ...state.gates, [gate]: false } }),
    );
  for (const update of [
    { release_ready: false },
    { new_account: state.old_account },
    { new_database: 'wrong' },
    { final_production_activation: null },
    { final_production_activation: { ...state.final_production_activation, phase: 'frozen' } },
    { public_production_acceptance: { ...state.public_production_acceptance, version: versionId } },
    { public_production_acceptance: { public_production_acceptance_passed: false } },
  ])
    assert.throws(() => checkRoutineEvidence({ ...state, ...update }));
});
test('only current main with its own latest successful complete push CI can release', () => {
  assert.equal(checkSource(source()), 1);
  for (const update of [
    { expected: 'invalid' },
    { checkout: 'b'.repeat(40) },
    { main: 'b'.repeat(40) },
    { ref: 'refs/heads/feature' },
    { repo: 'other/repository' },
    { runs: [] },
  ])
    assert.throws(() => checkSource({ ...source(), ...update }));
  for (const update of [
    { event: 'pull_request' },
    { head_branch: 'feature' },
    { head_sha: 'b'.repeat(40) },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { conclusion: 'cancelled' },
  ])
    assert.throws(() => checkSource({ ...source(), runs: [{ ...source().runs[0], ...update }] }));
  assert.throws(() =>
    checkSource({
      ...source(),
      runs: [
        ...source().runs,
        { ...source().runs[0], id: 2, status: 'in_progress', conclusion: null },
      ],
    }),
  );
});
test('live closed, split, retargeted or security-modified production fails closed', () => {
  checkProduction(production(), config, headers);
  const mutations = [
    (p) => (p.status.mode = 'frozen'),
    (p) => (p.status.mode = 'drain'),
    (p) => (p.status.newGamesAllowed = false),
    (p) => (p.deployment.versions[0].percentage = 50),
    (p) => p.deployment.versions.push({ version_id: versionId, percentage: 0 }),
    (p) => (p.version.resources.bindings[0].database_id = 'other'),
    (p) => (p.version.resources.bindings[1].namespace_id = 'other'),
    (p) =>
      (p.version.resources.bindings.find((b) => b.name === 'MIGRATION_USE_D1_CONTROL').text =
        'false'),
    (p) =>
      (p.version.resources.bindings = p.version.resources.bindings.filter(
        (b) => b.name !== 'PASSWORD_PEPPER',
      )),
    (p) => (p.version.resources.script_runtime.assets.raw_headers = ''),
    (p) => (p.version.resources.script_runtime.assets.raw_run_worker_first = ['/*']),
    (p) => (p.version.resources.script_runtime.migration_tag = 'v2'),
    (p) => (p.subdomain.enabled = true),
    (p) => (p.subdomain.previews_enabled = true),
    (p) => (p.domains[0].hostname = 'other.example'),
    (p) => (p.domains[0].service = 'other-worker'),
    (p) => (p.schedules = []),
  ];
  for (const mutate of mutations) {
    const p = production();
    mutate(p);
    assert.throws(() => checkProduction(p, config, headers));
  }
});
test('candidate must preserve all bindings, vars, secrets and security settings and carry the reviewed SHA', () => {
  const baseline = production();
  const candidate = structuredClone(baseline.version);
  candidate.annotations = { 'workers/tag': commit };
  checkCandidate(candidate, baseline, commit);
  for (const mutate of [
    (p) => (p.annotations['workers/tag'] = 'b'.repeat(40)),
    (p) => p.resources.bindings.pop(),
    (p) => (p.resources.bindings[0].database_id = 'other'),
    (p) => p.resources.bindings.push({ name: 'EXTRA', type: 'plain_text', text: 'unexpected' }),
    (p) => (p.resources.script_runtime.assets.raw_headers = ''),
    (p) => (p.resources.script_runtime.compatibility_flags = []),
  ]) {
    const p = structuredClone(candidate);
    mutate(p);
    assert.throws(() => checkCandidate(p, baseline, commit));
  }
});
test('candidate ID must come from exactly one successful structured Wrangler upload record', () => {
  assert.equal(uploadedVersion([{ type: 'version-upload', version_id: versionId }]), versionId);
  for (const records of [
    [],
    [{ type: 'version-upload', version_id: null }],
    [{ type: 'version-upload', version_id: 'invalid' }],
    [
      { type: 'version-upload', version_id: versionId },
      { type: 'version-upload', version_id: versionId },
    ],
  ])
    assert.throws(() => uploadedVersion(records));
});
test('preflight and candidate checks use read-only APIs, persist only non-secret evidence and bind the deployment output to that candidate', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), '2048-release-test-'));
  const evidence = path.join(directory, 'evidence.json'),
    uploads = path.join(directory, 'upload.jsonl'),
    output = path.join(directory, 'output');
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const savedEnv = { ...process.env },
    oldFetch = globalThis.fetch;
  const p = production(),
    candidate = structuredClone(p.version);
  candidate.id = '22222222-2222-4222-8222-222222222222';
  candidate.annotations = { 'workers/tag': checkout };
  process.env.EXPECTED_COMMIT = checkout;
  process.env.GITHUB_SHA = checkout;
  process.env.GITHUB_REF = 'refs/heads/main';
  process.env.GITHUB_REPOSITORY = 'jihegao/2048';
  process.env.CLOUDFLARE_ACCOUNT_ID = targets['new-production'].account;
  process.env.CLOUDFLARE_API_TOKEN = 'synthetic-api-fixture';
  process.env.GITHUB_OUTPUT = output;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(init.method ?? 'GET', 'GET', 'Release validation must never write business data');
    const u = new URL(url);
    let value;
    if (u.hostname === 'api.github.com')
      value = u.pathname.endsWith('/commits/main')
        ? { sha: checkout }
        : { workflow_runs: [{ ...source().runs[0], head_sha: checkout }] };
    else if (u.hostname === 'mingcheng1024.cn') {
      assert.equal(init.headers?.Authorization, undefined);
      value = p.status;
    } else {
      assert.equal(u.hostname, 'api.cloudflare.com');
      assert.ok(
        u.pathname.startsWith(`/client/v4/accounts/${targets['new-production'].account}/workers/`),
      );
      if (u.pathname.endsWith('/deployments')) value = { deployments: [p.deployment] };
      else if (u.pathname.endsWith('/domains')) value = p.domains;
      else if (u.pathname.endsWith('/subdomain')) value = p.subdomain;
      else if (u.pathname.endsWith('/schedules')) value = { schedules: p.schedules };
      else if (u.pathname.endsWith('/settings'))
        value = { bindings: p.bindings, observability: p.observability };
      else if (u.pathname.endsWith(`/versions/${versionId}`)) value = p.version;
      else if (u.pathname.endsWith(`/versions/${candidate.id}`)) value = candidate;
      else assert.fail('Unexpected endpoint');
      value = { success: true, result: value };
    }
    return Response.json(value);
  };
  try {
    await main('preflight', evidence);
    assert.equal(fs.readFileSync(evidence, 'utf8').includes('synthetic-api-fixture'), false);
    fs.writeFileSync(
      uploads,
      JSON.stringify({ type: 'version-upload', version_id: candidate.id }) + '\n',
    );
    await main('candidate', evidence, uploads);
    assert.equal(fs.readFileSync(output, 'utf8'), `version_id=${candidate.id}\n`);
    p.deployment.id = 'changed-concurrently';
    await assert.rejects(main('candidate', evidence, uploads));
  } finally {
    globalThis.fetch = oldFetch;
    process.env = savedEnv;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('workflow keeps migration gates and orders routine checks before upload and traffic, with no data or secret mutation commands', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/deploy.yml'), 'utf8');
  const migration = workflow.slice(
    workflow.indexOf('  deploy-new-production:'),
    workflow.indexOf('  routine-production-release:'),
  );
  assert.ok(migration.includes('scripts/check-migration-targets.mjs --require-ready'));
  const routine = workflow.slice(
    workflow.indexOf('  routine-production-release:'),
    workflow.indexOf('  deploy-preview:'),
  );
  assert.ok(routine.includes('CF_2048_NEW_PRODUCTION_DEPLOY_TOKEN'));
  const stages = [
    'production-release.mjs preflight',
    'wrangler versions upload',
    'production-release.mjs candidate',
    'wrangler versions deploy',
    'production-release.mjs verify',
  ];
  let previous = -1;
  for (const stage of stages) {
    const index = routine.indexOf(stage);
    assert.ok(index > previous, `${stage} is absent or ordered unsafely`);
    previous = index;
  }
  for (const command of [
    'd1 migrations apply',
    'd1 execute',
    'secret put',
    'secret bulk',
    'secret delete',
    'publish-cloudflare-secrets',
    '--force',
  ])
    assert.equal(routine.includes(command), false, command);
});
