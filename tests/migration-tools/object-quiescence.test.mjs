import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  checkProbe,
  comparePasses,
  listAllObjects,
  objectProof,
} from '../../scripts/migration-object-quiescence.mjs';

const version = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const expected = [{ kind: 'room', id: 'a'.repeat(64) }];
const proof = objectProof('synthetic-import-key', expected);
const result = () => ({
  artifact: '2048-frozen-v1',
  versionId: version,
  nonce: proof.nonce,
  objects: [
    {
      artifact: '2048-frozen-v1',
      versionId: version,
      kind: 'room',
      objectId: expected[0].id,
      digest: 'b'.repeat(64),
      storageDigest: 'c'.repeat(64),
      nextAlarmAt: null,
      openSockets: 0,
    },
  ],
});

test('inventory reads every continuation page and rejects looping or duplicated pages', async () => {
  const calls = [];
  const page = (id, cursor) => ({
    success: true,
    result: id ? [{ id: id.repeat(64), hasStoredData: true }] : [],
    result_info: { cursor },
  });
  const pages = [page('a', 'next'), page('b', 'end'), page(null, 'end')];
  const listed = await listAllObjects(async (cursor) => {
    calls.push(cursor);
    return pages.shift();
  });
  assert.deepEqual(calls, [undefined, 'next', 'end']);
  assert.equal(listed.objects.length, 2);
  assert.equal(listed.pages, 3);
  await assert.rejects(listAllObjects(async () => page('a', 'same')));
  let count = 0;
  await assert.rejects(listAllObjects(async () => page(count++ ? 'b' : 'a', 'same')));
});

test('a stale actor version, incomplete object set or open socket prevents quiescence', () => {
  assert.equal(checkProbe(result(), expected, version, proof.nonce).size, 1);
  for (const mutate of [
    (v) => (v.versionId = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'),
    (v) => (v.objects[0].versionId = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee'),
    (v) => (v.objects[0].openSockets = 1),
    (v) => (v.objects[0].objectId = 'd'.repeat(64)),
    (v) => (v.objects = []),
    (v) => (v.nonce = 'replayed-nonce'),
  ]) {
    const bad = result();
    mutate(bad);
    assert.throws(() => checkProbe(bad, expected, version, proof.nonce));
  }
});

test('business changes or a new object fail stability while a no-op alarm can clear', () => {
  const first = {
    inventory_digest: 'objects',
    storage_digest: 'saved-business-data',
    alarm_digest: 'pending-alarm',
    version,
    checked_at: 1,
  };
  const second = { ...first, alarm_digest: 'cleared-alarm', checked_at: 2 };
  assert.equal(comparePasses(first, second).alarm_metadata_unchanged, false);
  assert.throws(() => comparePasses(first, { ...second, storage_digest: 'changed-data' }));
  assert.throws(() => comparePasses(first, { ...second, inventory_digest: 'new-object' }));
});
