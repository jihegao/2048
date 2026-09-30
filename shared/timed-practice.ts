import type { Direction, GameSnapshot } from './types';

export const TIMED_MAX_BATCH = 64;
export const TIMED_MAX_OPERATIONS = 5_000;

export interface TimedSession {
  id: string;
  seed: number;
  seq: number;
  snapshot: GameSnapshot;
  startedAt: string;
  deadlineAt: string;
  serverNow: string;
}

export interface TimedResult {
  id: string;
  score: number;
  maxTile: number;
  validMoveCount: number;
  finalBoard: number[];
  endedAt: string;
  endReason: 'time_limit' | 'game_over';
}

export type TimedResponse =
  | { status: 'none' }
  | { status: 'active'; session: TimedSession }
  | { status: 'settled'; result: TimedResult };

export interface TimedBatch {
  sessionId: string;
  seq: number;
  directions: Direction[];
}
