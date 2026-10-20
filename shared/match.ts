import type { GameSnapshot, PlayerProgressMessage } from './types';

export const MATCH_SYNC_GRACE_MS = 60_000;

export function sameGame(first: GameSnapshot, second: GameSnapshot): boolean {
  return (
    first.seq === second.seq &&
    first.score === second.score &&
    first.maxTile === second.maxTile &&
    first.maxTileReachedAt === second.maxTileReachedAt &&
    first.moveCount === second.moveCount &&
    first.rngState === second.rngState &&
    first.status === second.status &&
    first.board.every((tile, index) => tile === second.board[index])
  );
}

export function isGameSnapshot(value: unknown): value is GameSnapshot {
  if (!value || typeof value !== 'object') return false;
  const game = value as GameSnapshot;
  return (
    Array.isArray(game.board) &&
    game.board.length === 16 &&
    game.board.every(
      (tile) =>
        Number.isSafeInteger(tile) &&
        (tile === 0 || (tile >= 2 && tile <= 2 ** 30 && Number.isInteger(Math.log2(tile)))),
    ) &&
    Number.isSafeInteger(game.score) &&
    game.score >= 0 &&
    game.score % 4 === 0 &&
    game.maxTile === Math.max(...game.board) &&
    Number.isSafeInteger(game.maxTileReachedAt) &&
    Number.isSafeInteger(game.seq) &&
    game.seq >= 0 &&
    game.moveCount === game.seq &&
    Number.isInteger(game.rngState) &&
    game.rngState > 0 &&
    game.rngState <= 0xffff_ffff &&
    (game.status === 'playing' || game.status === 'over')
  );
}

export function isPlayerProgress(value: unknown): value is PlayerProgressMessage {
  if (!value || typeof value !== 'object') return false;
  const message = value as PlayerProgressMessage;
  return (
    message.type === 'progress' &&
    typeof message.final === 'boolean' &&
    Number.isSafeInteger(message.playedAt) &&
    isGameSnapshot(message.game)
  );
}
