import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyMove, createGame } from '../../shared/game';
import type { Direction } from '../../shared/types';
import type { TimedBatch, TimedResponse, TimedSession } from '../../shared/timed-practice';
import { TimedPracticeSync } from '../../src/lib/timed-practice-sync';

const clients: TimedPracticeSync[] = [];
afterEach(() => {
  clients.forEach((client) => client.dispose());
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  let now = 0;
  let server: TimedSession = {
    id: 'session',
    seed: 1,
    seq: 0,
    snapshot: createGame(1, 0),
    startedAt: new Date(0).toISOString(),
    deadlineAt: new Date(180_000).toISOString(),
    serverNow: new Date(0).toISOString(),
  };
  let release: ((response: TimedResponse) => void) | undefined;
  let hold = false;
  let loseResponse = false;
  const batches: TimedBatch[] = [];
  const request = vi.fn(async (path: string, init?: RequestInit): Promise<TimedResponse> => {
    if (path.endsWith('/current')) return { status: 'active', session: server };
    if (path.endsWith('/finish') || now >= 180_000)
      return {
        status: 'settled',
        result: {
          id: 'result',
          score: server.snapshot.score,
          maxTile: server.snapshot.maxTile,
          validMoveCount: server.snapshot.moveCount,
          finalBoard: server.snapshot.board,
          endedAt: new Date(180_000).toISOString(),
          endReason: 'time_limit',
        },
      };
    const batch = JSON.parse(String(init?.body)) as TimedBatch;
    batches.push(batch);
    let snapshot = server.snapshot;
    for (const [index, direction] of batch.directions.entries()) {
      if (batch.seq + index > server.seq) snapshot = applyMove(snapshot, direction, now).snapshot;
    }
    server = {
      ...server,
      snapshot,
      seq: Math.max(server.seq, batch.seq + batch.directions.length - 1),
      serverNow: new Date(now).toISOString(),
    };
    if (loseResponse) {
      loseResponse = false;
      throw new Error('lost response after commit');
    }
    const response: TimedResponse = { status: 'active', session: server };
    if (hold)
      return new Promise((resolve) => {
        release = () => resolve(response);
      });
    return response;
  });
  const client = new TimedPracticeSync(
    request,
    () => {},
    () => now,
  );
  clients.push(client);
  function move() {
    const direction = (['left', 'down', 'right', 'up'] as Direction[]).find(
      (direction) => applyMove(client.view.session!.snapshot, direction).moved,
    )!;
    client.move(direction);
    return direction;
  }
  return {
    client,
    request,
    batches,
    move,
    server: () => server,
    clock: (value: number) => {
      now = value;
    },
    hold: () => {
      hold = true;
    },
    release: () => {
      hold = false;
      release?.({ status: 'none' });
    },
    lose: () => {
      loseResponse = true;
    },
  };
}

describe('timed practice prediction and ordered upload', () => {
  it('renders several inputs before any request and keeps accepting input during a slow response', async () => {
    const s = setup();
    await s.client.start();
    s.move();
    s.move();
    s.move();
    expect(s.client.view.session?.snapshot.moveCount).toBe(3);
    expect(s.batches).toHaveLength(0);
    s.hold();
    const flushing = s.client.flush();
    expect(s.batches[0].directions).toHaveLength(3);
    s.move();
    s.move();
    const predicted = s.client.view.session!.snapshot;
    expect(predicted.moveCount).toBe(5);
    expect(s.client.disabled).toBe(false);
    s.release();
    await flushing;
    await vi.advanceTimersByTimeAsync(100);
    expect(s.client.view.session?.snapshot.board).toEqual(predicted.board);
    expect(s.server().snapshot.board).toEqual(predicted.board);
    expect(s.batches.map((batch) => batch.seq)).toEqual([1, 4]);
    expect(s.client.view.pendingCount).toBe(0);
  });

  it('retries a committed batch with identical sequence numbers after a lost response', async () => {
    const s = setup();
    await s.client.start();
    s.move();
    s.move();
    s.lose();
    await s.client.flush();
    expect(s.client.view.error).toBe('sync_retry');
    s.clock(1001);
    await s.client.flush();
    expect(s.batches[1]).toEqual(s.batches[0]);
    expect(s.server().seq).toBe(2);
    expect(s.client.view.pendingCount).toBe(0);
    expect(s.client.view.error).toBe('');
  });

  it('stops local input at the deadline and replaces unaccepted prediction with the settled score', async () => {
    const s = setup();
    await s.client.start();
    s.move();
    await s.client.flush();
    const accepted = s.server().snapshot;
    s.move();
    s.clock(180_001);
    expect(s.client.disabled).toBe(true);
    const seq = s.client.view.session!.seq;
    s.move();
    expect(s.client.view.session?.seq).toBe(seq);
    await s.client.flush();
    expect(s.client.view.result?.finalBoard).toEqual(accepted.board);
    expect(s.client.view.pendingCount).toBe(0);
  });

  it('ignores delayed responses after leaving the page', async () => {
    const s = setup();
    await s.client.start();
    s.move();
    s.hold();
    const flushing = s.client.flush();
    s.client.dispose();
    const before = s.client.view;
    s.release();
    await flushing;
    expect(s.client.view).toBe(before);
  });

  it('rebases on a confirmed cross-tab conflict and does not replay conflicting inputs', async () => {
    const s = setup();
    await s.client.start();
    s.move();
    s.request.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { code: 'TIMED_SEQUENCE_CONFLICT' }),
    );
    s.request.mockResolvedValueOnce({ status: 'active', session: s.server() });
    await s.client.flush();
    expect(s.client.view.pendingCount).toBe(0);
    expect(s.client.view.session?.snapshot.board).toEqual(s.server().snapshot.board);
  });
});
