import type { Direction, GameSnapshot } from './types';

export const BOARD_SIZE = 4;
export const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;
export const ENGINE_VERSION = '1.0.0';

export interface MoveResult {
  snapshot: GameSnapshot;
  moved: boolean;
  gained: number;
}

function normalizeSeed(seed: number): number {
  const normalized = seed >>> 0;
  return normalized === 0 ? 0x6d2b79f5 : normalized;
}

export function nextRandom(state: number): { value: number; state: number } {
  let next = normalizeSeed(state);
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  next >>>= 0;
  return { value: next / 0x1_0000_0000, state: normalizeSeed(next) };
}

function spawnTile(board: number[], rngState: number): { board: number[]; rngState: number } {
  const empty: number[] = [];
  for (let index = 0; index < board.length; index += 1) {
    if (board[index] === 0) empty.push(index);
  }
  if (empty.length === 0) return { board, rngState };

  const positionRandom = nextRandom(rngState);
  const valueRandom = nextRandom(positionRandom.state);
  const emptyIndex = Math.min(empty.length - 1, Math.floor(positionRandom.value * empty.length));
  const nextBoard = board.slice();
  nextBoard[empty[emptyIndex]] = valueRandom.value < 0.9 ? 2 : 4;
  return { board: nextBoard, rngState: valueRandom.state };
}

export function createGame(seed: number, now = Date.now()): GameSnapshot {
  const first = spawnTile(Array<number>(BOARD_CELLS).fill(0), normalizeSeed(seed));
  const second = spawnTile(first.board, first.rngState);
  return {
    board: second.board,
    score: 0,
    maxTile: Math.max(...second.board),
    maxTileReachedAt: now,
    moveCount: 0,
    rngState: second.rngState,
    seq: 0,
    status: 'playing',
  };
}

function collapseLine(line: number[]): { line: number[]; gained: number } {
  const compact = line.filter((value) => value !== 0);
  const result: number[] = [];
  let gained = 0;
  for (let index = 0; index < compact.length; index += 1) {
    if (compact[index] === compact[index + 1]) {
      const merged = compact[index] * 2;
      result.push(merged);
      gained += merged;
      index += 1;
    } else {
      result.push(compact[index]);
    }
  }
  while (result.length < BOARD_SIZE) result.push(0);
  return { line: result, gained };
}

function readLine(board: number[], direction: Direction, lineIndex: number): number[] {
  const values: number[] = [];
  for (let offset = 0; offset < BOARD_SIZE; offset += 1) {
    if (direction === 'left') values.push(board[lineIndex * BOARD_SIZE + offset]);
    if (direction === 'right')
      values.push(board[lineIndex * BOARD_SIZE + (BOARD_SIZE - 1 - offset)]);
    if (direction === 'up') values.push(board[offset * BOARD_SIZE + lineIndex]);
    if (direction === 'down')
      values.push(board[(BOARD_SIZE - 1 - offset) * BOARD_SIZE + lineIndex]);
  }
  return values;
}

function writeLine(board: number[], direction: Direction, lineIndex: number, line: number[]): void {
  for (let offset = 0; offset < BOARD_SIZE; offset += 1) {
    if (direction === 'left') board[lineIndex * BOARD_SIZE + offset] = line[offset];
    if (direction === 'right')
      board[lineIndex * BOARD_SIZE + (BOARD_SIZE - 1 - offset)] = line[offset];
    if (direction === 'up') board[offset * BOARD_SIZE + lineIndex] = line[offset];
    if (direction === 'down')
      board[(BOARD_SIZE - 1 - offset) * BOARD_SIZE + lineIndex] = line[offset];
  }
}

export function projectMove(
  board: number[],
  direction: Direction,
): {
  board: number[];
  gained: number;
  moved: boolean;
} {
  if (board.length !== BOARD_CELLS) throw new Error('棋盘数据无效');
  const nextBoard = board.slice();
  let gained = 0;
  for (let lineIndex = 0; lineIndex < BOARD_SIZE; lineIndex += 1) {
    const collapsed = collapseLine(readLine(board, direction, lineIndex));
    gained += collapsed.gained;
    writeLine(nextBoard, direction, lineIndex, collapsed.line);
  }
  return {
    board: nextBoard,
    gained,
    moved: nextBoard.some((value, index) => value !== board[index]),
  };
}

export function hasMoves(board: number[]): boolean {
  if (board.some((value) => value === 0)) return true;
  return (['up', 'down', 'left', 'right'] as const).some(
    (direction) => projectMove(board, direction).moved,
  );
}

export function applyMove(
  snapshot: GameSnapshot,
  direction: Direction,
  now = Date.now(),
): MoveResult {
  if (snapshot.status === 'over') return { snapshot, moved: false, gained: 0 };
  const projected = projectMove(snapshot.board, direction);
  if (!projected.moved) {
    const status = hasMoves(snapshot.board) ? 'playing' : 'over';
    return { snapshot: { ...snapshot, status }, moved: false, gained: 0 };
  }

  const spawned = spawnTile(projected.board, snapshot.rngState);
  const maxTile = Math.max(...spawned.board);
  const next: GameSnapshot = {
    ...snapshot,
    board: spawned.board,
    score: snapshot.score + projected.gained,
    maxTile,
    maxTileReachedAt: maxTile > snapshot.maxTile ? now : snapshot.maxTileReachedAt,
    moveCount: snapshot.moveCount + 1,
    rngState: spawned.rngState,
    seq: snapshot.seq + 1,
    status: hasMoves(spawned.board) ? 'playing' : 'over',
  };
  return { snapshot: next, moved: true, gained: projected.gained };
}

export function replayGame(seed: number, moves: Direction[], startedAt = 0): GameSnapshot {
  return moves.reduce(
    (snapshot, direction, index) => applyMove(snapshot, direction, startedAt + index + 1).snapshot,
    createGame(seed, startedAt),
  );
}

export interface SideStanding {
  side: 1 | 2;
  score: number;
  maxTile: number;
  maxTileReachedAt: number;
}

export function decideWinner(first: SideStanding, second: SideStanding): 1 | 2 | 'draw' {
  if (first.score !== second.score) return first.score > second.score ? first.side : second.side;
  if (first.maxTile !== second.maxTile) {
    return first.maxTile > second.maxTile ? first.side : second.side;
  }
  if (first.maxTileReachedAt !== second.maxTileReachedAt) {
    return first.maxTileReachedAt < second.maxTileReachedAt ? first.side : second.side;
  }
  return 'draw';
}
