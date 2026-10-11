import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import {
  acceptance,
  finishingMoves,
  socketMove,
} from '../../scripts/migration-closed-acceptance.mjs';
import { applyMove, createGame, replayGame } from '../../shared/game.ts';

test('controlled finishing games replay exactly without leaving an unfinished practice', () => {
  for (const seed of [1, 2, 0xffffffff, 12345, 987654321]) {
    const { moves, game } = finishingMoves(seed, 100);
    assert.equal(game.status, 'over');
    assert.ok(moves.length < 5000);
    assert.deepEqual(replayGame(seed, moves, 100), game);
  }
});

test('WebSocket acceptance verifies the authoritative board after exactly one accepted move', async () => {
  const game = createGame(12345, 100);
  const sent = [];
  class Socket extends EventEmitter {
    constructor(_url, options) {
      super();
      assert.equal(options.followRedirects, false);
      queueMicrotask(() =>
        this.emit(
          'message',
          Buffer.from(
            JSON.stringify({
              type: 'state',
              roomStatus: 'live',
              game,
              canControl: true,
            }),
          ),
        ),
      );
    }
    send(text) {
      sent.push(JSON.parse(text));
      if (sent.length === 2) {
        const next = applyMove(game, sent[0].direction, 101).snapshot;
        queueMicrotask(() =>
          this.emit(
            'message',
            Buffer.from(
              JSON.stringify({
                type: 'state',
                roomStatus: 'live',
                game: next,
                canControl: true,
              }),
            ),
          ),
        );
      }
    }
    close() {
      this.emit('close', 1000);
    }
    terminate() {}
  }
  const client = {
    websocket: () => ({ url: 'wss://mingcheng1024.cn/api/rooms/synthetic/ws', headers: {} }),
  };
  assert.equal(await socketMove(client, 'synthetic', Socket), true);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].seq, game.seq + 1);
  assert.equal(sent[1].seq, game.seq + 100);
});

test('WebSocket rejection reports only a safe HTTP status and clears its timer', async () => {
  class RejectedSocket extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('unexpected-response', {}, { statusCode: 403, resume() {} }));
    }
    terminate() {}
  }
  const client = {
    websocket: () => ({ url: 'wss://mingcheng1024.cn/api/rooms/synthetic/ws', headers: {} }),
  };
  await assert.rejects(socketMove(client, 'synthetic', RejectedSocket), /failed: http-403/u);
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
