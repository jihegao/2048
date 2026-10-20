import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requiredGates } from './check-migration-targets.mjs';
import { checkTarget, root, targets } from './migration-deployment-targets.mjs';

export const repository = 'jihegao/2048';
export const origin = 'https://mingcheng1024.cn';
const worker = '2048-challenge-platform';
const target = targets['new-production'];
const scriptPath = `/accounts/${target.account}/workers/scripts/${worker}`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Initial cutover keeps its active-window gate. Routine updates require proof
// that this fixed production target has already completed that cutover.
export function checkRoutineEvidence(state) {
  assert.equal(state.new_account, target.account);
  assert.equal(state.new_database, target.database);
  assert.equal(state.release_ready, true);
  for (const gate of requiredGates) assert.equal(state.gates?.[gate], true, `${gate} incomplete`);
  const activation = state.final_production_activation;
  assert.match(activation?.version ?? '', uuid);
  assert.equal(activation.phase, 'normal');
  assert.equal(state.public_production_acceptance?.public_production_acceptance_passed, true);
  assert.equal(state.public_production_acceptance.version, activation.version);
}

export function checkSource({ expected, checkout, ref, repo, main, runs }) {
  assert.match(expected ?? '', /^[a-f0-9]{40}$/u);
  assert.equal(repo, repository, 'Only the 2048 repository can use this release path');
  assert.equal(ref, 'refs/heads/main', 'Routine releases require main');
  assert.equal(checkout, expected, 'Checkout differs from reviewed commit');
  assert.equal(main, expected, 'Reviewed commit is no longer current main');
  const latest = runs
    .filter(
      (run) => run.head_sha === expected && run.event === 'push' && run.head_branch === 'main',
    )
    .sort((a, b) => b.id - a.id)[0];
  assert.ok(latest, 'No main CI run for the reviewed commit');
  assert.equal(latest.status, 'completed', 'Main CI has not completed');
  assert.equal(latest.conclusion, 'success', 'Main CI did not pass');
  return latest.id;
}

function bindingsSnapshot(bindings) {
  return bindings
    .map((binding) => {
      if (binding.type === 'secret_text') return { name: binding.name, type: binding.type };
      const result = { ...binding };
      if (result.type === 'd1') {
        result.database_id ??= result.id;
        delete result.id;
      }
      return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function checkProduction(snapshot, config, headers) {
  const { version, deployment, domains, subdomain, schedules, status } = snapshot;
  assert.equal(deployment.versions.length, 1, 'Production has a split deployment');
  assert.equal(deployment.versions[0].percentage, 100);
  assert.equal(deployment.versions[0].version_id, version.id);
  const runtime = version.resources.script_runtime;
  const bindings = version.resources.bindings;
  const binding = (name) => bindings.find((item) => item.name === name);
  assert.equal(binding('DB')?.database_id ?? binding('DB')?.id, target.database);
  for (const [name, expected] of [
    ['ROOMS', targets['new-preparation'].roomNamespace],
    ['LOGIN_GUARD', targets['new-preparation'].loginNamespace],
  ]) {
    assert.equal(binding(name)?.namespace_id, expected, `${name} namespace changed`);
  }
  for (const [name, value] of Object.entries(config.vars))
    assert.equal(binding(name)?.text, value, `${name} differs from production config`);
  for (const name of [
    'BOOTSTRAP_TEACHER_NAME',
    'BOOTSTRAP_TEACHER_USERNAME',
    'BOOTSTRAP_TEACHER_PASSWORD',
    'PASSWORD_PEPPER',
    'INITIAL_STUDENT_PASSWORD',
    'PRACTICE_SIGNING_KEY',
    'IMPORT_SIGNING_KEY',
  ])
    assert.equal(binding(name)?.type, 'secret_text', `Missing existing secret ${name}`);
  assert.equal(binding('ASSETS')?.type, 'assets');
  assert.equal(binding('CF_VERSION_METADATA')?.type, 'version_metadata');
  assert.equal(runtime.compatibility_date, config.compatibility_date);
  assert.deepEqual(runtime.compatibility_flags, config.compatibility_flags);
  assert.equal(runtime.migration_tag, 'v1', 'Unexpected Durable Object migration state');
  assert.equal(runtime.assets.not_found_handling, config.assets.not_found_handling);
  assert.equal(runtime.assets.raw_headers, headers, 'Asset security headers changed');
  assert.deepEqual(runtime.assets.raw_run_worker_first, config.assets.run_worker_first);
  assert.equal(subdomain.enabled, false);
  assert.equal(subdomain.previews_enabled, false);
  assert.deepEqual(
    schedules.map((item) => item.cron),
    config.triggers.crons,
  );
  assert.equal(domains.length, 1);
  assert.equal(domains[0].hostname, new URL(origin).hostname);
  assert.equal(domains[0].service, worker);
  assert.equal(domains[0].enabled, true);
  assert.equal(domains[0].previews_enabled, false);
  assert.equal(status.mode, 'normal', 'Live database/runtime is not in normal mode');
  assert.equal(status.newGamesAllowed, true);
}

export function checkCandidate(version, baseline, commit) {
  assert.match(version.id ?? '', uuid);
  assert.equal(
    version.annotations?.['workers/tag'],
    commit,
    'Candidate was built for another commit',
  );
  if (version.annotations?.['workers/commit_sha'])
    assert.equal(version.annotations['workers/commit_sha'], commit);
  assert.deepEqual(
    bindingsSnapshot(version.resources.bindings),
    bindingsSnapshot(baseline.version.resources.bindings),
    'Candidate changed production bindings or vars',
  );
  const current = version.resources.script_runtime;
  const previous = baseline.version.resources.script_runtime;
  for (const key of ['compatibility_date', 'compatibility_flags', 'usage_model', 'migration_tag'])
    assert.deepEqual(current[key], previous[key], `Candidate changed ${key}`);
  for (const key of ['not_found_handling', 'raw_headers', 'raw_run_worker_first'])
    assert.deepEqual(current.assets[key], previous.assets[key], `Candidate changed asset ${key}`);
}

export function uploadedVersion(records) {
  const uploads = records.filter((item) => item.type === 'version-upload');
  assert.equal(uploads.length, 1, 'Require one recorded Wrangler candidate upload');
  assert.match(uploads[0].version_id ?? '', uuid);
  return uploads[0].version_id;
}

async function json(url, token) {
  const response = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}`, Accept: 'application/json' } : {},
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(
    response.status,
    200,
    `Read-only release check failed: ${new URL(url).pathname} HTTP ${response.status}`,
  );
  return response.json();
}
async function cf(suffix) {
  assert.ok(process.env.CLOUDFLARE_API_TOKEN, 'Existing production token is required');
  const response = await json(
    `https://api.cloudflare.com/client/v4${suffix}`,
    process.env.CLOUDFLARE_API_TOKEN,
  );
  assert.equal(response.success, true, 'Cloudflare readback failed');
  return response.result;
}
async function source() {
  const expected = process.env.EXPECTED_COMMIT;
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  assert.equal(process.env.GITHUB_SHA, checkout);
  assert.equal(process.env.CLOUDFLARE_ACCOUNT_ID, target.account, 'Wrong Cloudflare account');
  const api = `https://api.github.com/repos/${repository}`;
  const [commit, data] = await Promise.all([
    json(`${api}/commits/main`, process.env.GITHUB_TOKEN),
    json(
      `${api}/actions/workflows/ci.yml/runs?branch=main&head_sha=${expected}&event=push&per_page=100`,
      process.env.GITHUB_TOKEN,
    ),
  ]);
  const ciRun = checkSource({
    expected,
    checkout,
    ref: process.env.GITHUB_REF,
    repo: process.env.GITHUB_REPOSITORY,
    main: commit.sha,
    runs: data.workflow_runs,
  });
  return { commit: expected, ciRun };
}
async function snapshot() {
  const [active, domains, subdomain, schedules, status, settings] = await Promise.all([
    cf(`${scriptPath}/deployments?per_page=1`),
    cf(`/accounts/${target.account}/workers/domains?service=${worker}`),
    cf(`${scriptPath}/subdomain`),
    cf(`${scriptPath}/schedules`),
    json(`${origin}/api/migration-status`),
    cf(`${scriptPath}/settings`),
  ]);
  const deployment = active.deployments[0];
  assert.ok(deployment, 'No existing production deployment');
  assert.equal(deployment.versions.length, 1, 'Refuse to overwrite a split deployment');
  const version = await cf(`${scriptPath}/versions/${deployment.versions[0].version_id}`);
  return {
    deployment,
    domains,
    subdomain,
    schedules: schedules.schedules,
    status,
    version,
    observability: settings.observability,
    bindings: bindingsSnapshot(settings.bindings),
  };
}

async function verifyWorkerModule() {
  const response = await fetch(`https://api.cloudflare.com/client/v4${scriptPath}/content/v2`, {
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 200, 'Published Worker module readback failed');
  const body = await response.text();
  const boundary = body.split('\r\n')[0];
  const part = body.split(boundary).find((item) => item.includes('filename="index.js"'));
  assert.ok(part, 'Published Worker entry module missing');
  const content = part.slice(part.indexOf('\r\n\r\n') + 4).replace(/\r\n$/u, '');
  const moduleSha256 = sha(Buffer.from(content));
  assert.equal(
    moduleSha256,
    sha(fs.readFileSync(path.join(root, '.wrangler/production-bundle/index.js'))),
    'Published Worker does not match the reviewed build',
  );
  return moduleSha256;
}

async function verifyAssets() {
  const files = fs
    .readdirSync(path.join(root, 'dist'), { recursive: true, withFileTypes: true })
    .filter(
      (item) => item.isFile() && !['_headers', '_redirects', '.assetsignore'].includes(item.name),
    );
  for (const item of files) {
    const file = path.join(item.parentPath, item.name);
    const relative = path
      .relative(path.join(root, 'dist'), file)
      .split(path.sep)
      .map(encodeURIComponent)
      .join('/');
    const response = await fetch(`${origin}/${relative}`, {
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    assert.equal(response.status, 200, `Published asset unavailable: ${relative}`);
    assert.equal(
      sha(await response.bytes()),
      sha(fs.readFileSync(file)),
      `Published asset mismatch: ${relative}`,
    );
  }
  return files.length;
}

export async function main(mode, evidenceFile, uploadFile) {
  assert.ok(['preflight', 'candidate', 'verify'].includes(mode), 'Unknown release phase');
  assert.ok(evidenceFile, 'Require an evidence file');
  const { config } = checkTarget('new-production');
  checkRoutineEvidence(
    JSON.parse(fs.readFileSync(path.join(root, 'operations/migration-release-state.json'), 'utf8')),
  );
  const checkedSource = await source();
  const current = await snapshot();
  const headers = fs.readFileSync(path.join(root, 'public/_headers'), 'utf8');
  checkProduction(current, config, headers);
  if (mode === 'preflight') {
    fs.writeFileSync(
      evidenceFile,
      JSON.stringify({ ...checkedSource, baseline: current }, null, 2) + '\n',
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({ phase: mode, ...checkedSource, baselineVersion: current.version.id }),
    );
    return;
  }
  const evidence = JSON.parse(fs.readFileSync(evidenceFile, 'utf8'));
  assert.equal(evidence.commit, checkedSource.commit);
  if (mode === 'candidate') {
    assert.deepEqual(
      current.observability,
      evidence.baseline.observability,
      'Candidate changed observability settings',
    );
    assert.equal(
      current.deployment.id,
      evidence.baseline.deployment.id,
      'Production changed after preflight',
    );
    const id = uploadedVersion(
      fs
        .readFileSync(uploadFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    );
    const candidate = await cf(`${scriptPath}/versions/${id}`);
    checkCandidate(candidate, evidence.baseline, evidence.commit);
    evidence.candidateVersion = id;
    evidence.candidateChecked = true;
    fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
    assert.ok(process.env.GITHUB_OUTPUT, 'Require GitHub Actions output destination');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `version_id=${id}\n`);
    console.log(
      JSON.stringify({ phase: mode, commit: evidence.commit, version: id, trafficChanged: false }),
    );
    return;
  }
  assert.equal(evidence.candidateChecked, true);
  assert.equal(current.version.id, evidence.candidateVersion);
  checkCandidate(current.version, evidence.baseline, evidence.commit);
  assert.deepEqual(
    current.observability,
    evidence.baseline.observability,
    'Observability settings changed',
  );
  assert.deepEqual(
    current.bindings,
    evidence.baseline.bindings,
    'Worker settings bindings changed',
  );
  for (const key of ['domains', 'subdomain'])
    assert.deepEqual(current[key], evidence.baseline[key], `Production ${key} changed`);
  assert.deepEqual(
    current.schedules.map((item) => item.cron),
    evidence.baseline.schedules.map((item) => item.cron),
  );
  const moduleSha256 = await verifyWorkerModule();
  const assetsVerified = await verifyAssets();
  await source();
  evidence.published = {
    version: current.version.id,
    deployment: current.deployment.id,
    percentage: 100,
    assetsVerified,
    moduleSha256,
    ...checkedSource,
  };
  fs.writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ phase: mode, ...evidence.published }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(...process.argv.slice(2)).catch((error) => {
    console.error(`Production release blocked: ${error.message}`);
    process.exitCode = 1;
  });
}
