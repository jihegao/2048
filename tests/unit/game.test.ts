import { describe, expect, it } from 'vitest';
import {
  applyMove,
  createGame,
  decideWinner,
  hasMoves,
  projectMove,
  replayGame,
} from '../../shared/game';
import type { GameSnapshot } from '../../shared/types';

describe('2048 engine', () => {
  it('merges each tile only once per move', () => {
    expect(projectMove([2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'left')).toEqual({
      board: [4, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      gained: 8,
      moved: true,
    });
  });

  it('uses the same seed and moves deterministically', () => {
    const moves = ['left', 'up', 'right', 'down', 'left'] as const;
    expect(replayGame(12345, [...moves], 1000)).toEqual(replayGame(12345, [...moves], 1000));
    expect(createGame(12345, 1000)).toEqual(createGame(12345, 1000));
  });

  it('does not spawn a tile after an invalid move', () => {
    const snapshot: GameSnapshot = {
      board: [2, 4, 8, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      score: 0,
      maxTile: 16,
      maxTileReachedAt: 1,
      moveCount: 0,
      rngState: 42,
      seq: 0,
      status: 'playing',
    };
    expect(applyMove(snapshot, 'left', 2)).toEqual({ snapshot, moved: false, gained: 0 });
  });

  it('recognizes a board with no legal moves', () => {
    expect(hasMoves([2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2])).toBe(false);
  });
});

describe('winner calculation', () => {
  it('uses total score before highest tile', () => {
    expect(
      decideWinner(
        { side: 1, score: 4000, maxTile: 256, maxTileReachedAt: 100 },
        { side: 2, score: 3900, maxTile: 512, maxTileReachedAt: 90 },
      ),
    ).toBe(1);
  });

  it('uses highest tile and then earliest server time', () => {
    expect(
      decideWinner(
        { side: 1, score: 4000, maxTile: 512, maxTileReachedAt: 110 },
        { side: 2, score: 4000, maxTile: 512, maxTileReachedAt: 100 },
      ),
    ).toBe(2);
  });

  it('declares a draw only when every tie-breaker is equal', () => {
    expect(
      decideWinner(
        { side: 1, score: 4000, maxTile: 512, maxTileReachedAt: 100 },
        { side: 2, score: 4000, maxTile: 512, maxTileReachedAt: 100 },
      ),
    ).toBe('draw');
  });
});
