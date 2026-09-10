import { Hono } from 'hono';
import type {
  GradeLevel,
  LeaderboardPeriod,
  LeaderboardPeriodStatus,
  StudentPracticeLeaderboardBoard,
  StudentPracticeLeaderboardEntry,
  StudentPracticeLeaderboardResponse,
  StudentPracticeLeaderboardUnavailableResponse,
  StudentTeamLeaderboardEntry,
  StudentTeamLeaderboardResponse,
  StudentTeamLeaderboardUnavailableResponse,
  TeacherPracticeLeaderboardEntry,
  TeacherPracticeLeaderboardResponse,
  TeacherTeamLeaderboardEntry,
  TeacherTeamLeaderboardResponse,
  TeamLogoId,
} from '../../shared/types';
import type { AppHonoEnv } from '../app-types';
import { uuid } from '../lib/db';
import { AppError, zodIssues } from '../lib/errors';
import {
  leaderboardPeriodInputSchema,
  leaderboardPeriodPatchSchema,
  studentLeaderboardQuerySchema,
  teacherLeaderboardQuerySchema,
  teacherTeamLeaderboardQuerySchema,
} from '../schemas';

interface PeriodRow {
  id: string;
  name: string;
  start_at: number;
  end_at: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface RankingRow {
  user_id: string;
  student_no: string;
  display_name: string;
  class_name: string;
  grade_level: GradeLevel | null;
  score: number;
  max_tile: number;
  valid_move_count: number;
  ended_at: number;
  leaderboard_rank: number;
  participant_count: number;
}

interface TeamPracticeRow {
  team_id: string;
  team_name: string;
  logo: string | null;
  member_count: number;
  total_score: number;
  team_rank: number;
  participant_team_count: number;
  user_id: string;
  student_no: string;
  display_name: string;
  class_name: string | null;
  member_score: number;
}

const PERIOD_OVERLAP_SQLITE_MESSAGE = 'leaderboard period overlaps existing period';

// Shared tie-break ordering for picking each student's single best practice
// result inside a period. The personal leaderboard and the team leaderboard
// must use the identical key so refreshed personal bests stay consistent with
// aggregated team totals.
const BEST_PRACTICE_ORDER_SQL =
  'pr.score DESC, pr.max_tile DESC, pr.valid_move_count ASC, pr.ended_at ASC, pr.id ASC';

function periodStatus(row: PeriodRow, now: number): LeaderboardPeriodStatus {
  if (now < row.start_at) return 'upcoming';
  if (now >= row.end_at) return 'ended';
  return 'active';
}

function serializePeriod(row: PeriodRow, now = Date.now()): LeaderboardPeriod {
  return {
    id: row.id,
    name: row.name,
    startAt: new Date(row.start_at).toISOString(),
    endAt: new Date(row.end_at).toISOString(),
    status: periodStatus(row, now),
  };
}

function requireIncreasingPeriod(startAt: number, endAt: number): void {
  if (endAt <= startAt) {
    throw new AppError(422, 'VALIDATION_ERROR', '榜单周期时间无效', [
      { path: 'endAt', message: '结束时间必须晚于开始时间' },
    ]);
  }
}

function throwPeriodMutationError(error: unknown): never {
  if (error instanceof Error && error.message.includes(PERIOD_OVERLAP_SQLITE_MESSAGE)) {
    throw new AppError(409, 'LEADERBOARD_PERIOD_OVERLAP', '榜单周期不能与已有周期重叠');
  }
  throw error;
}

async function findPeriod(env: Env, id: string): Promise<PeriodRow> {
  const row = await env.DB.prepare('SELECT * FROM leaderboard_periods WHERE id = ? LIMIT 1')
    .bind(id)
    .first<PeriodRow>();
  if (!row) throw new AppError(404, 'LEADERBOARD_PERIOD_NOT_FOUND', '榜单周期不存在');
  return row;
}

async function findCurrentPeriod(env: Env, now: number): Promise<PeriodRow | null> {
  return env.DB.prepare(
    `SELECT * FROM leaderboard_periods
     WHERE start_at <= ? AND end_at > ?
     ORDER BY start_at DESC, id
     LIMIT 1`,
  )
    .bind(now, now)
    .first<PeriodRow>();
}

async function rankedPracticeResults(
  env: Env,
  period: PeriodRow,
  gradeLevel?: GradeLevel,
  studentAudienceUserId?: string,
): Promise<RankingRow[]> {
  const gradeClause = gradeLevel === undefined ? '' : 'AND u.grade_level = ?';
  const audienceClause = studentAudienceUserId ? 'WHERE leaderboard_rank <= 20 OR user_id = ?' : '';
  const binds: unknown[] = [period.start_at, period.end_at];
  if (gradeLevel !== undefined) binds.push(gradeLevel);
  if (studentAudienceUserId) binds.push(studentAudienceUserId);

  const rows = await env.DB.prepare(
    `WITH candidates AS (
       SELECT pr.user_id, u.student_no, u.display_name, u.class_name, u.grade_level,
              pr.score, pr.max_tile, pr.valid_move_count, pr.ended_at, pr.id,
              ROW_NUMBER() OVER (
                PARTITION BY pr.user_id
                ORDER BY ${BEST_PRACTICE_ORDER_SQL}
              ) AS best_result
       FROM practice_results pr
       JOIN users u ON u.id = pr.user_id
       WHERE u.role = 'student'
         AND pr.ended_at >= ? AND pr.ended_at < ?
         ${gradeClause}
     ),
     ranked AS (
       SELECT user_id, student_no, display_name, class_name, grade_level,
              score, max_tile, valid_move_count, ended_at,
              RANK() OVER (
                ORDER BY score DESC, max_tile DESC, valid_move_count ASC
              ) AS leaderboard_rank,
              COUNT(*) OVER () AS participant_count
       FROM candidates
       WHERE best_result = 1
     )
     SELECT * FROM ranked
     ${audienceClause}
     ORDER BY leaderboard_rank ASC, ended_at ASC, user_id ASC`,
  )
    .bind(...binds)
    .all<RankingRow>();
  return rows.results;
}

async function rankedTeamPracticeResults(
  env: Env,
  period: PeriodRow,
  studentAudienceUserId?: string,
): Promise<TeamPracticeRow[]> {
  const audienceClause = studentAudienceUserId
    ? 'WHERE r.team_rank <= 20 OR r.team_id IN (SELECT team_id FROM team_members WHERE user_id = ?)'
    : '';
  const binds: unknown[] = [period.start_at, period.end_at];
  if (studentAudienceUserId) binds.push(studentAudienceUserId);
  const rows = await env.DB.prepare(
    `WITH candidates AS (
       SELECT pr.user_id, pr.score, pr.max_tile, pr.valid_move_count, pr.ended_at, pr.id,
              ROW_NUMBER() OVER (
                PARTITION BY pr.user_id
                ORDER BY ${BEST_PRACTICE_ORDER_SQL}
              ) AS best_result
       FROM practice_results pr
       JOIN users u ON u.id = pr.user_id
       WHERE u.role = 'student'
         AND pr.ended_at >= ? AND pr.ended_at < ?
     ),
     best AS (
       SELECT user_id, score FROM candidates WHERE best_result = 1
     ),
     per_member AS (
       SELECT t.id AS team_id, t.name AS team_name, t.logo,
              u.id AS user_id, u.student_no, u.display_name, u.class_name,
              COALESCE(b.score, 0) AS member_score
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
       JOIN users u ON u.id = tm.user_id
       LEFT JOIN best b ON b.user_id = tm.user_id
       WHERE t.deleted_at IS NULL
     ),
     team_totals AS (
       SELECT team_id, team_name, logo,
              COUNT(*) AS member_count,
              SUM(member_score) AS total_score
       FROM per_member GROUP BY team_id
     ),
     ranked AS (
       SELECT team_id, team_name, logo, member_count, total_score,
              RANK() OVER (ORDER BY total_score DESC) AS team_rank,
              COUNT(*) OVER () AS participant_team_count
       FROM team_totals
     )
     SELECT r.team_id, r.team_name, r.logo, r.member_count, r.total_score,
            r.team_rank, r.participant_team_count,
            pm.user_id, pm.student_no, pm.display_name, pm.class_name, pm.member_score
     FROM ranked r
     JOIN per_member pm ON pm.team_id = r.team_id
     ${audienceClause}
     ORDER BY r.team_rank ASC, r.team_name ASC, pm.student_no ASC`,
  )
    .bind(...binds)
    .all<TeamPracticeRow>();
  return rows.results;
}

function groupTeamPracticeRows<TMember>(
  rows: TeamPracticeRow[],
  toMember: (row: TeamPracticeRow) => TMember,
): Array<{ row: TeamPracticeRow; members: TMember[] }> {
  const teams = new Map<string, { row: TeamPracticeRow; members: TMember[] }>();
  for (const row of rows) {
    const existing = teams.get(row.team_id);
    if (existing) {
      existing.members.push(toMember(row));
    } else {
      teams.set(row.team_id, { row, members: [toMember(row)] });
    }
  }
  return [...teams.values()];
}

export function maskStudentName(name: string): string {
  const codePoints = [...name.trim()];
  if (codePoints.length <= 1) return '*';
  codePoints[codePoints.length - 1] = '*';
  return codePoints.join('');
}

export function studentNumberSuffix(studentNumber: string): string {
  return studentNumber.trim().slice(-6).padStart(6, '*');
}

function studentEntry(row: RankingRow, currentUserId: string): StudentPracticeLeaderboardEntry {
  return {
    rank: row.leaderboard_rank,
    className: row.class_name,
    maskedName: maskStudentName(row.display_name),
    studentNumberSuffix: studentNumberSuffix(row.student_no),
    score: row.score,
    maxTile: row.max_tile,
    isCurrentUser: row.user_id === currentUserId,
  };
}

function studentBoard(
  rows: RankingRow[],
  currentUserId: string,
  gradeLevel: GradeLevel | null,
): StudentPracticeLeaderboardBoard {
  const current = rows.find((row) => row.user_id === currentUserId);
  return {
    status: 'available',
    gradeLevel,
    participantCount: rows[0]?.participant_count ?? 0,
    currentUserRank: current?.leaderboard_rank ?? null,
    entries: rows.map((row) => studentEntry(row, currentUserId)),
  };
}

function teacherEntry(row: RankingRow): TeacherPracticeLeaderboardEntry {
  return {
    rank: row.leaderboard_rank,
    studentId: row.user_id,
    studentNumber: row.student_no,
    name: row.display_name,
    className: row.class_name,
    gradeLevel: row.grade_level,
    score: row.score,
    maxTile: row.max_tile,
    validMoveCount: row.valid_move_count,
    endedAt: new Date(row.ended_at).toISOString(),
  };
}

export const teacherLeaderboardPeriodRoutes = new Hono<AppHonoEnv>();

teacherLeaderboardPeriodRoutes.get('/', async (c) => {
  const now = Date.now();
  const rows = await c.env.DB.prepare(
    'SELECT * FROM leaderboard_periods ORDER BY start_at DESC, id DESC',
  ).all<PeriodRow>();
  return c.json({ items: rows.results.map((row) => serializePeriod(row, now)) });
});

teacherLeaderboardPeriodRoutes.post('/', async (c) => {
  const parsed = leaderboardPeriodInputSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(422, 'VALIDATION_ERROR', '榜单周期格式无效', zodIssues(parsed.error.issues));
  }
  const startAt = Date.parse(parsed.data.startAt);
  const endAt = Date.parse(parsed.data.endAt);
  requireIncreasingPeriod(startAt, endAt);
  const now = Date.now();
  const row: PeriodRow = {
    id: uuid(),
    name: parsed.data.name,
    start_at: startAt,
    end_at: endAt,
    created_by: c.get('user').id,
    created_at: now,
    updated_at: now,
  };
  try {
    await c.env.DB.prepare(
      `INSERT INTO leaderboard_periods (
         id, name, start_at, end_at, created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        row.id,
        row.name,
        row.start_at,
        row.end_at,
        row.created_by,
        row.created_at,
        row.updated_at,
      )
      .run();
  } catch (error) {
    throwPeriodMutationError(error);
  }
  return c.json({ period: serializePeriod(row, now) }, 201);
});

teacherLeaderboardPeriodRoutes.patch('/:id', async (c) => {
  const parsed = leaderboardPeriodPatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    throw new AppError(422, 'VALIDATION_ERROR', '榜单周期格式无效', zodIssues(parsed.error.issues));
  }
  const old = await findPeriod(c.env, c.req.param('id'));
  const now = Date.now();
  const changesSchedule = parsed.data.startAt !== undefined || parsed.data.endAt !== undefined;
  if (changesSchedule && old.start_at <= now) {
    throw new AppError(409, 'LEADERBOARD_PERIOD_LOCKED', '榜单周期开始后只能修改名称');
  }
  const updated: PeriodRow = {
    ...old,
    name: parsed.data.name ?? old.name,
    start_at: parsed.data.startAt ? Date.parse(parsed.data.startAt) : old.start_at,
    end_at: parsed.data.endAt ? Date.parse(parsed.data.endAt) : old.end_at,
    updated_at: now,
  };
  requireIncreasingPeriod(updated.start_at, updated.end_at);
  try {
    await c.env.DB.prepare(
      `UPDATE leaderboard_periods
       SET name = ?, start_at = ?, end_at = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(updated.name, updated.start_at, updated.end_at, updated.updated_at, updated.id)
      .run();
  } catch (error) {
    throwPeriodMutationError(error);
  }
  return c.json({ period: serializePeriod(updated, now) });
});

export const teacherLeaderboardRoutes = new Hono<AppHonoEnv>();

teacherLeaderboardRoutes.get('/practice', async (c) => {
  const parsed = teacherLeaderboardQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      '排行榜查询参数无效',
      zodIssues(parsed.error.issues),
    );
  }
  const period = await findPeriod(c.env, parsed.data.periodId);
  const rows = await rankedPracticeResults(c.env, period, parsed.data.gradeLevel);
  const response: TeacherPracticeLeaderboardResponse = {
    period: serializePeriod(period),
    gradeLevel: parsed.data.gradeLevel ?? null,
    participantCount: rows[0]?.participant_count ?? 0,
    entries: rows.map(teacherEntry),
  };
  return c.json(response);
});

teacherLeaderboardRoutes.get('/teams', async (c) => {
  const parsed = teacherTeamLeaderboardQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      '团队榜单查询参数无效',
      zodIssues(parsed.error.issues),
    );
  }
  const period = await findPeriod(c.env, parsed.data.periodId);
  const rows = await rankedTeamPracticeResults(c.env, period);
  const entries: TeacherTeamLeaderboardEntry[] = groupTeamPracticeRows(rows, (row) => ({
    studentId: row.user_id,
    studentNumber: row.student_no,
    name: row.display_name,
    className: row.class_name,
    score: row.member_score,
  })).map(({ row, members }) => ({
    rank: row.team_rank,
    teamId: row.team_id,
    teamName: row.team_name,
    teamLogo: row.logo as TeamLogoId | null,
    memberCount: row.member_count,
    totalScore: row.total_score,
    members,
  }));
  const response: TeacherTeamLeaderboardResponse = {
    period: serializePeriod(period),
    participantTeamCount: rows[0]?.participant_team_count ?? 0,
    entries,
  };
  return c.json(response);
});

export const studentLeaderboardRoutes = new Hono<AppHonoEnv>();

studentLeaderboardRoutes.get('/teams', async (c) => {
  const now = Date.now();
  const period = await findCurrentPeriod(c.env, now);
  if (!period) {
    const response: StudentTeamLeaderboardUnavailableResponse = {
      status: 'no_active_period',
      period: null,
      participantTeamCount: 0,
      currentUserTeamRank: null,
      entries: [],
    };
    return c.json(response);
  }
  const user = c.get('user');
  const myTeam = await c.env.DB.prepare(
    `SELECT tm.team_id FROM team_members tm
     JOIN teams t ON t.id = tm.team_id
     WHERE tm.user_id = ? AND t.deleted_at IS NULL`,
  )
    .bind(user.id)
    .first<{ team_id: string }>();
  const myTeamId = myTeam?.team_id ?? null;
  const rows = await rankedTeamPracticeResults(c.env, period, user.id);
  const entries: StudentTeamLeaderboardEntry[] = groupTeamPracticeRows(rows, (row) => ({
    className: row.class_name,
    maskedName: maskStudentName(row.display_name),
    studentNumberSuffix: studentNumberSuffix(row.student_no),
    score: row.member_score,
    isCurrentUser: row.user_id === user.id,
  })).map(({ row, members }) => ({
    rank: row.team_rank,
    teamName: row.team_name,
    teamLogo: row.logo as TeamLogoId | null,
    memberCount: row.member_count,
    totalScore: row.total_score,
    isCurrentUserTeam: row.team_id === myTeamId,
    members,
  }));
  const response: StudentTeamLeaderboardResponse = {
    status: 'available',
    period: serializePeriod(period, now),
    participantTeamCount: rows[0]?.participant_team_count ?? 0,
    currentUserTeamRank: entries.find((entry) => entry.isCurrentUserTeam)?.rank ?? null,
    entries,
  };
  return c.json(response);
});

studentLeaderboardRoutes.get('/', async (c) => {
  const parsed = studentLeaderboardQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    throw new AppError(
      422,
      'VALIDATION_ERROR',
      '排行榜查询参数无效',
      zodIssues(parsed.error.issues),
    );
  }
  const now = Date.now();
  const period = await findCurrentPeriod(c.env, now);
  if (!period) {
    const response: StudentPracticeLeaderboardUnavailableResponse = {
      status: 'no_active_period',
      period: null,
      overall: null,
      grade: null,
    };
    return c.json(response);
  }

  const user = c.get('user');
  const [overallRows, gradeRows] = await Promise.all([
    rankedPracticeResults(c.env, period, undefined, user.id),
    user.gradeLevel === null
      ? Promise.resolve(null)
      : rankedPracticeResults(c.env, period, user.gradeLevel, user.id),
  ]);
  const response: StudentPracticeLeaderboardResponse = {
    status: 'available',
    period: serializePeriod(period, now),
    overall: studentBoard(overallRows, user.id, null),
    grade:
      gradeRows === null
        ? {
            status: 'grade_missing',
            gradeLevel: null,
            participantCount: 0,
            currentUserRank: null,
            entries: [],
          }
        : studentBoard(gradeRows, user.id, user.gradeLevel),
  };
  return c.json(response);
});
