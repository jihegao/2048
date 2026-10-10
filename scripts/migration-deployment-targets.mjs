import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const targets = {
  'old-preparation': {
    file: 'wrangler.old-preparation.jsonc',
    account: '8b0d70250211aa10d89e20605a1c7e5e',
    database: '4598bd98-f338-4f8b-9db7-b5b399d698f5',
    domain: '2048.gaojihe.cn',
    mode: 'normal',
    control: 'true',
    proof: 'true',
    audience: '2048-old-production',
    frozen: false,
    workersDev: true,
    preview: true,
  },
  'old-frozen': {
    file: 'wrangler.old-frozen.jsonc',
    account: '8b0d70250211aa10d89e20605a1c7e5e',
    database: '4598bd98-f338-4f8b-9db7-b5b399d698f5',
    domain: '2048.gaojihe.cn',
    mode: 'frozen',
    control: 'true',
    proof: 'true',
    audience: '2048-old-production',
    frozen: true,
    workersDev: false,
    preview: false,
  },
  'new-preparation': {
    file: 'wrangler.new-preparation.jsonc',
    account: '3232ebc7e9bb0199b92e3d70b07825af',
    database: 'd46a430b-4c22-469b-9af0-61b41b88e914',
    domain: null,
    mode: 'frozen',
    control: 'true',
    proof: 'true',
    audience: '2048-new-production',
    frozen: true,
    workersDev: true,
    preview: false,
    roomNamespace: 'e1cc2ec83e1f45558dbd52cb020ba3c5',
    loginNamespace: '0c5fda17cd6941169a525b33b014c71b',
  },
  'new-production': {
    file: 'wrangler.new-production.jsonc',
    account: '3232ebc7e9bb0199b92e3d70b07825af',
    database: 'd46a430b-4c22-469b-9af0-61b41b88e914',
    domain: 'mingcheng1024.cn',
    mode: 'normal',
    control: 'true',
    proof: 'false',
    audience: '2048-new-production',
    frozen: false,
    workersDev: false,
    preview: false,
  },
  staging: {
    file: 'wrangler.staging.jsonc',
    account: '8b0d70250211aa10d89e20605a1c7e5e',
    database: '3a9d4b6b-5fca-4fe7-96d5-c252c2ce7a38',
    domain: 'preview.2048.gaojihe.cn',
    mode: 'normal',
    control: 'false',
    proof: 'false',
    audience: '2048-old-staging',
    frozen: false,
    workersDev: true,
    preview: true,
  },
};

export function checkTarget(name) {
  const target = targets[name];
  assert.ok(target, 'Unknown deployment target');
  // Generated JSONC files have no comments; Prettier may add trailing commas.
  const config = JSON.parse(
    fs.readFileSync(path.join(root, target.file), 'utf8').replace(/,\s*(?=[}\]])/gu, ''),
  );
  assert.equal(config.account_id, target.account);
  assert.equal(
    config.name,
    name === 'staging' ? '2048-challenge-platform-staging' : '2048-challenge-platform',
  );
  assert.equal(
    config.env,
    undefined,
    'A fixed deployment file cannot contain alternate environments',
  );
  assert.deepEqual(config.d1_databases, [
    {
      binding: 'DB',
      database_name: name === 'staging' ? 'challenge-platform-staging' : 'challenge-platform',
      database_id: target.database,
      migrations_dir: 'migrations',
    },
  ]);
  assert.deepEqual(config.durable_objects.bindings, [
    { name: 'ROOMS', class_name: 'RoomSession' },
    { name: 'LOGIN_GUARD', class_name: 'LoginGuard' },
  ]);
  assert.deepEqual(config.migrations, [
    { tag: 'v1', new_sqlite_classes: ['RoomSession', 'LoginGuard'] },
  ]);
  assert.deepEqual(
    config.routes,
    target.domain ? [{ pattern: target.domain, custom_domain: true }] : [],
  );
  assert.equal(config.main, target.frozen ? 'worker/migration-freeze.ts' : 'worker/index.ts');
  assert.equal(config.workers_dev, target.workersDev);
  assert.equal(config.preview_urls, target.preview);
  assert.equal(config.keep_vars, true);
  assert.deepEqual(config.version_metadata, { binding: 'CF_VERSION_METADATA' });
  assert.deepEqual(config.triggers.crons, target.frozen ? [] : ['* * * * *']);
  assert.equal(config.vars.MIGRATION_MODE, target.mode);
  assert.equal(config.vars.MIGRATION_USE_D1_CONTROL, target.control);
  assert.equal(config.vars.MIGRATION_VERIFICATION_ENABLED, target.proof);
  assert.equal(config.vars.MIGRATION_AUDIENCE, target.audience);
  assert.equal(config.vars.PBKDF2_ITERATIONS, '100000');
  for (const key of ['kv_namespaces', 'r2_buckets', 'queues', 'services', 'workflows'])
    assert.equal(config[key], undefined);
  if (name === 'new-preparation') assert.equal(config.assets, undefined);
  else {
    assert.equal(config.assets.directory, './dist');
    assert.equal(config.assets.binding, 'ASSETS');
    if (target.frozen) assert.equal(config.assets.run_worker_first, true);
  }
  return { config, target };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const selected = process.argv[2] ? [process.argv[2]] : Object.keys(targets);
  try {
    for (const name of selected) checkTarget(name);
    console.log(JSON.stringify({ fixed_targets_checked: selected, ok: true }));
  } catch {
    console.error('Deployment target validation failed; no remote operation performed');
    process.exitCode = 1;
  }
}
