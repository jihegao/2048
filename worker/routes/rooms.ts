import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { RoomMode, RoomStatus } from '../../shared/types';
import type { AppHonoEnv } from '../app-types';
import { roomCode, uuid } from '../lib/db';
import { AppError, zodIssues } from '../lib/errors';
import { getTeamGradeResolution, type TeamGroup } from '../lib/grade-groups';
import { openTeamPracticePeriod } from '../lib/team-practice-periods';
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
  student_created: number;
  team_group: TeamGroup | null;
  team_practice_period_id: string | null;
  creator_team_id: string | null;
  created_by: string;
  self_room_expires_at: number | null;
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
    createdBy: row.created_by,
    creatorTeamId: row.creator_team_id,
    studentCreated: Boolean(row.student_created),
    teamGroup: row.team_group,
    teamPracticePeriodId: row.team_practice_period_id,
    selfRoomExpiresAt: row.self_room_expires_at
      ? new Date(row.self_room_expires_at).toISOString()
      : null,
  };
}

async function studentTeam(
  env: Env,
  userId: string,
): Promise<{ id: string; group: TeamGroup } | null> {
  const membership = await env.DB.prepare('SELECT team_id FROM team_members WHERE user_id = ?')
    .bind(userId)
    .first<{ team_id: string }>();
  if (!membership) return null;
  const resolution = await getTeamGradeResolution(env.DB, membership.team_id);
  return resolution.memberCount === 3 && resolution.group
    ? { id: membership.team_id, group: resolution.group }
    : null;
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

// A room may be inserted just before its Durable Object alarm is armed. The
// minute cron also picks up overdue rooms if the request stops in that gap.
export async function expireDueStudentRooms(env: Env): Promise<void> {
  const overdue = await env.DB.prepare(
    `SELECT id FROM rooms WHERE student_created = 1
       AND status IN ('open', 'full') AND self_room_expires_at <= ?
     ORDER BY self_room_expires_at LIMIT 100`,
  )
    .bind(Date.now())
    .all<{ id: string }>();
  for (const room of overdue.results) {
    try {
      const response = await callRoom(env, room.id, 'arm-expiry');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: 'student_room_expiry_retry',
          roomId: room.id,
          error: String(error),
        }),
      );
    }
  }
}

async function roomDetail(env: Env, roomId: string, studentUserId?: string) {
  const room = await env.DB.prepare(
    `SELECT r.id, r.code, r.name, r.mode, r.duration_minutes, r.status, r.locked_at,
            r.starts_at, r.ends_at, r.created_at, r.created_by, r.creator_team_id,
            r.student_created, r.team_group, r.team_practice_period_id, r.self_room_expires_at,
            COUNT(re.side) AS entry_count
     FROM rooms r LEFT JOIN room_entries re ON re.room_id = r.id
     WHERE r.id = ? GROUP BY r.id`,
  )
    .bind(roomId)
    .first<RoomListRow>();
  if (!room) throw new AppError(404, 'ROOM_NOT_FOUND', '房间不存在');
  if (studentUserId && room.student_created) {
    const team = await studentTeam(env, studentUserId);
    if (!team || team.group !== room.team_group) {
      throw new AppError(404, 'ROOM_NOT_FOUND', '房间不存在');
    }
  }
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
  let isCreatorTeamMember = false;
  if (studentUserId && room.creator_team_id) {
    isCreatorTeamMember = Boolean(
      await env.DB.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?')
        .bind(room.creator_team_id, studentUserId)
        .first(),
    );
  }
  return { ...serializeRoom(room), isCreatorTeamMember, entries: entries.results };
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
  if (c.get('user').role === 'student') {
    const team = await studentTeam(c.env, c.get('user').id);
    clauses.push('(r.student_created = 0 OR r.team_group = ?)');
    binds.push(team?.group ?? '');
  }
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
              r.starts_at, r.ends_at, r.created_at, r.created_by, r.creator_team_id,
              r.student_created, r.team_group, r.team_practice_period_id, r.self_room_expires_at,
              COUNT(re.side) AS entry_count,
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
      const code = roomCode();
      await c.env.DB.prepare(
        `INSERT INTO rooms (
           id, code, name, mode, duration_minutes, status, created_by, created_at, updated_at,
           team_practice_period_id
         ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?,
           CASE WHEN ? = 'team_3v3' THEN
             (SELECT id FROM team_practice_periods WHERE status = 'open' LIMIT 1)
           ELSE NULL END)`,
      )
        .bind(
          roomId,
          code,
          parsed.data.name,
          parsed.data.mode,
          parsed.data.durationMinutes,
          c.get('user').id,
          now,
          now,
          parsed.data.mode,
        )
        .run();
      created = true;
    } catch (error) {
      if (error instanceof AppError) throw error;
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
    updates.push(`team_practice_period_id = CASE WHEN ? = 'team_3v3' THEN
      (SELECT id FROM team_practice_periods WHERE status = 'open' LIMIT 1)
      ELSE NULL END`);
    binds.push(parsed.data.mode);
  }
  if (parsed.data.durationMinutes !== undefined) {
    updates.push('duration_minutes = ?');
    binds.push(parsed.data.durationMinutes);
  }
  updates.push('updated_at = ?');
  binds.push(Date.now(), c.req.param('id'));
  const updated = await c.env.DB.prepare(
    `UPDATE rooms SET ${updates.join(', ')}
    WHERE id = ? AND status = 'open' AND locked_at IS NULL`,
  )
    .bind(...binds)
    .run();
  if (!updated.meta.changes) {
    throw new AppError(409, 'ROOM_LOCKED', '首名参赛者加入后，模式和时长不能修改');
  }
  return c.json({ room: await roomDetail(c.env, c.req.param('id')), message: '房间设置已保存' });
});

teacherRoomRoutes.post('/:id/start', async (c) =>
  callRoom(c.env, c.req.param('id'), 'start', {
    actorUserId: c.get('user').id,
    actorRole: 'teacher',
  }),
);
teacherRoomRoutes.post('/:id/cancel', async (c) =>
  callRoom(c.env, c.req.param('id'), 'cancel', {
    actorUserId: c.get('user').id,
    actorRole: 'teacher',
  }),
);

teacherRoomRoutes.get('/:id/live', async (c) => {
  const roomId = c.req.param('id');
  return roomStub(c.env, roomId).fetch('https://room.internal/snapshot', {
    headers: { 'X-Room-Id': roomId, 'X-Role': 'teacher', 'X-User-Id': c.get('user').id },
  });
});

export const studentRoomRoutes = new Hono<AppHonoEnv>();

const studentRoomInput = z.object({
  name: z.string().trim().min(1).max(80),
  durationMinutes: z.number().int().min(1).max(10).default(5),
});

studentRoomRoutes.post('/', async (c) => {
  const parsed = studentRoomInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) throw new AppError(422, 'VALIDATION_ERROR', '房间设置无效');
  const userId = c.get('user').id;
  const team = await studentTeam(c.env, userId);
  if (!team)
    throw new AppError(409, 'TEAM_INCOMPLETE_OR_GROUP_UNKNOWN', '须先加入完整的同组三人团队');
  const period = await openTeamPracticePeriod(c.env.DB);
  if (!period) throw new AppError(409, 'TEAM_PRACTICE_PERIOD_CLOSED', '当前未开放团队练习期');
  const roomId = uuid();
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000;
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO rooms (id, code, name, mode, duration_minutes, status,
           created_by, created_at, updated_at, team_practice_period_id,
           team_group, creator_team_id, student_created, self_room_expires_at)
         SELECT ?, ?, ?, 'team_3v3', ?, 'open', ?, ?, ?, id, ?, ?, 1, ?
         FROM team_practice_periods WHERE id = ? AND status = 'open'`,
      ).bind(
        roomId,
        roomCode(),
        parsed.data.name,
        parsed.data.durationMinutes,
        userId,
        now,
        now,
        team.group,
        team.id,
        expiresAt,
        period.id,
      ),
      c.env.DB.prepare(
        `INSERT INTO room_entries (room_id, side, team_id, joined_by, joined_at)
         VALUES (?, 'A', ?, ?, ?)`,
      ).bind(roomId, team.id, userId, now),
      c.env.DB.prepare(
        `INSERT INTO active_participations (user_id, room_id, side)
         SELECT user_id, ?, 'A' FROM team_members WHERE team_id = ?`,
      ).bind(roomId, team.id),
    ]);
  } catch {
    throw new AppError(
      409,
      'STUDENT_ROOM_CONFLICT',
      '无法建房：练习期已关闭，或团队已占用其他房间',
    );
  }
  const armed = await callRoom(c.env, roomId, 'arm-expiry').catch(() => null);
  if (!armed?.ok) {
    await c.env.DB.batch([
      c.env.DB.prepare(
        "UPDATE rooms SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('open', 'full')",
      ).bind(Date.now(), roomId),
      c.env.DB.prepare(
        `DELETE FROM active_participations WHERE room_id = ?
         AND EXISTS (SELECT 1 FROM rooms WHERE id = ? AND status = 'cancelled')`,
      ).bind(roomId, roomId),
    ]);
    throw new AppError(503, 'ROOM_EXPIRY_UNAVAILABLE', '房间到期计时暂不可用，请重试');
  }
  return c.json({ room: await roomDetail(c.env, roomId), message: '房间已创建' }, 201);
});

studentRoomRoutes.get('/', listRooms);
studentRoomRoutes.get('/:id', async (c) =>
  c.json({ room: await roomDetail(c.env, c.req.param('id'), c.get('user').id) }),
);
studentRoomRoutes.post('/:id/start', async (c) => {
  await roomDetail(c.env, c.req.param('id'), c.get('user').id);
  return callRoom(c.env, c.req.param('id'), 'start', {
    actorUserId: c.get('user').id,
    actorRole: 'student',
  });
});
studentRoomRoutes.post('/:id/cancel', async (c) => {
  await roomDetail(c.env, c.req.param('id'), c.get('user').id);
  return callRoom(c.env, c.req.param('id'), 'cancel', {
    actorUserId: c.get('user').id,
    actorRole: 'student',
  });
});
studentRoomRoutes.post('/:id/join', async (c) => {
  await roomDetail(c.env, c.req.param('id'), c.get('user').id);
  return callRoom(c.env, c.req.param('id'), 'join', { userId: c.get('user').id });
});
studentRoomRoutes.post('/:id/leave', async (c) => {
  await roomDetail(c.env, c.req.param('id'), c.get('user').id);
  return callRoom(c.env, c.req.param('id'), 'leave', { userId: c.get('user').id });
});
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
  if (user.role === 'student') headers.set('X-Session-Hash', c.get('sessionHash'));
  return roomStub(c.env, roomId).fetch('https://room.internal/ws', {
    method: 'GET',
    headers,
  });
}
