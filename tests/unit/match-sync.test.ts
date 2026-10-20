import { describe, expect, it } from 'vitest';
import { createGame, projectMove } from '../../shared/game';
import { directions, type ServerPlayerState } from '../../shared/types';
import { MatchSync } from '../../src/lib/match-sync';

function setup() {
  let elapsed = 0;
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
  const state: ServerPlayerState = {
    type: 'state',
    roomId: 'room',
    roomStatus: 'live',
    serverTime: 1000,
    startsAt: 0,
    endsAt: 5000,
    syncDeadlineAt: 65_000,
    game: createGame(42, 0),
    canControl: true,
    scores: { mode: 'duel', side: 1, sideScores: { 1: 0, 2: 0 }, ownScore: 0, revision: 0 },
    settled: false,
    finalSubmitted: false,
  };
  const clock = () => elapsed;
  const sync = new MatchSync(storage, 'match:user:room', clock);
  sync.accept(state);
  return { sync, state, storage, clock, advance: (ms: number) => (elapsed += ms) };
}

function play(sync: MatchSync, count = 12) {
  for (let index = 0; index < count; index++) {
    const direction = directions.find((value) => projectMove(sync.state!.game!.board, value).moved);
    if (direction) sync.move(direction);
  }
}

describe('local match authority', () => {
  it('keeps the local board and score through stale snapshots, summaries and the end notice', () => {
    const { sync, state } = setup();
    play(sync);
    const local = sync.state!.game;
    expect(local!.score).toBeGreaterThan(0);
    sync.accept({ ...state, canControl: true });
    sync.accept({
      type: 'score-summary',
      roomId: 'room',
      scores: { ...state.scores!, revision: 2 },
    });
    sync.accept({ ...state, roomStatus: 'ended' });
    expect(sync.state!.game).toEqual(local);
    expect(sync.final).toBe(true);
    expect(sync.progress()).toMatchObject({ game: local, final: true });
  });

  it('allows disconnected play, then freezes exactly at the local deadline', () => {
    const { sync, advance } = setup();
    play(sync);
    advance(3999);
    play(sync, 1);
    const final = sync.state!.game;
    advance(1);
    play(sync);
    expect(sync.state!.game).toEqual(final);
    expect(sync.disabled).toBe(true);
    expect(sync.progress()).toMatchObject({ game: final, final: true, playedAt: 4999 });
    expect(sync.progress()).toEqual(sync.progress());
    advance(60_000);
    expect(sync.progress()).toBeNull();
    expect(sync.uploadExpired).toBe(true);
  });

  it('retries a final with no additional moves until the exact snapshot is acknowledged', () => {
    const { sync, state, advance } = setup();
    play(sync);
    const game = sync.state!.game!;
    sync.accept({ ...state, game });
    expect(sync.progress()).toBeNull();
    advance(4000);
    const final = sync.progress();
    expect(final?.final).toBe(true);
    sync.accept({ ...state, roomStatus: 'ended', game, finalSubmitted: false });
    expect(sync.progress()).toEqual(final);
    sync.accept({ ...state, roomStatus: 'ended', game, finalSubmitted: true });
    expect(sync.finalAcknowledged).toBe(true);
    expect(sync.progress()).toBeNull();
  });

  it('restores pending local progress after refresh during the upload window', () => {
    const { sync, storage, state, clock, advance } = setup();
    play(sync);
    advance(4000);
    const final = sync.progress();
    const restored = new MatchSync(storage, 'match:user:room', clock);
    restored.accept({ ...state, serverTime: 6000, roomStatus: 'ended', canControl: false }, false);
    expect(restored.state!.game).toEqual(final!.game);
    expect(restored.progress()).toBeNull();
    restored.accept({ ...state, serverTime: 6000, roomStatus: 'ended' });
    expect(restored.progress()).toEqual(final);
  });

  it('starts locally during a disconnect from countdown and never extends time from a stale reply', () => {
    const { sync, state, advance } = setup();
    const countdown = {
      ...state,
      startsAt: 2000,
      game: createGame(42, 2000),
      roomStatus: 'countdown' as const,
    };
    sync.accept(countdown);
    expect(sync.disabled).toBe(true);
    advance(1000);
    play(sync, 1);
    expect(sync.state!.game!.seq).toBe(1);
    advance(1000);
    sync.accept(countdown);
    expect(sync.now).toBe(3000);
    expect(sync.state!.game!.seq).toBe(1);
  });

  it('does not let a late HTTP response revoke socket control or overwrite the local game', () => {
    const { sync, state } = setup();
    play(sync);
    const game = sync.state!.game;
    sync.accept({ ...state, canControl: false }, false);
    expect(sync.state!.game).toEqual(game);
    expect(sync.disabled).toBe(false);
    sync.accept({ ...state, canControl: false });
    expect(sync.disabled).toBe(true);
    expect(sync.progress()).toBeNull();
  });

  it('retains local evidence when the server has settled without this final score', () => {
    const { sync, state } = setup();
    play(sync);
    const game = sync.state!.game;
    sync.accept({ ...state, settled: true, roomStatus: 'ended' });
    expect(sync.state!.game).toEqual(game);
    expect(sync.uploadExpired).toBe(true);
    expect(sync.finalAcknowledged).toBe(false);
  });

  it('recognizes a matching settled score even when the final acknowledgement was lost', () => {
    const { sync, state } = setup();
    play(sync);
    sync.accept({ ...state, game: sync.state!.game, settled: true, roomStatus: 'ended' });
    expect(sync.finalAcknowledged).toBe(true);
    expect(sync.uploadExpired).toBe(false);
  });

  it('reconnects a stalled upload even when the browser still considers the socket open', () => {
    const { sync, state, advance } = setup();
    play(sync);
    sync.sent();
    advance(7999);
    expect(sync.reconnectNeeded()).toBe(false);
    advance(1);
    expect(sync.reconnectNeeded()).toBe(true);
    expect(sync.reconnectNeeded()).toBe(false);
    sync.sent();
    sync.accept({ ...state, game: sync.state!.game });
    advance(8000);
    expect(sync.reconnectNeeded()).toBe(false);
  });
});
