import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseSourceModules,
  prepareSourceVerification,
} from '../../scripts/migration-source-key-verification.mjs';
import { secretNames } from '../../scripts/migration-runtime-key-handoff.mjs';

function settings() {
  return {
    compatibility_date: '2026-08-26',
    compatibility_flags: ['nodejs_compat'],
    bindings: [
      { name: 'ASSETS', type: 'assets' },
      { name: 'DB', type: 'd1', id: '4598bd98-f338-4f8b-9db7-b5b399d698f5' },
      {
        name: 'ROOMS',
        type: 'durable_object_namespace',
        namespace_id: 'e3afde986fd44e679a24face919e5a6d',
      },
      {
        name: 'LOGIN_GUARD',
        type: 'durable_object_namespace',
        namespace_id: 'e04866ac28fc44288d0f24e498b193d8',
      },
      { name: 'PBKDF2_ITERATIONS', type: 'plain_text', text: '100000' },
      ...secretNames.map((name) => ({ name, type: 'secret_text' })),
    ],
  };
}
function modules() {
  const data = new FormData();
  data.append(
    'index.js',
    new File(
      ['export default {}; export class RoomSession {} export class LoginGuard {}'],
      'index.js',
      { type: 'application/javascript+module' },
    ),
  );
  data.append(
    'fixture.wasm',
    new File([new Uint8Array([0, 1, 2, 3, 255])], 'fixture.wasm', { type: 'application/wasm' }),
  );
  return data;
}

test('preserves every original text/binary module and inherits every original binding', async () => {
  const original = modules();
  const originalSource = await original.get('index.js').text();
  const binary = await original.get('fixture.wasm').arrayBuffer();
  const prepared = await prepareSourceVerification(original, settings(), 'index.js');
  assert.equal(await prepared.body.get('index.js').text(), originalSource);
  assert.deepEqual(await prepared.body.get('fixture.wasm').arrayBuffer(), binary);
  assert.equal(prepared.fingerprints.length, 2);
  const metadata = JSON.parse(prepared.body.get('metadata'));
  assert.equal(metadata.keep_assets, true);
  assert.equal(metadata.main_module, 'migration-source-verification.mjs');
  assert.deepEqual(
    metadata.bindings.slice(0, 12),
    settings().bindings.map((item) => ({ name: item.name, type: 'inherit' })),
  );
  assert.equal(metadata.migrations, undefined);
  const wrapper = await prepared.body.get(metadata.main_module).text();
  assert.ok(!wrapper.includes('__2048_original_module__'));
  assert.equal(metadata.bindings.filter((item) => item.type === 'secret_text').length, 0);
});

test('refuses wrong database, unresolved entrypoint or unreviewed binding', async () => {
  const wrong = settings();
  wrong.bindings.find((item) => item.name === 'DB').id = '33333333-3333-4333-8333-333333333333';
  await assert.rejects(prepareSourceVerification(modules(), wrong, 'index.js'));
  await assert.rejects(prepareSourceVerification(modules(), settings(), null));
  const extra = settings();
  extra.bindings.push({ name: 'OTHER_SERVICE', type: 'service', service: 'synthetic-other' });
  await assert.rejects(prepareSourceVerification(modules(), extra, 'index.js'));
});

test('content download without filename preserves BOM, CRLF and every binary byte', async () => {
  const source = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('export default {};\r\n'),
  ]);
  const binary = Buffer.from([0, 1, 255, 254, 13, 10]);
  const raw = Buffer.concat([
    Buffer.from(
      '--fixture\r\nContent-Disposition: form-data; name="index.js"\r\nContent-Type: text/plain\r\n\r\n',
    ),
    source,
    Buffer.from(
      '\r\n--fixture\r\nContent-Disposition: form-data; name="fixture.wasm"\r\nContent-Type: application/wasm\r\n\r\n',
    ),
    binary,
    Buffer.from('\r\n--fixture--\r\n'),
  ]);
  const original = parseSourceModules(raw, 'multipart/form-data; boundary="fixture"');
  const prepared = await prepareSourceVerification(original, settings(), 'index.js');
  assert.deepEqual(Buffer.from(await prepared.body.get('index.js').arrayBuffer()), source);
  assert.deepEqual(Buffer.from(await prepared.body.get('fixture.wasm').arrayBuffer()), binary);
  assert.equal(prepared.body.get('index.js').type, 'application/javascript+module');
  assert.throws(() =>
    parseSourceModules(raw.subarray(0, raw.length - 7), 'multipart/form-data; boundary=fixture'),
  );
  assert.throws(() =>
    parseSourceModules(
      Buffer.concat([raw.subarray(0, raw.length - 13), raw]),
      'multipart/form-data; boundary=fixture',
    ),
  );
});
