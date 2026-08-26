import { Hono, type Context } from 'hono';
import type { RoomMode, RoomStatus } from '../../shared/types';
import type { AppHonoEnv } from '../app-types';
import { roomCode, uuid } from '../lib/db';
import { AppError, zodIssues } from '../lib/errors';
import { paginationSchema, roomInputSchema, roomPatchSchema } from '../schemas';

interface RoomListRow {
  id: string;
  code: string;
  name: string;
  mode: RoomMode;
  duration_minutes: number;
  status: RoomStatus;
  locked_at: number | null;
  starts_at: number | null;
  ends_at: number | null;
  created_at: number;
  entry_count: number;
  is_participant?: number;
}

function serializeRoom(row: RoomListRow) {
  const multiplier = row.mode === 'duel' ? 1 : 3;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    mode: row.mode,
    durationMinutes: row.duration_minutes,
    status: row.status,
    isParticipant: Boolean(row.is_participant),
    participantCount: row.entry_count * multiplier,
    participantCapacity: row.mode === 'duel' ? 2 : 6,
    lockedAt: row.locked_at ? new Date(row.locked_at).toISOString() : null,
    startsAt: row.starts_at ? new Date(row.starts_at).toISOString() : null,
    endsAt: row.ends_at ? new Date(row.ends_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function roomStub(env: Env, roomId: string): DurableObjectStub {
  return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

async function callRoom(
  env: Env,
  roomId: string,
  action: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return roomStub(env, roomId).fetch(`https://room.internal/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Room-Id': roomId },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function roomDetail(env: Env, roomId: string) {
  const room = await env.DB.prepare(
    `SELECT r.id, r.code, r.name, r.mode, r.duration_minutes, r.status, r.locked_at,
            r.starts_at, r.ends_at, r.created_at, COUNT(re.side) AS entry_count
     FROM rooms r LEFT JOIN room_entries re ON re.room_id = r.id
     WHERE r.id = ? GROUP BY r.id`,
  )
    .bind(roomId)
    .first<RoomListRow>();
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '房间不存在');
  const entries = await env.DB.prepare(
    `SELECT re.side, re.student_id, re.team_id, re.joined_at,
            u.student_no, u.display_name, u.class_name,
            t.name AS team_name, t.code AS team_code
     FROM room_entries re
     LEFT JOIN users u ON u.id = re.student_id
     LEFT JOIN teams t ON t.id = re.team_id
     WHERE re.room_id = ? ORDER BY re.side`,
  )
    .bind(roomId)
    .all();
  return { ...serializeRoom(room), entries: entries.results };
}

async function listRooms(c: Context<AppHonoEnv>) {
  const parsed = paginationSchema
    .extend({
      status: paginationSchema.shape.query.optional(),
      mode: paginationSchema.shape.query.optional(),
    })
    .safeParse(c.req.query());
  if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '查询参数无效');
  const { page, pageSize, query, status, mode } = parsed.data;
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (query) {
    clauses.push("(r.name LIKE ? ESCAPE '\\' OR r.code LIKE ? ESCAPE '\\')");
    const search = `%${query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    binds.push(search, search);
  }
  if (status) {
    clauses.push('r.status = ?');
    binds.push(status);
  }
  if (mode) {
    clauses.push('r.mode = ?');
    binds.push(mode);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const offset = (page - 1) * pageSize;
  const [items, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.id, r.code, r.name, r.mode, r.duration_minutes, r.status, r.locked_at,
              r.starts_at, r.ends_at, r.created_at, COUNT(re.side) AS entry_count,
              EXISTS (
                SELECT 1 FROM active_participations ap
                WHERE ap.room_id = r.id AND ap.user_id = ?
              ) AS is_participant
       FROM rooms r LEFT JOIN room_entries re ON re.room_id = r.id
       ${where} GROUP BY r.id
       ORDER BY is_participant DESC, r.created_at DESC LIMIT ? OFFSET ?`,
    )
      .bind(c.get('user').id, ...binds, pageSize, offset)
      .all<RoomListRow>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM rooms r ${where}`)
      .bind(...binds)
      .first<{ count: number }>(),
  ]);
  return c.json({
    items: items.results.map(serializeRoom),
    total: count?.count ?? 0,
    page,
    pageSize,
  });
}

export const teacherRoomRoutes = new Hono<AppHonoEnv>();

teacherRoomRoutes.get('/', listRooms);

teacherRoomRoutes.post('/', async (c) => {
  const parsed = roomInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new AppError(422, 'VALIDATION_ERROR', '房间设置无效', zodIssues(parsed.error.issues));
  const roomId = uuid();
  const now = Date.now();
  let created = false;
  for (let attempt = 0; attempt < 3 && !created; attempt += 1) {
    try {
      await c.env.DB.prepare(
        `INSERT INTO rooms (
           id, code, name, mode, duration_minutes, status, created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
      )
        .bind(
          roomId,
          roomCode(),
          parsed.data.name,
          parsed.data.mode,
          parsed.data.durationMinutes,
          c.get('user').id,
          now,
          now,
        )
        .run();
      created = true;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
  return c.json({ room: await roomDetail(c.env, roomId), message: '房间已创建' }, 201);
});

teacherRoomRoutes.get('/:id', async (c) =>
  c.json({ room: await roomDetail(c.env, c.req.param('id')) }),
);

teacherRoomRoutes.patch('/:id', async (c) => {
  const parsed = roomPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success)
    throw new AppError(422, 'VALIDATION_ERROR', '房间设置无效', zodIssues(parsed.error.issues));
  const room = await c.env.DB.prepare('SELECT status, locked_at FROM rooms WHERE id = ?')
    .bind(c.req.param('id'))
    .first<{ status: RoomStatus; locked_at: number | null }>();
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '房间不存在');
  if (room.status !== 'open' || room.locked_at !== null) {
    throw new AppError(409, 'ROOM_LOCKED', '首名参赛者加入后，模式和时长不能修改');
  }
  const updates: string[] = [];
  const binds: unknown[] = [];
  if (parsed.data.name !== undefined) {
    updates.push('name = ?');
    binds.push(parsed.data.name);
  }
  if (parsed.data.mode !== undefined) {
    updates.push('mode = ?');
    binds.push(parsed.data.mode);
  }
  if (parsed.data.durationMinutes !== undefined) {
    updates.push('duration_minutes = ?');
    binds.push(parsed.data.durationMinutes);
  }
  updates.push('updated_at = ?');
  binds.push(Date.now(), c.req.param('id'));
  await c.env.DB.prepare(`UPDATE rooms SET ${updates.join(', ')} WHERE id = ?`)
    .bind(...binds)
    .run();
  return c.json({ room: await roomDetail(c.env, c.req.param('id')), message: '房间设置已保存' });
});

teacherRoomRoutes.post('/:id/start', async (c) => callRoom(c.env, c.req.param('id'), 'start'));
teacherRoomRoutes.post('/:id/cancel', async (c) => callRoom(c.env, c.req.param('id'), 'cancel'));

teacherRoomRoutes.get('/:id/live', async (c) => {
  const roomId = c.req.param('id');
  return roomStub(c.env, roomId).fetch('https://room.internal/snapshot', {
    headers: { 'X-Room-Id': roomId, 'X-Role': 'teacher', 'X-User-Id': c.get('user').id },
  });
});

export const studentRoomRoutes = new Hono<AppHonoEnv>();

studentRoomRoutes.get('/', listRooms);
studentRoomRoutes.get('/:id', async (c) =>
  c.json({ room: await roomDetail(c.env, c.req.param('id')) }),
);
studentRoomRoutes.post('/:id/join', async (c) =>
  callRoom(c.env, c.req.param('id'), 'join', { userId: c.get('user').id }),
);
studentRoomRoutes.post('/:id/leave', async (c) =>
  callRoom(c.env, c.req.param('id'), 'leave', { userId: c.get('user').id }),
);
studentRoomRoutes.get('/:id/match', async (c) => {
  const roomId = c.req.param('id');
  const participant = await c.env.DB.prepare(
    'SELECT 1 FROM active_participations WHERE room_id = ? AND user_id = ? LIMIT 1',
  )
    .bind(roomId, c.get('user').id)
    .first();
  if (!participant) throw new AppError(403, 'NOT_A_PARTICIPANT', '你不是该房间的参赛者');
  return roomStub(c.env, roomId).fetch('https://room.internal/snapshot', {
    headers: { 'X-Room-Id': roomId, 'X-Role': 'student', 'X-User-Id': c.get('user').id },
  });
});

export async function roomWebSocket(c: Context<AppHonoEnv>) {
  const roomId = c.req.param('id');
  if (!roomId) throw new AppError(404, 'ROOM_NOT_FOUND', '房间不存在');
  const user = c.get('user');
  if (user.role === 'student') {
    const participant = await c.env.DB.prepare(
      'SELECT 1 FROM active_participations WHERE room_id = ? AND user_id = ? LIMIT 1',
    )
      .bind(roomId, user.id)
      .first();
    if (!participant) throw new AppError(403, 'NOT_A_PARTICIPANT', '你不是该房间的参赛者');
  } else {
    const room = await c.env.DB.prepare('SELECT 1 FROM rooms WHERE id = ? LIMIT 1')
      .bind(roomId)
      .first();
    if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '房间不存在');
  }
  const headers = new Headers(c.req.raw.headers);
  headers.set('X-Room-Id', roomId);
  headers.set('X-Role', user.role);
  headers.set('X-User-Id', user.id);
  return roomStub(c.env, roomId).fetch('https://room.internal/ws', {
    method: 'GET',
    headers,
  });
}
