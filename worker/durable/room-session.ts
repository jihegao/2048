import { DurableObject } from 'cloudflare:workers';
import { applyMove, createGame, decideWinner, ENGINE_VERSION } from '../../shared/game';
import type {
  GameSnapshot,
  PlayerClientMessage,
  RoomMode,
  RoomStatus,
  MatchScoreSummary,
  ServerPlayerState,
  ServerTeacherState,
  TeacherPlayerState,
} from '../../shared/types';
import { directions, SESSION_REPLACED_CLOSE_CODE } from '../../shared/types';
import { tryFreezeTeamPracticePeriod } from '../lib/team-practice-periods';

interface PlayerRecord {
  userId: string;
  studentNumber: string;
  name: string;
  className: string | null;
  teamId: string | null;
  teamName: string | null;
  teamLogo: string | null;
  side: 1 | 2;
  game: GameSnapshot;
  controllerSocketId: string | null;
}

interface RoomRuntimeState {
  roomId: string;
  mode: RoomMode;
  durationMinutes: number;
  status: RoomStatus;
  startsAt: number;
  endsAt: number;
  seed: number;
  players: PlayerRecord[];
  revision: number;
}

interface SocketAttachment {
  socketId: string;
  role: 'teacher' | 'student';
  userId: string;
  sessionHash: string | null;
  connectionSequence?: number;
}

interface RoomRow {
  id: string;
  mode: RoomMode;
  duration_minutes: number;
  status: RoomStatus;
  seed: string | null;
  settled_at: number | null;
  team_practice_period_id: string | null;
  team_group: string | null;
  creator_team_id: string | null;
  created_by: string;
  student_created: number;
  self_room_expires_at: number | null;
}

interface PlayerDbRow {
  user_id: string;
  student_no: string;
  display_name: string;
  class_name: string | null;
  team_id: string | null;
  team_name: string | null;
  team_logo: string | null;
  side: 'A' | 'B';
}

function sideNumber(side: 'A' | 'B'): 1 | 2 {
  return side === 'A' ? 1 : 2;
}

function sideLetter(side: 1 | 2): 'A' | 'B' {
  return side === 1 ? 'A' : 'B';
}

function isPlayerMove(value: unknown): value is PlayerClientMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === 'move' &&
    typeof candidate.seq === 'number' &&
    Number.isInteger(candidate.seq) &&
    candidate.seq >= 1 &&
    directions.some((direction) => direction === candidate.direction)
  );
}

export class RoomSession extends DurableObject<Env> {
  private runtime: RoomRuntimeState | null = null;
  private teacherDirty = false;
  private connectionSequence = 0;
  private readonly messageQueues = new WeakMap<WebSocket, Promise<void>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.ctx.blockConcurrencyWhile(async () => {
      this.runtime = (await this.ctx.storage.get<RoomRuntimeState>('room-runtime')) ?? null;
      const startIntent = await this.ctx.storage.get<RoomRuntimeState>('room-start-intent');
      if (!this.runtime && startIntent) {
        const room = await this.room(startIntent.roomId);
        if (room.status === 'countdown' && room.seed === String(startIntent.seed)) {
          this.runtime = startIntent;
          await this.persist();
          await this.armAlarm(startIntent.startsAt);
        }
      }
      if (startIntent) await this.ctx.storage.delete('room-start-intent');
      if (this.runtime) {
        await this.advanceClock(Date.now());
        if (
          this.runtime.status === 'live' &&
          (await this.ctx.storage.get<boolean>('teacher-dirty')) === true
        ) {
          this.teacherDirty = true;
          await this.armAlarm(Date.now() + 1000);
        }
      }
    });
  }

  private async persist(): Promise<void> {
    if (this.runtime) await this.ctx.storage.put('room-runtime', this.runtime);
  }

  private async room(roomId: string): Promise<RoomRow> {
    const room = await this.env.DB.prepare(
      `SELECT id, mode, duration_minutes, status, seed, settled_at,
              team_practice_period_id, team_group, creator_team_id,
              created_by, student_created, self_room_expires_at
       FROM rooms WHERE id = ?`,
    )
      .bind(roomId)
      .first<RoomRow>();
    if (!room) throw new Error('ROOM_NOT_FOUND');
    return room;
  }

  private async activePlayerRows(roomId: string, mode: RoomMode): Promise<PlayerDbRow[]> {
    if (mode === 'duel') {
      const rows = await this.env.DB.prepare(
        `SELECT u.id AS user_id, u.student_no, u.display_name, u.class_name,
                NULL AS team_id, NULL AS team_name, NULL AS team_logo, re.side
         FROM room_entries re JOIN users u ON u.id = re.student_id
         WHERE re.room_id = ? ORDER BY re.side`,
      )
        .bind(roomId)
        .all<PlayerDbRow>();
      return rows.results;
    }
    const rows = await this.env.DB.prepare(
      `SELECT u.id AS user_id, u.student_no, u.display_name, u.class_name,
              t.id AS team_id, t.name AS team_name, t.logo AS team_logo, re.side
       FROM room_entries re
       JOIN teams t ON t.id = re.team_id
       JOIN team_members tm ON tm.team_id = t.id
       JOIN users u ON u.id = tm.user_id
       WHERE re.room_id = ? ORDER BY re.side, u.student_no`,
    )
      .bind(roomId)
      .all<PlayerDbRow>();
    return rows.results;
  }

  private async join(roomId: string, userId: string): Promise<Response> {
    const room = await this.room(roomId);
    if (await this.expireSelfRoomIfDue(room)) {
      return Response.json(
        { error: { code: 'ROOM_EXPIRED', message: '房间已到期' } },
        { status: 409 },
      );
    }
    const existingEntry = await this.env.DB.prepare(
      `SELECT re.side FROM room_entries re
       LEFT JOIN team_members tm ON tm.team_id = re.team_id
       WHERE re.room_id = ? AND (re.student_id = ? OR tm.user_id = ?) LIMIT 1`,
    )
      .bind(roomId, userId, userId)
      .first<{ side: 'A' | 'B' }>();
    if (existingEntry && ['open', 'full', 'countdown', 'live'].includes(room.status)) {
      return Response.json({
        ok: true,
        alreadyParticipant: true,
        roomStatus: room.status,
        side: existingEntry.side,
        message: ['countdown', 'live'].includes(room.status)
          ? '你已是该房间参赛者，可以返回比赛'
          : '你已在该房间候场',
      });
    }
    if (!['open', 'full'].includes(room.status)) {
      return Response.json(
        { error: { code: 'ROOM_NOT_OPEN', message: '房间已经不能加入' } },
        { status: 409 },
      );
    }
    const entries = await this.env.DB.prepare(
      'SELECT side FROM room_entries WHERE room_id = ? ORDER BY side',
    )
      .bind(roomId)
      .all<{ side: 'A' | 'B' }>();
    if (entries.results.length >= 2) {
      return Response.json(
        { error: { code: 'ROOM_FULL', message: '房间已经满员' } },
        { status: 409 },
      );
    }
    const side: 'A' | 'B' = entries.results.some((entry) => entry.side === 'A') ? 'B' : 'A';
    const now = Date.now();
    let participantIds: string[];
    let studentId: string | null = null;
    let teamId: string | null = null;
    if (room.mode === 'duel') {
      participantIds = [userId];
      studentId = userId;
    } else {
      const team = await this.env.DB.prepare(
        `SELECT t.id, COUNT(tm.user_id) AS member_count
         FROM teams t JOIN team_members tm ON tm.team_id = t.id
         WHERE t.id = (SELECT team_id FROM team_members WHERE user_id = ?)
         GROUP BY t.id`,
      )
        .bind(userId)
        .first<{ id: string; member_count: number }>();
      if (!team || team.member_count !== 3) {
        return Response.json(
          { error: { code: 'TEAM_INCOMPLETE', message: '必须由完整三人团队加入3v3房间' } },
          { status: 409 },
        );
      }
      teamId = team.id;
      if (room.student_created) {
        const groups = await this.env.DB.prepare(
          `SELECT COUNT(*) AS member_count,
                  SUM(g.team_group = ?) AS same_group_count
           FROM team_members tm
           LEFT JOIN student_grade_resolution g ON g.user_id = tm.user_id
           WHERE tm.team_id = ?`,
        )
          .bind(room.team_group, teamId)
          .first<{ member_count: number; same_group_count: number }>();
        if (groups?.member_count !== 3 || groups.same_group_count !== 3) {
          return Response.json(
            { error: { code: 'TEAM_GROUP_MISMATCH', message: '仅同组完整团队可加入' } },
            { status: 403 },
          );
        }
      }
      const members = await this.env.DB.prepare(
        'SELECT user_id FROM team_members WHERE team_id = ? ORDER BY user_id',
      )
        .bind(teamId)
        .all<{ user_id: string }>();
      participantIds = members.results.map((member) => member.user_id);
    }

    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO room_entries (room_id, side, student_id, team_id, joined_by, joined_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(roomId, side, studentId, teamId, userId, now),
        this.env.DB.prepare(
          `INSERT INTO active_participations (user_id, room_id, side)
           SELECT value, ?, ? FROM json_each(?)`,
        ).bind(roomId, side, JSON.stringify(participantIds)),
        this.env.DB.prepare(
          `UPDATE rooms SET status = ?, locked_at = COALESCE(locked_at, ?), updated_at = ? WHERE id = ?`,
        ).bind(entries.results.length === 1 ? 'full' : 'open', now, now, roomId),
      ]);
    } catch {
      return Response.json(
        { error: { code: 'ACTIVE_ROOM_CONFLICT', message: '你或团队成员已在其他房间候场或比赛' } },
        { status: 409 },
      );
    }
    return Response.json({ ok: true, side, message: '已加入房间' });
  }

  private async leave(roomId: string, userId: string): Promise<Response> {
    const room = await this.room(roomId);
    if (await this.expireSelfRoomIfDue(room)) {
      return Response.json(
        { error: { code: 'ROOM_EXPIRED', message: '房间已到期' } },
        { status: 409 },
      );
    }
    if (!['open', 'full'].includes(room.status)) {
      return Response.json(
        { error: { code: 'ROOM_ALREADY_STARTED', message: '比赛已开始，不能退出房间' } },
        { status: 409 },
      );
    }
    const entry = await this.env.DB.prepare(
      `SELECT re.side, re.student_id, re.team_id
       FROM room_entries re LEFT JOIN team_members tm ON tm.team_id = re.team_id
       WHERE re.room_id = ? AND (re.student_id = ? OR tm.user_id = ?) LIMIT 1`,
    )
      .bind(roomId, userId, userId)
      .first<{ side: 'A' | 'B'; student_id: string | null; team_id: string | null }>();
    if (!entry) {
      return Response.json(
        { error: { code: 'NOT_IN_ROOM', message: '你不在该房间' } },
        { status: 404 },
      );
    }
    if (room.student_created && entry.side === 'A') {
      return Response.json(
        { error: { code: 'OWNER_MUST_CANCEL', message: '创建团队请由房主取消房间' } },
        { status: 409 },
      );
    }
    const participantIds = entry.team_id
      ? (
          await this.env.DB.prepare('SELECT user_id FROM team_members WHERE team_id = ?')
            .bind(entry.team_id)
            .all<{ user_id: string }>()
        ).results.map((member) => member.user_id)
      : [entry.student_id!];
    const count = await this.env.DB.prepare(
      'SELECT COUNT(*) AS count FROM room_entries WHERE room_id = ?',
    )
      .bind(roomId)
      .first<{ count: number }>();
    const becomesEmpty = (count?.count ?? 1) <= 1;
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare('DELETE FROM room_entries WHERE room_id = ? AND side = ?').bind(
        roomId,
        entry.side,
      ),
      this.env.DB.prepare(
        `DELETE FROM active_participations
         WHERE room_id = ? AND user_id IN (SELECT value FROM json_each(?))`,
      ).bind(roomId, JSON.stringify(participantIds)),
      this.env.DB.prepare(
        `UPDATE rooms SET status = 'open', locked_at = ?, updated_at = ? WHERE id = ?`,
      ).bind(becomesEmpty ? null : now, now, roomId),
    ]);
    return Response.json({ ok: true, message: '已退出房间' });
  }

  private async start(
    roomId: string,
    actorUserId: string,
    actorRole: 'teacher' | 'student',
  ): Promise<Response> {
    const room = await this.room(roomId);
    if (await this.expireSelfRoomIfDue(room)) {
      return Response.json(
        { error: { code: 'ROOM_EXPIRED', message: '房间已到期' } },
        { status: 409 },
      );
    }
    if (actorRole === 'student' && (!room.student_created || room.created_by !== actorUserId)) {
      return Response.json(
        { error: { code: 'ROOM_START_FORBIDDEN', message: '只有房主可以开赛' } },
        { status: 403 },
      );
    }
    if (room.student_created && room.team_group) {
      const groups = await this.env.DB.prepare(
        `SELECT COUNT(*) AS member_count, SUM(g.team_group = ?) AS same_group_count
         FROM room_entries re JOIN team_members tm ON tm.team_id = re.team_id
         LEFT JOIN student_grade_resolution g ON g.user_id = tm.user_id
         WHERE re.room_id = ?`,
      )
        .bind(room.team_group, roomId)
        .first<{ member_count: number; same_group_count: number }>();
      if (groups?.member_count !== 6 || groups.same_group_count !== 6) {
        return Response.json(
          { error: { code: 'TEAM_GROUP_MISMATCH', message: '双方必须是同组完整团队' } },
          { status: 409 },
        );
      }
    }
    if (room.team_practice_period_id) {
      const open = await this.env.DB.prepare(
        "SELECT 1 FROM team_practice_periods WHERE id = ? AND status = 'open'",
      )
        .bind(room.team_practice_period_id)
        .first();
      if (!open)
        return Response.json(
          { error: { code: 'TEAM_PRACTICE_PERIOD_CLOSED', message: '练习期已关闭' } },
          { status: 409 },
        );
    }
    if (room.status !== 'full') {
      return Response.json(
        { error: { code: 'ROOM_NOT_FULL', message: '房间满员后才能开始比赛' } },
        { status: 409 },
      );
    }
    const dbPlayers = await this.activePlayerRows(roomId, room.mode);
    const expected = room.mode === 'duel' ? 2 : 6;
    if (dbPlayers.length !== expected) {
      return Response.json(
        { error: { code: 'ROOM_NOT_FULL', message: '参赛席位数据不完整' } },
        { status: 409 },
      );
    }
    const random = new Uint32Array(1);
    crypto.getRandomValues(random);
    const seed = random[0] || 1;
    const now = Date.now();
    const startsAt = now + 3000;
    const endsAt = startsAt + room.duration_minutes * 60_000;
    const nextRuntime: RoomRuntimeState = {
      roomId,
      mode: room.mode,
      durationMinutes: room.duration_minutes,
      status: 'countdown',
      startsAt,
      endsAt,
      seed,
      players: dbPlayers.map((player) => ({
        userId: player.user_id,
        studentNumber: player.student_no,
        name: player.display_name,
        className: player.class_name,
        teamId: player.team_id,
        teamName: player.team_name,
        teamLogo: player.team_logo,
        side: sideNumber(player.side),
        game: createGame(seed, startsAt),
        controllerSocketId: null,
      })),
      revision: 0,
    };
    await this.ctx.storage.put('room-start-intent', nextRuntime);
    const started = await this.env.DB.prepare(
      `UPDATE rooms SET status = 'countdown', engine_version = ?, seed = ?,
       starts_at = ?, ends_at = ?, updated_at = ? WHERE id = ? AND status = 'full'
       AND (team_practice_period_id IS NULL OR EXISTS (
         SELECT 1 FROM team_practice_periods p
         WHERE p.id = rooms.team_practice_period_id AND p.status = 'open'))
       AND (student_created = 0 OR self_room_expires_at > ?)`,
    )
      .bind(ENGINE_VERSION, String(seed), startsAt, endsAt, now, roomId, now)
      .run();
    if (!started.meta.changes) {
      await this.ctx.storage.delete('room-start-intent');
      return Response.json(
        { error: { code: 'ROOM_START_CONFLICT', message: '房间或练习期状态已变化' } },
        { status: 409 },
      );
    }
    this.runtime = nextRuntime;
    await this.persist();
    await this.ctx.storage.delete('room-start-intent');
    await this.armAlarm(startsAt);
    this.broadcast();
    return Response.json({ ok: true, startsAt, endsAt, message: '三秒倒计时已开始' });
  }

  private async isStudentSessionActive(
    userId: string,
    sessionHash: string | null,
  ): Promise<boolean> {
    if (!sessionHash) return false;
    const row = await this.env.DB.prepare(
      `SELECT 1
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.user_id = ? AND u.role = 'student'
         AND s.expires_at > ? AND s.credential_version = u.credential_version
       LIMIT 1`,
    )
      .bind(sessionHash, userId, Date.now())
      .first();
    return Boolean(row);
  }

  private async kickUser(userId: string): Promise<Response> {
    if (!userId) return new Response('Bad Request', { status: 400 });
    let releasedController = false;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.role !== 'student' || attachment.userId !== userId) continue;
      if (await this.isStudentSessionActive(userId, attachment.sessionHash)) continue;
      const player = this.runtime?.players.find((candidate) => candidate.userId === userId);
      if (player?.controllerSocketId === attachment.socketId) {
        player.controllerSocketId = null;
        releasedController = true;
      }
      socket.close(SESSION_REPLACED_CLOSE_CODE, 'Session replaced');
    }
    if (releasedController) await this.persist();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.role === 'teacher') this.sendState(socket, attachment);
    }
    return Response.json({ ok: true });
  }

  private async expireSelfRoomIfDue(room: RoomRow): Promise<boolean> {
    if (
      !room.student_created ||
      !['open', 'full'].includes(room.status) ||
      room.self_room_expires_at === null ||
      room.self_room_expires_at > Date.now()
    )
      return false;
    await this.cancel(room.id, '', 'teacher', true);
    return true;
  }

  private async armSelfRoomExpiry(roomId: string): Promise<Response> {
    const room = await this.room(roomId);
    if (!room.student_created || room.self_room_expires_at === null) {
      return Response.json({ error: { code: 'NOT_STUDENT_ROOM' } }, { status: 409 });
    }
    await this.ctx.storage.put('student-room-id', roomId);
    if (await this.expireSelfRoomIfDue(room)) return Response.json({ ok: true, expired: true });
    if (['open', 'full'].includes(room.status)) {
      await this.ctx.storage.setAlarm(room.self_room_expires_at);
    }
    return Response.json({ ok: true });
  }

  private async cancel(
    roomId: string,
    actorUserId: string,
    actorRole: 'teacher' | 'student',
    expiry = false,
  ): Promise<Response> {
    const room = await this.room(roomId);
    if (
      !expiry &&
      actorRole === 'student' &&
      (!room.student_created || room.created_by !== actorUserId)
    ) {
      return Response.json(
        { error: { code: 'ROOM_CANCEL_FORBIDDEN', message: '只有房主可以取消房间' } },
        { status: 403 },
      );
    }
    if (!['open', 'full'].includes(room.status)) {
      return Response.json(
        { error: { code: 'ROOM_CANNOT_CANCEL', message: '比赛开始后不能取消房间' } },
        { status: 409 },
      );
    }
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare(
        "UPDATE rooms SET status = 'cancelled', updated_at = ? WHERE id = ?",
      ).bind(now, roomId),
      this.env.DB.prepare('DELETE FROM active_participations WHERE room_id = ?').bind(roomId),
    ]);
    this.runtime = null;
    this.teacherDirty = false;
    await this.ctx.storage.delete('room-runtime');
    await this.ctx.storage.delete('teacher-dirty');
    await this.ctx.storage.delete('student-room-id');
    await this.ctx.storage.deleteAlarm();
    this.broadcast();
    return Response.json({ ok: true, message: '房间已取消' });
  }

  private playerState(userId: string, socketId?: string): ServerPlayerState {
    const runtime = this.runtime;
    const player = runtime?.players.find((candidate) => candidate.userId === userId);
    return {
      type: 'state',
      roomId: runtime?.roomId ?? '',
      roomStatus: runtime?.status ?? 'open',
      serverTime: Date.now(),
      startsAt: runtime?.startsAt ?? null,
      endsAt: runtime?.endsAt ?? null,
      game: player?.game ?? null,
      canControl: Boolean(player && socketId && player.controllerSocketId === socketId),
      scores: player ? this.scoreSummary(player) : null,
    };
  }

  private scoreSummary(player: PlayerRecord): MatchScoreSummary {
    const runtime = this.runtime!;
    const sideScores: MatchScoreSummary['sideScores'] = { 1: 0, 2: 0 };
    for (const candidate of runtime.players) sideScores[candidate.side] += candidate.game.score;
    return {
      mode: runtime.mode,
      side: player.side,
      sideScores,
      ownScore: player.game.score,
      revision: runtime.revision ?? 0,
    };
  }

  private pushStudentScores(): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (socket.readyState !== WebSocket.OPEN || attachment?.role !== 'student') continue;
      const player = this.runtime?.players.find(
        (candidate) => candidate.userId === attachment.userId,
      );
      if (!player) continue;
      socket.send(
        JSON.stringify({
          type: 'score-summary',
          roomId: this.runtime!.roomId,
          scores: this.scoreSummary(player),
        }),
      );
    }
  }

  private teacherState(): ServerTeacherState {
    const runtime = this.runtime;
    const sockets = this.ctx.getWebSockets();
    const onlineUsers = new Set(
      sockets
        .map((socket) => socket.deserializeAttachment() as SocketAttachment | null)
        .filter((attachment): attachment is SocketAttachment => attachment?.role === 'student')
        .map((attachment) => attachment.userId),
    );
    const players: TeacherPlayerState[] =
      runtime?.players.map((player) => ({
        userId: player.userId,
        studentNumber: player.studentNumber,
        name: player.name,
        className: player.className,
        teamName: player.teamName,
        teamLogo: player.teamLogo ?? null,
        side: player.side,
        online: onlineUsers.has(player.userId),
        game: player.game,
      })) ?? [];
    return {
      type: 'teacher-snapshot',
      roomId: runtime?.roomId ?? '',
      roomStatus: runtime?.status ?? 'open',
      serverTime: Date.now(),
      startsAt: runtime?.startsAt ?? null,
      endsAt: runtime?.endsAt ?? null,
      revision: runtime?.revision ?? 0,
      players,
    };
  }

  private sendState(socket: WebSocket, attachment: SocketAttachment): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    const payload =
      attachment.role === 'teacher'
        ? this.teacherState()
        : this.playerState(attachment.userId, attachment.socketId);
    socket.send(JSON.stringify(payload));
  }

  private broadcast(): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment) this.sendState(socket, attachment);
    }
  }

  private pushTeacherState(): void {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.role === 'teacher') this.sendState(socket, attachment);
    }
  }

  private hasTeacherSocket(): boolean {
    return this.ctx
      .getWebSockets()
      .some(
        (socket) => (socket.deserializeAttachment() as SocketAttachment | null)?.role === 'teacher',
      );
  }

  private async armAlarm(target: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > target) await this.ctx.storage.setAlarm(target);
  }

  private async persistPlayerUpdate(): Promise<void> {
    if (!this.runtime) return;
    if (!this.hasTeacherSocket()) {
      await this.persist();
      return;
    }
    this.teacherDirty = true;
    await this.ctx.storage.put({
      'room-runtime': this.runtime,
      'teacher-dirty': true,
    });
    await this.armAlarm(Date.now() + 1000);
  }

  private async connectWebSocket(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const userId = request.headers.get('X-User-Id');
    const role = request.headers.get('X-Role');
    if (!userId || (role !== 'teacher' && role !== 'student')) {
      return new Response('Unauthorized', { status: 401 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const socketId = crypto.randomUUID();
    const sessionHash = request.headers.get('X-Session-Hash');
    const attachedSequence = this.ctx
      .getWebSockets()
      .map(
        (socket) =>
          (socket.deserializeAttachment() as SocketAttachment | null)?.connectionSequence ?? 0,
      );
    const connectionSequence = Math.max(this.connectionSequence, 0, ...attachedSequence) + 1;
    this.connectionSequence = connectionSequence;
    const attachment: SocketAttachment = {
      socketId,
      role,
      userId,
      sessionHash,
      connectionSequence,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server);

    if (role === 'student') {
      // The worker validated the cookie before forwarding, but a concurrent
      // login may have deleted that session since; re-check to close races.
      if (!(await this.isStudentSessionActive(userId, sessionHash))) {
        server.close(SESSION_REPLACED_CLOSE_CODE, 'Session replaced');
        return new Response(null, { status: 101, webSocket: client });
      }
    }
    if (role === 'student' && this.runtime) {
      const player = this.runtime.players.find((candidate) => candidate.userId === userId);
      if (!player) {
        server.close(1008, 'Not a participant');
        return new Response(null, { status: 101, webSocket: client });
      }
      const currentControllerSocket = this.ctx
        .getWebSockets()
        .find(
          (socket) =>
            (socket.deserializeAttachment() as SocketAttachment | null)?.socketId ===
            player.controllerSocketId,
        );
      const currentController =
        (currentControllerSocket?.deserializeAttachment() as SocketAttachment | null) ?? null;
      if (!currentController || connectionSequence > (currentController.connectionSequence ?? 0)) {
        player.controllerSocketId = socketId;
        await this.persist();
        if (currentControllerSocket && currentController) {
          this.sendState(currentControllerSocket, currentController);
        }
      }
    }
    this.sendState(server, attachment);
    if (role === 'student') this.pushTeacherState();
    return new Response(null, { status: 101, webSocket: client });
  }

  private async advanceClock(now: number): Promise<void> {
    if (!this.runtime) return;
    if (this.runtime.status === 'countdown' && now >= this.runtime.startsAt) {
      this.runtime.status = 'live';
      this.runtime.revision = (this.runtime.revision ?? 0) + 1;
      await this.env.DB.prepare(
        "UPDATE rooms SET status = 'live', updated_at = ? WHERE id = ? AND status = 'countdown'",
      )
        .bind(now, this.runtime.roomId)
        .run();
      await this.persist();
      await this.armAlarm(this.runtime.endsAt);
      this.broadcast();
    }
    if (this.runtime.status === 'live' && now >= this.runtime.endsAt) {
      await this.settle('time_limit', this.runtime.endsAt);
    }
  }

  private async settle(reason: 'time_limit' | 'all_game_over', endedAt: number): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || runtime.status === 'ended') return;
    const room = await this.room(runtime.roomId);
    if (room.settled_at !== null) {
      runtime.status = 'ended';
      runtime.revision = (runtime.revision ?? 0) + 1;
      await this.persist();
      if (room.team_practice_period_id) {
        await tryFreezeTeamPracticePeriod(this.env.DB, room.team_practice_period_id);
      }
      this.broadcast();
      return;
    }

    const standing = ([1, 2] as const).map((side) => {
      const sidePlayers = runtime.players.filter((player) => player.side === side);
      const maxTile = Math.max(...sidePlayers.map((player) => player.game.maxTile));
      return {
        side,
        score: sidePlayers.reduce((total, player) => total + player.game.score, 0),
        maxTile,
        maxTileReachedAt: Math.min(
          ...sidePlayers
            .filter((player) => player.game.maxTile === maxTile)
            .map((player) => player.game.maxTileReachedAt),
        ),
      };
    });
    const winner = decideWinner(standing[0], standing[1]);
    const rows = runtime.players.map((player) => {
      const teamTotal = standing.find((side) => side.side === player.side)!.score;
      const outcome = winner === 'draw' ? 'draw' : winner === player.side ? 'win' : 'loss';
      return {
        roomId: runtime.roomId,
        userId: player.userId,
        teamId: player.teamId,
        side: sideLetter(player.side),
        score: player.game.score,
        maxTile: player.game.maxTile,
        maxTileReachedAt: player.game.maxTileReachedAt,
        moveCount: player.game.moveCount,
        gameOver: player.game.status === 'over' ? 1 : 0,
        board: JSON.stringify(player.game.board),
        outcome,
        teamTotal,
      };
    });
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `INSERT INTO match_players (
           room_id, user_id, team_id, side, score, max_tile, max_tile_reached_at,
           valid_move_count, game_over, final_board_json, outcome, team_total_score
         )
         SELECT json_extract(value, '$.roomId'), json_extract(value, '$.userId'),
                json_extract(value, '$.teamId'), json_extract(value, '$.side'),
                json_extract(value, '$.score'), json_extract(value, '$.maxTile'),
                json_extract(value, '$.maxTileReachedAt'), json_extract(value, '$.moveCount'),
                json_extract(value, '$.gameOver'), json_extract(value, '$.board'),
                json_extract(value, '$.outcome'), json_extract(value, '$.teamTotal')
         FROM json_each(?) WHERE true
         ON CONFLICT(room_id, user_id) DO NOTHING`,
      ).bind(JSON.stringify(rows)),
      this.env.DB.prepare(
        `UPDATE rooms SET status = 'ended', finished_at = ?, finish_reason = ?,
         winner_side = ?, settled_at = ?, updated_at = ?
         WHERE id = ? AND settled_at IS NULL`,
      ).bind(
        endedAt,
        reason,
        winner === 'draw' ? 'draw' : sideLetter(winner),
        endedAt,
        Date.now(),
        runtime.roomId,
      ),
      this.env.DB.prepare('DELETE FROM active_participations WHERE room_id = ?').bind(
        runtime.roomId,
      ),
    ];
    if (room.mode === 'team_3v3' && room.team_practice_period_id) {
      for (const side of [1, 2] as const) {
        const players = runtime.players.filter((player) => player.side === side);
        const team = players[0];
        if (
          !team?.teamId ||
          players.length !== 3 ||
          players.some((p) => p.teamId !== team.teamId)
        ) {
          throw new Error('TEAM_RESULT_ROSTER_INVALID');
        }
        const score = standing.find((row) => row.side === side)!.score;
        const outcome = winner === 'draw' ? 'draw' : winner === side ? 'win' : 'loss';
        const points = outcome === 'win' ? 3 : outcome === 'draw' ? 1 : 0;
        statements.splice(
          1,
          0,
          this.env.DB.prepare(
            `INSERT INTO team_match_results (
             room_id, team_practice_period_id, team_id, side, outcome, points, team_score,
             team_name_snapshot, roster_snapshot_json, started_at, settled_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(room_id, team_id) DO NOTHING`,
          ).bind(
            runtime.roomId,
            room.team_practice_period_id,
            team.teamId,
            sideLetter(side),
            outcome,
            points,
            score,
            team.teamName ?? '',
            JSON.stringify(
              players.map((p) => ({
                userId: p.userId,
                studentNumber: p.studentNumber,
                name: p.name,
              })),
            ),
            runtime.startsAt,
            endedAt,
          ),
        );
      }
    }
    await this.env.DB.batch(statements);
    runtime.status = 'ended';
    runtime.revision = (runtime.revision ?? 0) + 1;
    await this.persist();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete('teacher-dirty');
    await this.ctx.storage.delete('student-room-id');
    if (room.team_practice_period_id) {
      try {
        await tryFreezeTeamPracticePeriod(this.env.DB, room.team_practice_period_id);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'period_freeze_retry',
            roomId: runtime.roomId,
            error: String(error),
          }),
        );
        await this.ctx.storage.setAlarm(Date.now() + 5_000);
      }
    }
    this.broadcast();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roomId = request.headers.get('X-Room-Id') ?? url.searchParams.get('roomId') ?? '';
    if (url.pathname === '/join' && request.method === 'POST') {
      const body = (await request.json()) as { userId: string };
      return this.join(roomId, body.userId);
    }
    if (url.pathname === '/leave' && request.method === 'POST') {
      const body = (await request.json()) as { userId: string };
      return this.leave(roomId, body.userId);
    }
    if (url.pathname === '/start' && request.method === 'POST') {
      const actor = (await request.json().catch(() => null)) as {
        actorUserId?: string;
        actorRole?: 'teacher' | 'student';
      } | null;
      if (!actor?.actorUserId || !actor.actorRole)
        return new Response('Bad Request', { status: 400 });
      return this.start(roomId, actor.actorUserId, actor.actorRole);
    }
    if (url.pathname === '/cancel' && request.method === 'POST') {
      const actor = (await request.json().catch(() => null)) as {
        actorUserId?: string;
        actorRole?: 'teacher' | 'student';
      } | null;
      if (!actor?.actorUserId || !actor.actorRole)
        return new Response('Bad Request', { status: 400 });
      return this.cancel(roomId, actor.actorUserId, actor.actorRole);
    }
    if (url.pathname === '/arm-expiry' && request.method === 'POST') {
      return this.armSelfRoomExpiry(roomId);
    }
    if (url.pathname === '/kick' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as { userId?: string } | null;
      return this.kickUser(body?.userId ?? '');
    }
    if (url.pathname === '/ws') return this.connectWebSocket(request);
    if (url.pathname === '/snapshot') {
      await this.advanceClock(Date.now());
      const role = request.headers.get('X-Role');
      const userId = request.headers.get('X-User-Id') ?? '';
      return Response.json(role === 'teacher' ? this.teacherState() : this.playerState(userId));
    }
    return new Response('Not Found', { status: 404 });
  }

  async alarm(): Promise<void> {
    const studentRoomId = await this.ctx.storage.get<string>('student-room-id');
    if (studentRoomId) {
      const room = await this.room(studentRoomId);
      if (
        !(await this.expireSelfRoomIfDue(room)) &&
        ['open', 'full'].includes(room.status) &&
        room.self_room_expires_at !== null
      ) {
        await this.ctx.storage.setAlarm(room.self_room_expires_at);
      }
    }
    await this.advanceClock(Date.now());
    if (this.runtime?.status === 'ended') {
      const room = await this.room(this.runtime.roomId);
      if (room.team_practice_period_id) {
        await tryFreezeTeamPracticePeriod(this.env.DB, room.team_practice_period_id);
      }
    }
    const pendingTeacherPush =
      this.teacherDirty || (await this.ctx.storage.get<boolean>('teacher-dirty')) === true;
    if (this.runtime && this.runtime.status === 'live' && pendingTeacherPush) {
      this.pushTeacherState();
      await this.ctx.storage.delete('teacher-dirty');
      this.teacherDirty = false;
    }
    if (this.runtime && this.runtime.status === 'countdown' && this.runtime.startsAt > Date.now()) {
      await this.armAlarm(this.runtime.startsAt);
    } else if (this.runtime && this.runtime.status === 'live' && this.runtime.endsAt > Date.now()) {
      await this.armAlarm(this.runtime.endsAt);
    }
  }

  private async processWebSocketMessage(
    socket: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || attachment.role !== 'student') return;
    if (!(await this.isStudentSessionActive(attachment.userId, attachment.sessionHash))) {
      const player = this.runtime?.players.find(
        (candidate) => candidate.userId === attachment.userId,
      );
      if (player?.controllerSocketId === attachment.socketId) {
        player.controllerSocketId = null;
        await this.persist();
      }
      socket.close(SESSION_REPLACED_CLOSE_CODE, 'Session replaced');
      this.broadcast();
      return;
    }
    if (!this.runtime) return;
    await this.advanceClock(Date.now());
    if (this.runtime.status !== 'live') {
      this.sendState(socket, attachment);
      return;
    }
    const player = this.runtime.players.find((candidate) => candidate.userId === attachment.userId);
    if (!player || player.controllerSocketId !== attachment.socketId) {
      this.sendState(socket, attachment);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        typeof message === 'string' ? message : new TextDecoder().decode(message),
      );
    } catch {
      return;
    }
    if (!isPlayerMove(parsed)) {
      this.sendState(socket, attachment);
      return;
    }
    if (parsed.seq <= player.game.seq) return; // idempotent replay of an accepted move
    if (parsed.seq !== player.game.seq + 1) {
      this.sendState(socket, attachment);
      return;
    }
    const result = applyMove(player.game, parsed.direction, Date.now());
    if (!result.moved) {
      this.sendState(socket, attachment);
      return;
    }
    player.game = result.snapshot;
    this.runtime.revision = (this.runtime.revision ?? 0) + 1;
    if (this.runtime.players.every((candidate) => candidate.game.status === 'over')) {
      await this.persist();
      await this.settle('all_game_over', Date.now());
      return;
    }
    await this.persistPlayerUpdate();
    this.pushStudentScores();
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const previous = this.messageQueues.get(socket) ?? Promise.resolve();
    const queued = previous.then(() => this.processWebSocketMessage(socket, message));
    this.messageQueues.set(
      socket,
      queued.catch(() => undefined),
    );
    await queued;
  }

  async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    this.messageQueues.delete(socket);
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (attachment?.role === 'student' && this.runtime) {
      const player = this.runtime.players.find(
        (candidate) => candidate.userId === attachment.userId,
      );
      if (player?.controllerSocketId === attachment.socketId) {
        player.controllerSocketId = null;
        await this.persist();
      }
    }
    socket.close(code, reason);
    if (!wasClean) console.warn(JSON.stringify({ event: 'websocket_unclean_close', code, reason }));
    this.pushTeacherState();
  }

  async webSocketError(socket: WebSocket, error: unknown): Promise<void> {
    console.error(JSON.stringify({ event: 'websocket_error', message: String(error) }));
    socket.close(1011, 'WebSocket error');
  }
}
