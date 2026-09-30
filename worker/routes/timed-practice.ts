import { Hono } from 'hono';
import { z } from 'zod';
import { applyMove, createGame, ENGINE_VERSION, replayGame } from '../../shared/game';
import type { Direction, GameSnapshot } from '../../shared/types';
import {
  TIMED_MAX_BATCH,
  TIMED_MAX_OPERATIONS,
  type TimedBatch,
} from '../../shared/timed-practice';
import type { AppHonoEnv } from '../app-types';
import { uuid } from '../lib/db';
import { AppError } from '../lib/errors';

export const TIMED_DURATION_MS = 180_000;

interface TimedMove {
  direction: Direction;
  receivedAt: number;
}

interface TimedSessionRow {
  id: string;
  user_id: string;
  mode: 'timed_3m';
  duration_seconds: number;
  engine_version: string;
  seed: number;
  started_at: number;
  deadline_at: number;
  seq: number;
  moves_json: string;
  snapshot_json: string;
  status: 'active' | 'settled';
}

interface TimedResultRow {
  id: string;
  score: number;
  max_tile: number;
  valid_move_count: number;
  final_board_json: string;
  grade_at_completion: string | null;
  started_at: number;
  deadline_at: number;
  ended_at: number;
  end_reason: 'time_limit' | 'game_over';
}

const moveSchema = z.object({
  sessionId: z.string().uuid(),
  seq: z.number().int().min(1).max(TIMED_MAX_OPERATIONS),
  direction: z.enum(['up', 'down', 'left', 'right']),
});

const batchSchema = moveSchema
  .omit({ direction: true })
  .extend({
    directions: z.array(moveSchema.shape.direction).min(1).max(TIMED_MAX_BATCH),
  })
  .refine((batch) => batch.seq + batch.directions.length - 1 <= TIMED_MAX_OPERATIONS);

function movesOf(row: TimedSessionRow): TimedMove[] {
  return JSON.parse(row.moves_json) as TimedMove[];
}

function snapshotOf(row: TimedSessionRow): GameSnapshot {
  return JSON.parse(row.snapshot_json) as GameSnapshot;
}

async function findSession(env: Env, id: string, userId?: string): Promise<TimedSessionRow | null> {
  const statement = env.DB.prepare(
    `SELECT * FROM timed_practice_sessions WHERE id = ? ${userId ? 'AND user_id = ?' : ''}`,
  );
  return statement.bind(...(userId ? [id, userId] : [id])).first<TimedSessionRow>();
}

async function findResult(env: Env, sessionId: string): Promise<TimedResultRow | null> {
  return env.DB.prepare('SELECT * FROM timed_practice_results WHERE session_id = ?')
    .bind(sessionId)
    .first<TimedResultRow>();
}

function resultJson(row: TimedResultRow) {
  return {
    id: row.id,
    mode: 'timed_3m' as const,
    durationSeconds: 180,
    score: row.score,
    maxTile: row.max_tile,
    validMoveCount: row.valid_move_count,
    finalBoard: JSON.parse(row.final_board_json) as number[],
    startedAt: new Date(row.started_at).toISOString(),
    deadlineAt: new Date(row.deadline_at).toISOString(),
    serverNow: new Date().toISOString(),
    endedAt: new Date(row.ended_at).toISOString(),
    endReason: row.end_reason,
  };
}

function sessionJson(row: TimedSessionRow) {
  return {
    id: row.id,
    mode: row.mode,
    durationSeconds: row.duration_seconds,
    seed: row.seed,
    startedAt: new Date(row.started_at).toISOString(),
    deadlineAt: new Date(row.deadline_at).toISOString(),
    serverNow: new Date().toISOString(),
    seq: row.seq,
    snapshot: snapshotOf(row),
  };
}

/** The INSERT and status transition run in one D1 transaction. The sequence guard
 * prevents a stale replay from settling while a newer accepted operation exists. */
export async function settleTimedSession(
  env: Env,
  row: TimedSessionRow,
  now: number,
): Promise<TimedResultRow | null> {
  // Active games already have an authoritative snapshot. Replay only at settlement,
  // not once per input (which made a whole game quadratic in its move count).
  const snapshot = snapshotOf(row);
  if (row.status === 'active' && snapshot.status !== 'over' && now < row.deadline_at) return null;
  const existing = await findResult(env, row.id);
  if (existing) return existing;
  if (row.status !== 'active') return null;
  if (row.engine_version === ENGINE_VERSION) {
    const replayed = replayGame(
      row.seed,
      movesOf(row).map((move) => move.direction),
      row.started_at,
    );
    if (
      replayed.score !== snapshot.score ||
      JSON.stringify(replayed.board) !== JSON.stringify(snapshot.board)
    ) {
      throw new AppError(500, 'TIMED_REPLAY_MISMATCH', '限时练习重放校验失败');
    }
  }
  const reason = snapshot.status === 'over' ? 'game_over' : 'time_limit';
  if (reason === 'time_limit' && now < row.deadline_at) return null;
  const endedAt =
    reason === 'game_over' ? (movesOf(row).at(-1)?.receivedAt ?? row.started_at) : row.deadline_at;
  const result = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO timed_practice_results (
         id, session_id, user_id, mode, duration_seconds, engine_version,
         score, max_tile, valid_move_count, final_board_json, grade_at_completion,
         started_at, deadline_at, ended_at, end_reason, settled_at
       ) SELECT id, id, user_id, mode, duration_seconds, engine_version,
                ?, ?, ?, ?,
                (SELECT ranking_grade FROM student_grade_resolution WHERE user_id = timed_practice_sessions.user_id),
                started_at, deadline_at, ?, ?, ?
         FROM timed_practice_sessions
         WHERE id = ? AND seq = ? AND status = 'active'
         ON CONFLICT(session_id) DO NOTHING`,
    ).bind(
      snapshot.score,
      snapshot.maxTile,
      snapshot.moveCount,
      JSON.stringify(snapshot.board),
      endedAt,
      reason,
      now,
      row.id,
      row.seq,
    ),
    env.DB.prepare(
      `UPDATE timed_practice_sessions SET status = 'settled', settled_at = ?
       WHERE id = ? AND status = 'active'
         AND EXISTS (SELECT 1 FROM timed_practice_results WHERE session_id = ?)`,
    ).bind(now, row.id, row.id),
  ]);
  if (result[0].meta.changes === 0) return findResult(env, row.id);
  return findResult(env, row.id);
}

async function settledOrActive(env: Env, row: TimedSessionRow, now: number) {
  const result = await settleTimedSession(env, row, now);
  return result
    ? { status: 'settled' as const, result: resultJson(result) }
    : { status: 'active' as const, session: sessionJson(row) };
}

export const timedPracticeRoutes = new Hono<AppHonoEnv>();

timedPracticeRoutes.post('/start', async (c) => {
  const userId = c.get('user').id;
  const now = Date.now();
  const current = await c.env.DB.prepare(
    `SELECT * FROM timed_practice_sessions WHERE user_id = ? AND status = 'active' LIMIT 1`,
  )
    .bind(userId)
    .first<TimedSessionRow>();
  if (current) {
    const state = await settledOrActive(c.env, current, now);
    if (state.status === 'active') return c.json(state);
  }
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  const row: TimedSessionRow = {
    id: uuid(),
    user_id: userId,
    mode: 'timed_3m',
    duration_seconds: 180,
    engine_version: ENGINE_VERSION,
    seed: random[0] || 1,
    started_at: Date.now(),
    deadline_at: 0,
    seq: 0,
    moves_json: '[]',
    snapshot_json: '',
    status: 'active',
  };
  row.deadline_at = row.started_at + TIMED_DURATION_MS;
  row.snapshot_json = JSON.stringify(createGame(row.seed, row.started_at));
  try {
    await c.env.DB.prepare(
      `INSERT INTO timed_practice_sessions (
         id, user_id, mode, duration_seconds, engine_version, seed,
         started_at, deadline_at, seq, moves_json, snapshot_json, status
       ) VALUES (?, ?, 'timed_3m', 180, ?, ?, ?, ?, 0, '[]', ?, 'active')`,
    )
      .bind(
        row.id,
        row.user_id,
        row.engine_version,
        row.seed,
        row.started_at,
        row.deadline_at,
        row.snapshot_json,
      )
      .run();
  } catch {
    const concurrent = await c.env.DB.prepare(
      `SELECT * FROM timed_practice_sessions WHERE user_id = ? AND status = 'active' LIMIT 1`,
    )
      .bind(userId)
      .first<TimedSessionRow>();
    if (!concurrent) throw new AppError(503, 'TIMED_START_RETRY', '请重试开始限时练习');
    return c.json(await settledOrActive(c.env, concurrent, Date.now()));
  }
  return c.json({ status: 'active', session: sessionJson(row) });
});

timedPracticeRoutes.get('/current', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT * FROM timed_practice_sessions WHERE user_id = ? AND status = 'active' LIMIT 1`,
  )
    .bind(c.get('user').id)
    .first<TimedSessionRow>();
  if (!row) return c.json({ status: 'none' });
  return c.json(await settledOrActive(c.env, row, Date.now()));
});

async function acceptMoves(env: Env, userId: string, batch: TimedBatch, receivedAt: number) {
  const { sessionId, seq, directions } = batch;
  const row = await findSession(env, sessionId, userId);
  if (!row) throw new AppError(404, 'TIMED_SESSION_NOT_FOUND', '限时练习不存在');
  if (row.engine_version !== ENGINE_VERSION) {
    throw new AppError(409, 'TIMED_ENGINE_CHANGED', '限时练习引擎版本已变更');
  }
  if (row.status === 'settled' || receivedAt >= row.deadline_at) {
    return settledOrActive(env, row, receivedAt);
  }
  const previousMoves = movesOf(row);
  // A response may be lost after commit. Accept matching duplicate prefixes and
  // append only the unseen suffix; never count a retried batch twice.
  const duplicateCount = Math.min(directions.length, Math.max(0, row.seq - seq + 1));
  for (let index = 0; index < duplicateCount; index += 1) {
    if (previousMoves[seq + index - 1]?.direction !== directions[index]) {
      throw new AppError(409, 'TIMED_SEQUENCE_CONFLICT', '限时操作序号冲突');
    }
  }
  if (duplicateCount === directions.length) return settledOrActive(env, row, receivedAt);
  if (seq + duplicateCount !== row.seq + 1)
    throw new AppError(409, 'TIMED_SEQUENCE_GAP', '限时操作序号不连续');
  if (snapshotOf(row).status === 'over') return settledOrActive(env, row, receivedAt);
  const moves = [...previousMoves];
  let nextSnapshot = snapshotOf(row);
  for (const direction of directions.slice(duplicateCount)) {
    moves.push({ direction, receivedAt });
    nextSnapshot = applyMove(nextSnapshot, direction, receivedAt).snapshot;
    if (nextSnapshot.status === 'over') break;
  }
  const nextSeq = moves.length;
  const update = await env.DB.prepare(
    `UPDATE timed_practice_sessions SET seq = ?, moves_json = ?, snapshot_json = ?
     WHERE id = ? AND user_id = ? AND seq = ? AND status = 'active' AND deadline_at > ?`,
  )
    .bind(
      nextSeq,
      JSON.stringify(moves),
      JSON.stringify(nextSnapshot),
      row.id,
      row.user_id,
      row.seq,
      receivedAt,
    )
    .run();
  if (update.meta.changes === 0) {
    const latest = await findSession(env, row.id, row.user_id);
    if (!latest) throw new AppError(404, 'TIMED_SESSION_NOT_FOUND', '限时练习不存在');
    if (latest.status === 'settled') return settledOrActive(env, latest, Date.now());
    if (
      latest.seq >= nextSeq &&
      directions
        .slice(0, nextSeq - seq + 1)
        .every((direction, index) => movesOf(latest)[seq + index - 1]?.direction === direction)
    ) {
      return settledOrActive(env, latest, Date.now());
    }
    throw new AppError(409, 'TIMED_SEQUENCE_CONFLICT', '限时操作冲突，请同步棋盘后重试');
  }
  const updated = {
    ...row,
    seq: nextSeq,
    moves_json: JSON.stringify(moves),
    snapshot_json: JSON.stringify(nextSnapshot),
  };
  return settledOrActive(env, updated, receivedAt);
}

// Retain the old endpoint for tabs loaded before this release.
timedPracticeRoutes.post('/move', async (c) => {
  const parsed = moveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '限时操作格式无效');
  const { direction, ...batch } = parsed.data;
  return c.json(
    await acceptMoves(c.env, c.get('user').id, { ...batch, directions: [direction] }, Date.now()),
  );
});

timedPracticeRoutes.post('/moves', async (c) => {
  const parsed = batchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '限时操作格式无效');
  return c.json(await acceptMoves(c.env, c.get('user').id, parsed.data, Date.now()));
});

timedPracticeRoutes.post('/finish', async (c) => {
  const parsed = z
    .object({ sessionId: z.string().uuid() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '限时练习凭据无效');
  const row = await findSession(c.env, parsed.data.sessionId, c.get('user').id);
  if (!row) throw new AppError(404, 'TIMED_SESSION_NOT_FOUND', '限时练习不存在');
  return c.json(await settledOrActive(c.env, row, Date.now()));
});

export async function settleExpiredTimedSessions(env: Env): Promise<number> {
  const now = Date.now();
  // Each snapshot was computed on the server and atomically persisted with its
  // accepted operation. Bulk settlement keeps the cron within D1 request limits.
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO timed_practice_results (
         id, session_id, user_id, mode, duration_seconds, engine_version,
         score, max_tile, valid_move_count, final_board_json, grade_at_completion,
         started_at, deadline_at, ended_at, end_reason, settled_at
       )
       SELECT s.id, s.id, s.user_id, s.mode, s.duration_seconds, s.engine_version,
              json_extract(s.snapshot_json, '$.score'),
              json_extract(s.snapshot_json, '$.maxTile'),
              json_extract(s.snapshot_json, '$.moveCount'),
              json_extract(s.snapshot_json, '$.board'),
              (SELECT ranking_grade FROM student_grade_resolution WHERE user_id = s.user_id),
              s.started_at, s.deadline_at,
              CASE WHEN json_extract(s.snapshot_json, '$.status') = 'over'
                THEN COALESCE(json_extract(s.moves_json, '$[#-1].receivedAt'), s.started_at)
                ELSE s.deadline_at END,
              CASE WHEN json_extract(s.snapshot_json, '$.status') = 'over'
                THEN 'game_over' ELSE 'time_limit' END, ?
       FROM timed_practice_sessions s
       WHERE s.status = 'active' AND s.deadline_at <= ?
       ORDER BY s.deadline_at, s.id LIMIT 500
       ON CONFLICT(session_id) DO NOTHING`,
    ).bind(now, now),
    env.DB.prepare(
      `UPDATE timed_practice_sessions SET status = 'settled', settled_at = ?
       WHERE status = 'active' AND deadline_at <= ?
         AND EXISTS (SELECT 1 FROM timed_practice_results r WHERE r.session_id = timed_practice_sessions.id)`,
    ).bind(now, now),
  ]);
  return results[0].meta.changes;
}
