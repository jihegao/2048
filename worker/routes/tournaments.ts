import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import {
  bracketKinds,
  bracketSize,
  emptyBracket,
  projectBracket,
  type BracketEntry,
  type BracketKind,
  type BracketState,
} from '../../shared/brackets';
import {
  clearTournamentWinner,
  tournamentImpacts,
  tournamentRoomName,
  type TournamentData,
  type TournamentRoom,
  type TournamentSummary,
} from '../../shared/tournaments';
import type { AppHonoEnv } from '../app-types';
import { roomCode, uuid } from '../lib/db';
import { AppError } from '../lib/errors';
import { readCatalog } from './brackets';

interface EventRow {
  id: string;
  kind: BracketKind;
  state_json: string;
  revision: number;
  archived_at: number | null;
  updated_at: number;
  mutation_id: string;
}
const stateSchema = z
  .object({
    title: z.string().max(100),
    names: z.array(z.string().max(180)).max(16),
    winners: z.array(z.array(z.string().max(100).nullable()).max(8)).max(4),
  })
  .strict();
const saveSchema = z.object({ revision: z.number().int().min(1), state: stateSchema }).strict();
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(422, 'VALIDATION_ERROR', '赛事设置无效');
  return result.data;
}
function cleanState(kind: BracketKind, catalog: BracketEntry[], state: BracketState) {
  const size = bracketSize(kind);
  if (
    state.names.length !== size ||
    state.winners.length !== Math.log2(size) ||
    state.winners.some((round, r) => round.length !== size / 2 ** (r + 1))
  )
    throw new AppError(422, 'VALIDATION_ERROR', '对阵席位或轮次不正确');
  const clean = projectBracket(kind, catalog, state).state;
  if (JSON.stringify(clean.winners) !== JSON.stringify(state.winners))
    throw new AppError(422, 'INVALID_BRACKET_WINNER', '名单已变化，请重新确认晋级结果');
  clean.title = clean.title.trim() || (kind === 'teams8' ? '团队赛事' : '个人赛事');
  return clean;
}
function invalidateChangedResults(row: EventRow, catalog: BracketEntry[], state: BracketState) {
  const before = projectBracket(row.kind, catalog, JSON.parse(row.state_json));
  let next = state;
  for (let round = 0; round < before.rounds.length; round++) {
    const projected = projectBracket(row.kind, catalog, next);
    before.rounds[round].forEach((match, index) => {
      if (
        match.winner &&
        match.entries.some(
          (entry, side) => entry?.id !== projected.rounds[round][index].entries[side]?.id,
        )
      )
        next = clearTournamentWinner(row.kind, catalog, next, round, index);
    });
  }
  return next;
}
function conflict(): never {
  throw new AppError(409, 'BRACKET_CONFLICT', '其他管理员已更新赛事，请重新载入后操作');
}
function dbError(error: unknown): never {
  if (String(error).includes('TOURNAMENT_ROOM_LOCKED'))
    throw new AppError(
      409,
      'TOURNAMENT_ROOM_LOCKED',
      '受影响的房间已开始或结束，请先处理比赛或创建重赛房间，再修改对阵',
    );
  throw error;
}
async function eventRow(db: D1Database, id: string) {
  const row = await db
    .prepare(
      'SELECT id, kind, state_json, revision, archived_at, updated_at, mutation_id FROM tournament_events WHERE id = ?',
    )
    .bind(id)
    .first<EventRow>();
  if (!row) throw new AppError(404, 'TOURNAMENT_NOT_FOUND', '赛事不存在');
  return row;
}
async function eventRooms(db: D1Database, id: string): Promise<TournamentRoom[]> {
  const rows = await db
    .prepare(
      `SELECT tr.round_index, tr.match_index, tr.participant_a, tr.participant_b, r.id, r.code, r.name, r.status, r.duration_minutes,
    (SELECT COUNT(*) FROM room_entries WHERE room_id = r.id) AS entry_count
    FROM tournament_rooms tr JOIN rooms r ON r.id = tr.room_id WHERE tr.event_id = ? ORDER BY tr.round_index, tr.match_index`,
    )
    .bind(id)
    .all<{
      round_index: number;
      match_index: number;
      participant_a: string | null;
      participant_b: string | null;
      id: string;
      code: string;
      name: string;
      status: TournamentRoom['status'];
      duration_minutes: number;
      entry_count: number;
    }>();
  return rows.results.map((row) => ({
    round: row.round_index,
    match: row.match_index,
    roomId: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    durationMinutes: row.duration_minutes,
    participants: [row.participant_a, row.participant_b],
    entryCount: row.entry_count,
  }));
}
function summary(row: EventRow, rooms: TournamentRoom[]): TournamentSummary {
  const state = JSON.parse(row.state_json) as BracketState;
  return {
    id: row.id,
    kind: row.kind,
    title: state.title || (row.kind === 'teams8' ? '团队赛事' : '个人赛事'),
    revision: row.revision,
    updatedAt: new Date(row.updated_at).toISOString(),
    archived: row.archived_at !== null,
    status:
      row.archived_at !== null
        ? 'archived'
        : state.winners.at(-1)?.[0]
          ? 'completed'
          : rooms.some((room) => ['countdown', 'live', 'ended'].includes(room.status))
            ? 'running'
            : rooms.length
              ? 'ready'
              : 'draft',
    roomCount: rooms.length,
  };
}
async function detail(db: D1Database, id: string): Promise<TournamentData> {
  const row = await eventRow(db, id);
  const [catalog, rooms, history, audit] = await Promise.all([
    readCatalog(db, row.kind),
    eventRooms(db, id),
    db
      .prepare(
        `SELECT h.room_id, h.round_index, h.match_index, h.replaced_at, r.code, r.name FROM tournament_room_history h JOIN rooms r ON r.id = h.room_id WHERE h.event_id = ? ORDER BY h.replaced_at DESC`,
      )
      .bind(id)
      .all<{
        room_id: string;
        round_index: number;
        match_index: number;
        replaced_at: number;
        code: string;
        name: string;
      }>(),
    db
      .prepare(
        `SELECT a.id, a.action, a.occurred_at, u.display_name FROM tournament_audit a JOIN users u ON u.id = a.actor_id WHERE a.event_id = ? ORDER BY a.occurred_at DESC, a.id DESC LIMIT 30`,
      )
      .bind(id)
      .all<{ id: string; action: string; occurred_at: number; display_name: string }>(),
  ]);
  return {
    event: summary(row, rooms),
    state: JSON.parse(row.state_json) as BracketState,
    revision: row.revision,
    updatedAt: new Date(row.updated_at).toISOString(),
    catalog,
    rooms,
    history: history.results.map((value) => ({
      roomId: value.room_id,
      round: value.round_index,
      match: value.match_index,
      replacedAt: new Date(value.replaced_at).toISOString(),
      code: value.code,
      name: value.name,
    })),
    audit: audit.results.map((value) => ({
      id: value.id,
      action: value.action,
      actor: value.display_name,
      at: new Date(value.occurred_at).toISOString(),
    })),
  };
}
function auditStatement(
  db: D1Database,
  id: string,
  mutation: string,
  action: string,
  actor: string,
  before: string | null,
  after: string | null,
) {
  return db
    .prepare(
      `INSERT INTO tournament_audit (id, event_id, action, actor_id, occurred_at, before_json, after_json)
    SELECT ?, id, ?, ?, updated_at, ?, ? FROM tournament_events WHERE id = ? AND mutation_id = ?`,
    )
    .bind(uuid(), action, actor, before, after, id, mutation);
}
function assignmentStatements(
  db: D1Database,
  row: EventRow,
  catalog: BracketEntry[],
  state: BracketState,
  mutation: string,
) {
  return projectBracket(row.kind, catalog, state).rounds.flatMap((matches, round) =>
    matches.map((match, index) =>
      db
        .prepare(
          `UPDATE tournament_rooms SET participant_a = ?, participant_b = ?, roster_revision = roster_revision + 1
    WHERE event_id = ? AND round_index = ? AND match_index = ? AND (participant_a IS NOT ? OR participant_b IS NOT ?)
    AND EXISTS (SELECT 1 FROM tournament_events WHERE id = ? AND mutation_id = ?)`,
        )
        .bind(
          match.entries[0]?.id ?? null,
          match.entries[1]?.id ?? null,
          row.id,
          round,
          index,
          match.entries[0]?.id ?? null,
          match.entries[1]?.id ?? null,
          row.id,
          mutation,
        ),
    ),
  );
}
export const teacherTournamentRoutes = new Hono<AppHonoEnv>();
teacherTournamentRoutes.use(
  '*',
  bodyLimit({
    maxSize: 32768,
    onError: () => {
      throw new AppError(413, 'BRACKET_TOO_LARGE', '赛事数据过大');
    },
  }),
);
teacherTournamentRoutes.get('/', async (c) => {
  const kind = parse(z.enum(bracketKinds), c.req.query('kind'));
  const archived = c.req.query('archived') === 'true';
  const rows = await c.env.DB.prepare(
    `SELECT id, kind, state_json, revision, archived_at, updated_at, mutation_id FROM tournament_events WHERE kind = ? AND (archived_at IS NOT NULL) = ? ORDER BY updated_at DESC, id LIMIT 200`,
  )
    .bind(kind, archived ? 1 : 0)
    .all<EventRow>();
  const items = await Promise.all(
    rows.results.map(async (row) => summary(row, await eventRooms(c.env.DB, row.id))),
  );
  return c.json({ items });
});
teacherTournamentRoutes.post('/', async (c) => {
  const input = parse(
    z
      .object({
        kind: z.enum(bracketKinds),
        state: stateSchema.optional(),
        copyId: z.string().max(100).optional(),
      })
      .strict(),
    await c.req.json().catch(() => null),
  );
  const source = input.copyId ? await eventRow(c.env.DB, input.copyId) : null;
  if (source && source.kind !== input.kind)
    throw new AppError(422, 'VALIDATION_ERROR', '赛事类型不匹配');
  const state = source
    ? {
        ...(JSON.parse(source.state_json) as BracketState),
        winners: emptyBracket(input.kind).winners,
      }
    : (input.state ?? emptyBracket(input.kind));
  if (source) state.title = `${state.title.slice(0, 95)}（副本）`;
  const catalog = await readCatalog(c.env.DB, input.kind);
  const clean = cleanState(input.kind, catalog, state);
  const id = uuid(),
    mutation = uuid(),
    now = Date.now(),
    actor = c.get('user').id;
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO tournament_events (id, kind, state_json, revision, mutation_id, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)',
    ).bind(id, input.kind, JSON.stringify(clean), mutation, actor, actor, now, now),
    auditStatement(
      c.env.DB,
      id,
      mutation,
      source ? 'copied' : 'created',
      actor,
      null,
      JSON.stringify(clean),
    ),
  ]);
  return c.json(await detail(c.env.DB, id), 201);
});
teacherTournamentRoutes.get('/:id', async (c) => c.json(await detail(c.env.DB, c.req.param('id'))));
teacherTournamentRoutes.post('/:id/preview', async (c) => {
  const input = parse(saveSchema, await c.req.json().catch(() => null));
  const row = await eventRow(c.env.DB, c.req.param('id'));
  if (row.revision !== input.revision) conflict();
  const catalog = await readCatalog(c.env.DB, row.kind),
    rooms = await eventRooms(c.env.DB, row.id);
  const clean = invalidateChangedResults(row, catalog, cleanState(row.kind, catalog, input.state));
  return c.json({
    impacts: tournamentImpacts(row.kind, catalog, JSON.parse(row.state_json), clean, rooms),
  });
});
teacherTournamentRoutes.put('/:id', async (c) => {
  const input = parse(saveSchema, await c.req.json().catch(() => null));
  const row = await eventRow(c.env.DB, c.req.param('id'));
  if (row.archived_at !== null)
    throw new AppError(409, 'TOURNAMENT_ARCHIVED', '请先恢复已归档赛事');
  if (row.revision !== input.revision) conflict();
  const catalog = await readCatalog(c.env.DB, row.kind),
    state = invalidateChangedResults(row, catalog, cleanState(row.kind, catalog, input.state));
  const mutation = uuid(),
    actor = c.get('user').id;
  let result: D1Result[];
  try {
    result = await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE tournament_events SET state_json = ?, revision = revision + 1, mutation_id = ?, updated_by = ?, updated_at = ? WHERE id = ? AND revision = ? AND archived_at IS NULL RETURNING id',
      ).bind(JSON.stringify(state), mutation, actor, Date.now(), row.id, input.revision),
      ...assignmentStatements(c.env.DB, row, catalog, state, mutation),
      // Renaming an event also renames its current rooms, preserving codes and results.
      c.env.DB.prepare(
        `UPDATE rooms SET name = ? || CASE WHEN tr.round_index = ? THEN '-决赛' ELSE '-第' || CASE tr.round_index WHEN 0 THEN '一' WHEN 1 THEN '二' WHEN 2 THEN '三' ELSE '四' END || '轮' || char(65 + tr.match_index) || '组' END
        FROM tournament_rooms tr WHERE rooms.id = tr.room_id AND tr.event_id = ? AND EXISTS (SELECT 1 FROM tournament_events WHERE id = ? AND mutation_id = ?)`,
      ).bind(
        state.title.slice(0, 60),
        Math.log2(bracketSize(row.kind)) - 1,
        row.id,
        row.id,
        mutation,
      ),
      auditStatement(
        c.env.DB,
        row.id,
        mutation,
        'saved',
        actor,
        row.state_json,
        JSON.stringify(state),
      ),
    ]);
  } catch (error) {
    dbError(error);
  }
  if (!result[0].results.length) conflict();
  return c.json(await detail(c.env.DB, row.id));
});
teacherTournamentRoutes.patch('/:id', async (c) => {
  const input = parse(
    z.object({ revision: z.number().int().min(1), archived: z.boolean() }).strict(),
    await c.req.json().catch(() => null),
  );
  const row = await eventRow(c.env.DB, c.req.param('id')),
    mutation = uuid(),
    actor = c.get('user').id,
    now = Date.now();
  let result: D1Result[];
  try {
    result = await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE tournament_events SET archived_at = ?, revision = revision + 1, mutation_id = ?, updated_by = ?, updated_at = ? WHERE id = ? AND revision = ? RETURNING id',
      ).bind(input.archived ? now : null, mutation, actor, now, row.id, input.revision),
      auditStatement(
        c.env.DB,
        row.id,
        mutation,
        input.archived ? 'archived' : 'restored',
        actor,
        row.state_json,
        row.state_json,
      ),
    ]);
  } catch (error) {
    dbError(error);
  }
  if (!result[0].results.length) conflict();
  return c.json(await detail(c.env.DB, row.id));
});
teacherTournamentRoutes.post('/:id/rooms', async (c) => {
  const input = parse(
    z
      .object({
        revision: z.number().int().min(1),
        durationMinutes: z.number().int().min(1).max(10),
      })
      .strict(),
    await c.req.json().catch(() => null),
  );
  const row = await eventRow(c.env.DB, c.req.param('id'));
  if (row.archived_at !== null) throw new AppError(409, 'TOURNAMENT_ARCHIVED', '请先恢复赛事');
  const rooms = await eventRooms(c.env.DB, row.id);
  if (rooms.length === bracketSize(row.kind) - 1) return c.json(await detail(c.env.DB, row.id));
  if (row.revision !== input.revision) conflict();
  const state = JSON.parse(row.state_json) as BracketState,
    catalog = await readCatalog(c.env.DB, row.kind),
    projected = projectBracket(row.kind, catalog, state);
  if (projected.slots.some((slot) => !slot.entry))
    throw new AppError(422, 'TOURNAMENT_ROSTER_INCOMPLETE', '请先填写并保存完整且不重复的参赛名单');
  if (row.kind === 'teams8') {
    const teams = await c.env.DB.prepare(
      `SELECT team_id FROM team_members WHERE team_id IN (SELECT value FROM json_each(?)) GROUP BY team_id HAVING COUNT(*) = 3`,
    )
      .bind(JSON.stringify(projected.slots.map((slot) => slot.entry!.id)))
      .all();
    if (teams.results.length !== 8)
      throw new AppError(422, 'TEAM_INCOMPLETE', '所有参赛队伍必须有完整三人名单');
  }
  const mutation = uuid(),
    actor = c.get('user').id,
    now = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    const statements = [
      c.env.DB.prepare(
        'UPDATE tournament_events SET revision = revision + 1, mutation_id = ?, updated_by = ?, updated_at = ? WHERE id = ? AND revision = ? AND archived_at IS NULL RETURNING id',
      ).bind(mutation, actor, now, row.id, input.revision),
    ];
    projected.rounds.forEach((matches, round) =>
      matches.forEach((match, index) => {
        if (rooms.some((room) => room.round === round && room.match === index)) return;
        const id = uuid();
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO rooms (id, code, name, mode, duration_minutes, status, created_by, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, 'open', ?, ?, ? FROM tournament_events WHERE id = ? AND mutation_id = ?`,
          ).bind(
            id,
            roomCode(),
            tournamentRoomName(state.title.slice(0, 60), row.kind, round, index),
            row.kind === 'teams8' ? 'team_3v3' : 'duel',
            input.durationMinutes,
            actor,
            now,
            now,
            row.id,
            mutation,
          ),
        );
        statements.push(
          c.env.DB.prepare(
            `INSERT INTO tournament_rooms (event_id, round_index, match_index, room_id, participant_a, participant_b)
        SELECT ?, ?, ?, id, ?, ? FROM rooms WHERE id = ?`,
          ).bind(
            row.id,
            round,
            index,
            match.entries[0]?.id ?? null,
            match.entries[1]?.id ?? null,
            id,
          ),
        );
      }),
    );
    statements.push(
      auditStatement(
        c.env.DB,
        row.id,
        mutation,
        'rooms_created',
        actor,
        null,
        JSON.stringify({ durationMinutes: input.durationMinutes }),
      ),
    );
    try {
      const result = await c.env.DB.batch(statements);
      if (!result[0].results.length) {
        const current = await eventRooms(c.env.DB, row.id);
        if (current.length === bracketSize(row.kind) - 1)
          return c.json(await detail(c.env.DB, row.id));
        conflict();
      }
      return c.json(await detail(c.env.DB, row.id));
    } catch (error) {
      if (attempt < 2 && String(error).includes('rooms.code')) continue;
      dbError(error);
    }
  }
  throw new AppError(500, 'ROOM_CREATE_FAILED', '房间创建失败，请重试');
});
teacherTournamentRoutes.post('/:id/rematch', async (c) => {
  const input = parse(
    z
      .object({
        revision: z.number().int().min(1),
        round: z.number().int().min(0).max(3),
        match: z.number().int().min(0).max(7),
      })
      .strict(),
    await c.req.json().catch(() => null),
  );
  const row = await eventRow(c.env.DB, c.req.param('id'));
  if (row.archived_at !== null) throw new AppError(409, 'TOURNAMENT_ARCHIVED', '请先恢复赛事');
  if (row.revision !== input.revision) conflict();
  const rooms = await eventRooms(c.env.DB, row.id),
    room = rooms.find((value) => value.round === input.round && value.match === input.match);
  if (!room || !['ended', 'cancelled'].includes(room.status))
    throw new AppError(409, 'TOURNAMENT_REMATCH_UNAVAILABLE', '仅已结束或取消的比赛可创建重赛房间');
  const catalog = await readCatalog(c.env.DB, row.kind),
    state = clearTournamentWinner(
      row.kind,
      catalog,
      JSON.parse(row.state_json),
      input.round,
      input.match,
    );
  const actor = c.get('user').id,
    mutation = uuid(),
    now = Date.now(),
    roomId = uuid();
  let result: D1Result[];
  try {
    result = await c.env.DB.batch([
      c.env.DB.prepare(
        'UPDATE tournament_events SET state_json = ?, revision = revision + 1, mutation_id = ?, updated_by = ?, updated_at = ? WHERE id = ? AND revision = ? AND archived_at IS NULL RETURNING id',
      ).bind(JSON.stringify(state), mutation, actor, now, row.id, input.revision),
      c.env.DB.prepare(
        `INSERT INTO tournament_room_history (id, event_id, round_index, match_index, room_id, replaced_at, replaced_by)
        SELECT ?, tr.event_id, tr.round_index, tr.match_index, tr.room_id, ?, ? FROM tournament_rooms tr WHERE tr.event_id = ? AND tr.room_id = ? AND EXISTS (SELECT 1 FROM tournament_events WHERE id = ? AND mutation_id = ?)`,
      ).bind(uuid(), now, actor, row.id, room.roomId, row.id, mutation),
      c.env.DB.prepare(
        `INSERT INTO rooms (id, code, name, mode, duration_minutes, status, created_by, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, 'open', ?, ?, ? FROM tournament_events WHERE id = ? AND mutation_id = ?`,
      ).bind(
        roomId,
        roomCode(),
        room.name,
        row.kind === 'teams8' ? 'team_3v3' : 'duel',
        room.durationMinutes,
        actor,
        now,
        now,
        row.id,
        mutation,
      ),
      c.env.DB.prepare(
        `UPDATE tournament_rooms SET room_id = ?, roster_revision = roster_revision + 1 WHERE event_id = ? AND room_id = ? AND EXISTS (SELECT 1 FROM tournament_events WHERE id = ? AND mutation_id = ?)`,
      ).bind(roomId, row.id, room.roomId, row.id, mutation),
      ...assignmentStatements(c.env.DB, row, catalog, state, mutation),
      auditStatement(
        c.env.DB,
        row.id,
        mutation,
        'rematch',
        actor,
        row.state_json,
        JSON.stringify(state),
      ),
    ]);
  } catch (error) {
    dbError(error);
  }
  if (!result[0].results.length) conflict();
  return c.json(await detail(c.env.DB, row.id));
});
