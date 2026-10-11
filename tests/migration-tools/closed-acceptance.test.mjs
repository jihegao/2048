import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptance, finishingMoves } from '../../scripts/migration-closed-acceptance.mjs';
import { replayGame } from '../../shared/game.ts';

test('controlled finishing games replay exactly without leaving an unfinished practice', () => {
  for (const seed of [1, 2, 0xffffffff, 12345, 987654321]) {
    const { moves, game } = finishingMoves(seed, 100);
    assert.equal(game.status, 'over');
    assert.ok(moves.length < 5000);
    assert.deepEqual(replayGame(seed, moves, 100), game);
  }
});

test('unconfirmed acceptance cannot make a network request or create fixtures', async () => {
  const original = globalThis.fetch;
  let called = false;
  globalThis.fetch = () => {
    called = true;
    throw new Error('network must not run');
  };
  try {
    await assert.rejects(acceptance({}), { name: 'AssertionError' });
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});
