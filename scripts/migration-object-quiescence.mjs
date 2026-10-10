import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const account = '8b0d70250211aa10d89e20605a1c7e5e';
const worker = '2048-challenge-platform';
const origin = 'https://2048.gaojihe.cn';
const namespaces = {
  room: 'e3afde986fd44e679a24face919e5a6d',
  'login-guard': 'e04866ac28fc44288d0f24e498b193d8',
};
const uuid = /^[a-f0-9-]{36}$/u;
const objectId = /^[a-f0-9]{64}$/u;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Consume every page, including a final empty page. Do not expose object IDs or cursors.
export async function listAllObjects(requestPage) {
  const objects = new Map();
  const cursors = new Set();
  let cursor;
  let pages = 0;
  for (;;) {
    assert.ok(pages < 1000, 'Inventory page limit exceeded');
    const response = await requestPage(cursor);
    pages++;
    assert.equal(response.success, true, 'Inventory failed');
    assert.ok(Array.isArray(response.result), 'Inventory shape failed');
    for (const item of response.result) {
      assert.match(item.id, objectId);
      assert.equal(typeof item.hasStoredData, 'boolean');
      assert.ok(!objects.has(item.id), 'Inventory repeated an object');
      objects.set(item.id, item.hasStoredData);
    }
    if (response.result.length === 0) break;
    const next = response.result_info?.cursor;
    if (next === undefined || next === null || next === '') {
      assert.ok(response.result.length < 1000, 'Full page has no continuation cursor');
      break;
    }
    assert.equal(typeof next, 'string');
    assert.ok(!cursors.has(next), 'Inventory cursor did not advance');
    cursors.add(next);
    cursor = next;
  }
  return { objects: [...objects].sort(([a], [b]) => a.localeCompare(b)), pages };
}

export function objectProof(key, objects, now = Date.now()) {
  const payload = {
    purpose: '2048-frozen-object-probe-v1',
    audience: '2048-old-production',
    nonce: randomBytes(24).toString('base64url'),
    issuedAt: now,
    expiresAt: now + 60_000,
    objects,
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', `2048-migration-object-probe-auth-v1\u0000${key}`)
    .update(encoded)
    .digest('base64url');
  return { authorization: `Migration ${encoded}.${signature}`, nonce: payload.nonce };
}

export function checkProbe(result, expected, version, nonce) {
  assert.match(version, uuid);
  assert.equal(result.artifact, '2048-frozen-v1');
  assert.equal(result.versionId, version, 'Worker version has not converged');
  assert.equal(result.nonce, nonce);
  assert.ok(Array.isArray(result.objects));
  assert.equal(result.objects.length, expected.length);
  const rows = new Map();
  for (const object of result.objects) {
    const id = `${object.kind}:${object.objectId}`;
    assert.ok(expected.some((item) => `${item.kind}:${item.id}` === id));
    assert.ok(!rows.has(id));
    assert.equal(object.artifact, '2048-frozen-v1');
    assert.equal(object.versionId, version, 'Previous DO version remains');
    assert.equal(object.openSockets, 0, 'A WebSocket is still open');
    assert.match(object.digest, objectId);
    assert.match(object.storageDigest, objectId);
    assert.ok(
      object.nextAlarmAt === null ||
        (Number.isSafeInteger(object.nextAlarmAt) && object.nextAlarmAt >= 0),
    );
    rows.set(id, object);
  }
  return rows;
}

export function comparePasses(before, after) {
  assert.equal(after.inventory_digest, before.inventory_digest, 'Object inventory changed');
  assert.equal(after.storage_digest, before.storage_digest, 'DO business storage changed');
  assert.equal(after.version, before.version, 'Frozen version changed');
  assert.ok(after.checked_at >= before.checked_at);
  return {
    stable_inventory: true,
    stable_business_storage: true,
    all_objects_on_frozen_version: true,
    open_sockets: 0,
    // A successfully delivered no-op alarm may disappear without a business mutation.
    alarm_metadata_unchanged: before.alarm_digest === after.alarm_digest,
  };
}

async function main() {
  const action = process.argv[2];
  assert.ok(['inventory', 'verify-frozen'].includes(action));
  const token = process.env.CF_2048_OLD_SOURCE_TOKEN;
  assert.ok(token, 'Original OLD token is required');
  const api = async (route, query) => {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/${route}${query ? `?${query}` : ''}`,
      {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      },
    );
    assert.equal(response.status, 200, 'OLD read-only API failed');
    const result = await response.json();
    assert.equal(result.success, true);
    return result;
  };
  const inventory = async () => {
    const objects = [];
    const summary = {};
    for (const [kind, namespace] of Object.entries(namespaces)) {
      const result = await listAllObjects((cursor) =>
        api(
          `workers/durable_objects/namespaces/${namespace}/objects`,
          new URLSearchParams({ limit: '1000', ...(cursor ? { cursor } : {}) }),
        ),
      );
      summary[kind] = {
        total: result.objects.length,
        stored: result.objects.filter(([, stored]) => stored).length,
        pages: result.pages,
      };
      objects.push(...result.objects.map(([id, hasStoredData]) => ({ kind, id, hasStoredData })));
    }
    return { objects, summary };
  };
  if (action === 'inventory') {
    const result = await inventory();
    console.log(
      JSON.stringify({
        account_id: account,
        worker,
        inventory: result.summary,
        writes_performed: false,
      }),
    );
    return;
  }
  // Probing closes remaining sockets; never run it during normal service or before drain.
  assert.equal(process.env.CONFIRMED_MAINTENANCE_WINDOW, 'true');
  assert.equal(process.env.VERIFIED_DRAIN_COMPLETE, 'true');
  const version = process.env.EXPECTED_FROZEN_VERSION;
  assert.match(version ?? '', uuid);
  const key = process.env.IMPORT_SIGNING_KEY;
  assert.ok(key);
  const deployment = async () => {
    const result = (await api(`workers/scripts/${worker}/deployments`)).result.deployments[0];
    assert.deepEqual(result.versions, [{ version_id: version, percentage: 100 }]);
  };
  const settings = (await api(`workers/scripts/${worker}/settings`)).result;
  const binding = (name) => settings.bindings.find((item) => item.name === name);
  assert.equal(binding('DB')?.id, '4598bd98-f338-4f8b-9db7-b5b399d698f5');
  assert.equal(binding('ROOMS')?.namespace_id, namespaces.room);
  assert.equal(binding('LOGIN_GUARD')?.namespace_id, namespaces['login-guard']);
  assert.equal(binding('MIGRATION_MODE')?.text, 'frozen');
  assert.equal(binding('MIGRATION_AUDIENCE')?.text, '2048-old-production');
  assert.equal(binding('MIGRATION_VERIFICATION_ENABLED')?.text, 'true');
  assert.equal(binding('CF_VERSION_METADATA')?.type, 'version_metadata');
  assert.deepEqual((await api(`workers/scripts/${worker}/schedules`)).result.schedules, []);
  assert.deepEqual((await api(`workers/scripts/${worker}/subdomain`)).result, {
    enabled: false,
    previews_enabled: false,
  });
  const pass = async () => {
    await deployment();
    const listed = await inventory();
    const rows = [];
    for (let start = 0; start < listed.objects.length; start += 20) {
      const objects = listed.objects.slice(start, start + 20).map(({ kind, id }) => ({ kind, id }));
      const proof = objectProof(key, objects);
      const response = await fetch(`${origin}/api/_migration/objects/probe`, {
        method: 'POST',
        headers: { Authorization: proof.authorization },
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
      assert.equal(response.status, 200, 'Frozen object proof unavailable');
      const checked = checkProbe(await response.json(), objects, version, proof.nonce);
      rows.push(...checked);
    }
    await deployment();
    rows.sort(([a], [b]) => a.localeCompare(b));
    const alarms = rows.map(([id, object]) => [id, object.nextAlarmAt]);
    const pending = alarms.filter(([, alarm]) => alarm !== null);
    return {
      version,
      inventory: listed.summary,
      inventory_digest: digest(listed.objects),
      storage_digest: digest(rows.map(([id, object]) => [id, object.storageDigest])),
      alarm_digest: digest(alarms),
      pending_alarms: pending.length,
      earliest_pending_alarm_at: pending.length
        ? Math.min(...pending.map(([, alarm]) => alarm))
        : null,
      checked_at: Date.now(),
    };
  };
  const before = await pass();
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  const after = await pass();
  const stable = comparePasses(before, after);
  console.log(
    JSON.stringify({
      account_id: account,
      worker,
      ...after,
      ...stable,
      last_possible_old_login_write_not_before: after.checked_at,
      login_guard_safe_not_before: after.checked_at + 15 * 60_000,
      // D1 fence, in-flight invocation completion and original-version restore need separate evidence.
      full_write_freeze_proved: false,
      production_migration_ready: false,
    }),
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    // API exceptions can contain Authorization headers or proof tokens. Print no exception data.
    console.error('OLD object verification stopped; no quiescence or release gate was cleared.');
    process.exitCode = 1;
  });
}
