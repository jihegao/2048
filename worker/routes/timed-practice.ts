import { Hono } from 'hono';
import { z } from 'zod';
import { applyMove, createGame, ENGINE_VERSION, replayGame } from '../../shared/game';
import type { Direction, GameSnapshot } from '../../shared/types';
import type { AppHonoEnv } from '../app-types';
import { uuid } from '../lib/db';
import { AppError } from '../lib/errors';

export const TIMED_DURATION_MS = 180_000;
const MAX_OPERATIONS = 5_000;

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
  started_at: number;
  deadline_at: number;
  ended_at: number;
  end_reason: 'time_limit' | 'game_over';
}

const moveSchema = z.object({
  sessionId: z.string().uuid(),
  seq: z.number().int().min(1).max(MAX_OPERATIONS),
  direction: z.enum(['up', 'down', 'left', 'right']),
});

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
  const existing = await findResult(env, row.id);
  if (existing) return existing;
  if (row.status !== 'active') return null;
  const snapshot = snapshotOf(row);
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
         score, max_tile, valid_move_count, final_board_json,
         started_at, deadline_at, ended_at, end_reason, settled_at
       ) SELECT id, id, user_id, mode, duration_seconds, engine_version,
                ?, ?, ?, ?, started_at, deadline_at, ?, ?, ?
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

timedPracticeRoutes.post('/move', async (c) => {
  const parsed = moveSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '限时操作格式无效');
  const { sessionId, seq, direction } = parsed.data;
  const receivedAt = Date.now();
  const row = await findSession(c.env, sessionId, c.get('user').id);
  if (!row) throw new AppError(404, 'TIMED_SESSION_NOT_FOUND', '限时练习不存在');
  if (row.engine_version !== ENGINE_VERSION) {
    throw new AppError(409, 'TIMED_ENGINE_CHANGED', '限时练习引擎版本已变更');
  }
  if (row.status === 'settled' || receivedAt >= row.deadline_at) {
    return c.json(await settledOrActive(c.env, row, receivedAt));
  }
  const previousMoves = movesOf(row);
  if (seq <= row.seq) {
    if (previousMoves[seq - 1]?.direction !== direction) {
      throw new AppError(409, 'TIMED_SEQUENCE_CONFLICT', '限时操作序号冲突');
    }
    return c.json({ status: 'active', session: sessionJson(row) });
  }
  if (seq !== row.seq + 1) throw new AppError(409, 'TIMED_SEQUENCE_GAP', '限时操作序号不连续');
  if (snapshotOf(row).status === 'over')
    return c.json(await settledOrActive(c.env, row, receivedAt));
  const moves = [...previousMoves, { direction, receivedAt }];
  const nextSnapshot = applyMove(snapshotOf(row), direction, receivedAt).snapshot;
  const update = await c.env.DB.prepare(
    `UPDATE timed_practice_sessions SET seq = ?, moves_json = ?, snapshot_json = ?
     WHERE id = ? AND user_id = ? AND seq = ? AND status = 'active' AND deadline_at > ?`,
  )
    .bind(
      seq,
      JSON.stringify(moves),
      JSON.stringify(nextSnapshot),
      row.id,
      row.user_id,
      row.seq,
      receivedAt,
    )
    .run();
  if (update.meta.changes === 0) {
    const latest = await findSession(c.env, row.id, row.user_id);
    if (!latest) throw new AppError(404, 'TIMED_SESSION_NOT_FOUND', '限时练习不存在');
    if (latest.seq >= seq && movesOf(latest)[seq - 1]?.direction === direction) {
      return c.json(await settledOrActive(c.env, latest, Date.now()));
    }
    throw new AppError(409, 'TIMED_SEQUENCE_CONFLICT', '限时操作冲突，请同步棋盘后重试');
  }
  const updated = {
    ...row,
    seq,
    moves_json: JSON.stringify(moves),
    snapshot_json: JSON.stringify(nextSnapshot),
  };
  return c.json(await settledOrActive(c.env, updated, receivedAt));
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
         score, max_tile, valid_move_count, final_board_json,
         started_at, deadline_at, ended_at, end_reason, settled_at
       )
       SELECT s.id, s.id, s.user_id, s.mode, s.duration_seconds, s.engine_version,
              json_extract(s.snapshot_json, '$.score'),
              json_extract(s.snapshot_json, '$.maxTile'),
              json_extract(s.snapshot_json, '$.moveCount'),
              json_extract(s.snapshot_json, '$.board'),
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
