import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from './migration-deployment-targets.mjs';
import { secretNames, verifyRuntime } from './migration-runtime-key-handoff.mjs';

const account = '8b0d70250211aa10d89e20605a1c7e5e';
const script = '2048-challenge-platform';
const scriptUrl = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}`;
const originalVersion = 'b7bd3120-fc51-4c62-8fbd-34b6f1242a78';
const wrapperName = 'migration-source-verification.mjs';

export async function prepareSourceVerification(modules, settings, originalMain) {
  const binding = (name) => settings.bindings.find((item) => item.name === name);
  assert.equal(binding('DB')?.id, '4598bd98-f338-4f8b-9db7-b5b399d698f5');
  assert.equal(binding('ROOMS')?.namespace_id, 'e3afde986fd44e679a24face919e5a6d');
  assert.equal(binding('LOGIN_GUARD')?.namespace_id, 'e04866ac28fc44288d0f24e498b193d8');
  assert.equal(binding('PBKDF2_ITERATIONS')?.text, '100000');
  const allowed = ['ASSETS', 'DB', 'ROOMS', 'LOGIN_GUARD', 'PBKDF2_ITERATIONS', ...secretNames];
  assert.deepEqual(settings.bindings.map((item) => item.name).sort(), allowed.sort());
  for (const name of secretNames) assert.equal(binding(name)?.type, 'secret_text');
  assert.match(originalMain, /^[A-Za-z0-9_./-]+$/u);
  assert.ok(!originalMain.startsWith('/') && !originalMain.split('/').includes('..'));
  assert.notEqual(originalMain, wrapperName);
  assert.ok(modules.has(originalMain), 'Original main module missing');
  assert.ok(!modules.has(wrapperName) && !modules.has('metadata'));
  const fingerprints = [];
  for (const [name, value] of modules.entries()) {
    assert.ok(value instanceof File, 'Original module must remain a file');
    fingerprints.push({
      module: name,
      bytes: value.size,
      sha256: createHash('sha256')
        .update(Buffer.from(await value.arrayBuffer()))
        .digest('hex'),
    });
  }
  const template = fs.readFileSync(
    path.join(root, 'operations/source-verification-wrapper.mjs'),
    'utf8',
  );
  let replacements = 0;
  const wrapper = template.replace(/(['"])\.\/__2048_original_module__\.js\1/gu, () => {
    replacements += 1;
    return JSON.stringify(`./${originalMain}`);
  });
  assert.equal(replacements, 2, 'Wrapper import placeholders changed');
  const metadata = {
    main_module: wrapperName,
    compatibility_date: settings.compatibility_date,
    compatibility_flags: settings.compatibility_flags,
    keep_assets: true,
    bindings: [
      ...settings.bindings.map((item) => ({ type: 'inherit', name: item.name })),
      { type: 'plain_text', name: 'MIGRATION_VERIFICATION_ENABLED', text: 'true' },
      { type: 'plain_text', name: 'MIGRATION_AUDIENCE', text: '2048-old-production' },
      { type: 'version_metadata', name: 'CF_VERSION_METADATA' },
    ],
    ...(settings.observability ? { observability: settings.observability } : {}),
  };
  modules.append(
    wrapperName,
    new File([wrapper], wrapperName, { type: 'application/javascript+module' }),
  );
  modules.append('metadata', JSON.stringify(metadata));
  return { body: modules, fingerprints, originalMain };
}

async function main() {
  assert.equal(process.env.APPROVED_SOURCE_VERIFICATION, 'true');
  const token = process.env.CF_2048_OLD_SOURCE_TOKEN;
  assert.ok(token, 'Original OLD-scoped token missing');
  const secrets = Object.fromEntries(secretNames.map((name) => [name, process.env[name]]));
  assert.ok(
    secretNames.every((name) => typeof secrets[name] === 'string' && secrets[name].length > 0),
  );
  const headers = { Authorization: `Bearer ${token}` };
  const read = async (suffix) => {
    assert.ok(['/settings', '/deployments', '/versions'].includes(suffix));
    const response = await fetch(scriptUrl + suffix, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    assert.ok(response.ok && data.success === true);
    return data.result;
  };
  const deployments = await read('/deployments');
  const current = (deployments.deployments ?? deployments)[0];
  assert.deepEqual(current.versions, [{ version_id: originalVersion, percentage: 100 }]);
  assert.equal((await read('/versions')).items[0]?.id, originalVersion);
  const settings = await read('/settings');
  const content = await fetch(scriptUrl, {
    headers,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(content.status, 200);
  assert.ok(content.headers.get('Content-Type')?.includes('multipart/form-data'));
  const prepared = await prepareSourceVerification(
    await content.formData(),
    settings,
    content.headers.get('cf-entrypoint'),
  );
  // Recheck the active version immediately before the only OLD mutation.
  assert.equal(((await read('/deployments')).deployments ?? [])[0]?.id, current.id);
  assert.equal((await read('/versions')).items[0]?.id, originalVersion);
  const upload = await fetch(scriptUrl + '?bindings_inherit=strict', {
    method: 'PUT',
    headers,
    body: prepared.body,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
  });
  const outcome = await upload.json();
  assert.ok(upload.ok && outcome.success === true);
  let verified;
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      verified = await verifyRuntime(secrets, 'https://2048.gaojihe.cn', '2048-old-production');
      break;
    } catch {
      if (attempt === 11) throw new Error('Source runtime check failed');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
  console.log(
    JSON.stringify({
      account_id: account,
      worker: script,
      original_version: originalVersion,
      original_modules_preserved: prepared.fingerprints,
      keep_assets: true,
      all_original_bindings_inherited: true,
      source: verified,
      production_migration_ready: false,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error(
      'Source verification stopped; no secret values or response bodies logged. Check safe version/binding status.',
    );
    process.exitCode = 1;
  });
}
