import ExcelJS from 'exceljs';
import { Hono } from 'hono';
import type {
  LeaderboardPeriod,
  MatchOutcome,
  PersonalDuelResult,
  PersonalResultsResponse,
  PersonalResultsSummary,
  PersonalTeamMatchResult,
} from '../../shared/types';
import type { AppHonoEnv } from '../app-types';
import { AppError } from '../lib/errors';
import { maskStudentName, studentNumberSuffix } from './leaderboards';

interface ExportRow {
  room_code: string;
  room_name: string;
  mode: 'duel' | 'team_3v3';
  duration_minutes: number;
  starts_at: number;
  finished_at: number;
  finish_reason: 'time_limit' | 'all_game_over';
  student_no: string;
  display_name: string;
  class_name: string;
  team_name: string | null;
  score: number;
  team_total_score: number;
  max_tile: number;
  outcome: 'win' | 'loss' | 'draw';
}

const EXPORT_HEADERS = [
  '房间编号',
  '房间名称',
  '模式',
  '配置时长（分钟）',
  '实际时长（秒）',
  '开始时间',
  '结束时间',
  '学号',
  '姓名',
  '班级',
  '团队',
  '个人得分',
  '团队总分',
  '最高方块',
  '胜负',
  '提前结束原因',
] as const;

const shanghaiFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function safeSpreadsheetText(value: string): string {
  return /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
}

function exportValues(row: ExportRow): Array<string | number> {
  return [
    safeSpreadsheetText(row.room_code),
    safeSpreadsheetText(row.room_name),
    row.mode === 'duel' ? '1v1' : '3v3',
    row.duration_minutes,
    Math.max(0, Math.round((row.finished_at - row.starts_at) / 1000)),
    shanghaiFormatter.format(row.starts_at),
    shanghaiFormatter.format(row.finished_at),
    safeSpreadsheetText(row.student_no),
    safeSpreadsheetText(row.display_name),
    safeSpreadsheetText(row.class_name),
    safeSpreadsheetText(row.team_name ?? ''),
    row.score,
    row.team_total_score,
    row.max_tile,
    row.outcome === 'win' ? '胜' : row.outcome === 'loss' ? '负' : '平',
    row.finish_reason === 'all_game_over' ? '全部玩家提前结束' : '',
  ];
}

function escapeCsv(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function resultFilters(query: Record<string, string>) {
  const clauses = ["r.status = 'ended'"];
  const binds: unknown[] = [];
  if (query.mode === 'duel' || query.mode === 'team_3v3') {
    clauses.push('r.mode = ?');
    binds.push(query.mode);
  }
  if (query.className) {
    clauses.push('u.class_name = ?');
    binds.push(query.className);
  }
  if (query.from) {
    const from = /^\d{4}-\d{2}-\d{2}$/u.test(query.from)
      ? Date.parse(`${query.from}T00:00:00+08:00`)
      : Number.NaN;
    if (!Number.isNaN(from)) {
      clauses.push('r.finished_at >= ?');
      binds.push(from);
    }
  }
  if (query.to) {
    const to = /^\d{4}-\d{2}-\d{2}$/u.test(query.to)
      ? Date.parse(`${query.to}T00:00:00+08:00`) + 24 * 60 * 60 * 1000
      : Number.NaN;
    if (!Number.isNaN(to)) {
      clauses.push('r.finished_at < ?');
      binds.push(to);
    }
  }
  if (query.query) {
    const search = `%${query.query.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
    clauses.push(
      "(r.name LIKE ? ESCAPE '\\' OR u.student_no LIKE ? ESCAPE '\\' OR u.display_name LIKE ? ESCAPE '\\')",
    );
    binds.push(search, search, search);
  }
  return { where: clauses.join(' AND '), binds };
}

async function exportRows(env: Env, query: Record<string, string>): Promise<ExportRow[]> {
  const { where, binds } = resultFilters(query);
  const rows = await env.DB.prepare(
    `SELECT r.code AS room_code, r.name AS room_name, r.mode, r.duration_minutes,
            r.starts_at, r.finished_at, r.finish_reason,
            u.student_no, u.display_name, u.class_name, t.name AS team_name,
            mp.score, mp.team_total_score, mp.max_tile, mp.outcome
     FROM match_players mp
     JOIN rooms r ON r.id = mp.room_id
     JOIN users u ON u.id = mp.user_id
     LEFT JOIN teams t ON t.id = mp.team_id
     WHERE ${where}
     ORDER BY r.finished_at DESC, r.id, mp.side, u.student_no
     LIMIT 10000`,
  )
    .bind(...binds)
    .all<ExportRow>();
  return rows.results;
}

export const teacherResultRoutes = new Hono<AppHonoEnv>();

teacherResultRoutes.get('/', async (c) => {
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query('pageSize')) || 20));
  const filters = resultFilters(c.req.query());
  const offset = (page - 1) * pageSize;
  const [rows, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT r.id AS room_id, r.code AS room_code, r.name AS room_name, r.mode,
              r.duration_minutes, r.starts_at, r.finished_at, r.finish_reason,
              u.student_no, u.display_name, u.class_name, t.name AS team_name,
              mp.side, mp.score, mp.team_total_score, mp.max_tile, mp.outcome
       FROM match_players mp
       JOIN rooms r ON r.id = mp.room_id
       JOIN users u ON u.id = mp.user_id
       LEFT JOIN teams t ON t.id = mp.team_id
       WHERE ${filters.where}
       ORDER BY r.finished_at DESC, r.id, mp.side, u.student_no
       LIMIT ? OFFSET ?`,
    )
      .bind(...filters.binds, pageSize, offset)
      .all(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM match_players mp
       JOIN rooms r ON r.id = mp.room_id JOIN users u ON u.id = mp.user_id
       WHERE ${filters.where}`,
    )
      .bind(...filters.binds)
      .first<{ count: number }>(),
  ]);
  return c.json({ items: rows.results, total: count?.count ?? 0, page, pageSize });
});

teacherResultRoutes.get('/export.csv', async (c) => {
  const rows = await exportRows(c.env, c.req.query());
  const csv = [EXPORT_HEADERS, ...rows.map(exportValues)]
    .map((row) => row.map(escapeCsv).join(','))
    .join('\r\n');
  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', 'attachment; filename="match-results.csv"');
  return c.body(`\uFEFF${csv}`);
});

teacherResultRoutes.get('/export.xlsx', async (c) => {
  const rows = await exportRows(c.env, c.req.query());
  const workbook = new ExcelJS.Workbook();
  workbook.creator = '2048挑战平台';
  const sheet = workbook.addWorksheet('比赛成绩');
  sheet.addRow([...EXPORT_HEADERS]);
  sheet.getRow(1).font = { bold: true };
  rows.forEach((row) => sheet.addRow(exportValues(row)));
  sheet.columns.forEach((column) => {
    const values = column.values ?? [];
    column.width = Math.min(
      36,
      Math.max(12, ...values.slice(1).map((value) => String(value ?? '').length + 2)),
    );
  });
  sheet.autoFilter = { from: 'A1', to: `P${Math.max(1, rows.length + 1)}` };
  const bytes = await workbook.xlsx.writeBuffer();
  return new Response(bytes, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="match-results.xlsx"',
    },
  });
});

teacherResultRoutes.get('/:id', async (c) => {
  const room = await c.env.DB.prepare(
    `SELECT id, code, name, mode, duration_minutes, starts_at, finished_at,
            finish_reason, winner_side FROM rooms WHERE id = ? AND status = 'ended'`,
  )
    .bind(c.req.param('id'))
    .first();
  if (!room) throw new AppError(404, 'RESULT_NOT_FOUND', '比赛成绩不存在');
  const players = await c.env.DB.prepare(
    `SELECT mp.*, u.student_no, u.display_name, u.class_name, t.name AS team_name
     FROM match_players mp JOIN users u ON u.id = mp.user_id
     LEFT JOIN teams t ON t.id = mp.team_id
     WHERE mp.room_id = ? ORDER BY mp.side, u.student_no`,
  )
    .bind(c.req.param('id'))
    .all();
  return c.json({ result: { ...room, players: players.results } });
});

export const studentResultRoutes = new Hono<AppHonoEnv>();

interface CurrentPeriodRow {
  id: string;
  name: string;
  start_at: number;
  end_at: number;
}

interface PracticeBestRow {
  id: string;
  score: number;
  max_tile: number;
  valid_move_count: number;
  ended_at: number;
}

interface TimedPracticeBestRow extends PracticeBestRow {
  started_at: number;
  deadline_at: number;
  duration_seconds: 180;
  end_reason: 'time_limit' | 'game_over';
}

interface PersonalMatchRow {
  room_id: string;
  room_name: string;
  mode: 'duel' | 'team_3v3';
  finished_at: number;
  outcome: MatchOutcome;
  team_id: string | null;
  team_name: string | null;
  opponent_student_no: string | null;
  opponent_display_name: string | null;
  opponent_class_name: string | null;
  opponent_team_id: string | null;
  opponent_team_name: string | null;
}

function pointsFor(outcome: MatchOutcome): number {
  if (outcome === 'win') return 3;
  if (outcome === 'draw') return 1;
  return 0;
}

function summarize(rows: PersonalMatchRow[]): PersonalResultsSummary {
  return rows.reduce<PersonalResultsSummary>(
    (summary, row) => {
      summary.played += 1;
      summary.points += pointsFor(row.outcome);
      if (row.outcome === 'win') summary.wins += 1;
      else if (row.outcome === 'draw') summary.draws += 1;
      else summary.losses += 1;
      return summary;
    },
    { played: 0, wins: 0, draws: 0, losses: 0, points: 0 },
  );
}

function serializePeriod(row: CurrentPeriodRow): LeaderboardPeriod {
  return {
    id: row.id,
    name: row.name,
    startAt: new Date(row.start_at).toISOString(),
    endAt: new Date(row.end_at).toISOString(),
    status: 'active',
  };
}

function duelResult(row: PersonalMatchRow): PersonalDuelResult {
  const hasOpponent =
    row.opponent_student_no !== null &&
    row.opponent_display_name !== null &&
    row.opponent_class_name !== null;
  return {
    roomId: row.room_id,
    roomName: row.room_name,
    occurredAt: new Date(row.finished_at).toISOString(),
    outcome: row.outcome,
    points: pointsFor(row.outcome),
    opponent: hasOpponent
      ? {
          className: row.opponent_class_name!,
          maskedName: maskStudentName(row.opponent_display_name!),
          studentNumberSuffix: studentNumberSuffix(row.opponent_student_no!),
        }
      : null,
  };
}

function teamResult(row: PersonalMatchRow): PersonalTeamMatchResult {
  return {
    roomId: row.room_id,
    roomName: row.room_name,
    occurredAt: new Date(row.finished_at).toISOString(),
    outcome: row.outcome,
    points: pointsFor(row.outcome),
    team: row.team_id && row.team_name ? { id: row.team_id, name: row.team_name } : null,
    opponentTeam:
      row.opponent_team_id && row.opponent_team_name
        ? { id: row.opponent_team_id, name: row.opponent_team_name }
        : null,
  };
}

studentResultRoutes.get('/me/results', async (c) => {
  const userId = c.get('user').id;
  const now = Date.now();
  const [period, matches, practices, practiceCount, timedPractices, timedCount] = await Promise.all(
    [
      c.env.DB.prepare(
        `SELECT id, name, start_at, end_at FROM leaderboard_periods
       WHERE start_at <= ? AND end_at > ?
       ORDER BY start_at DESC, id LIMIT 1`,
      )
        .bind(now, now)
        .first<CurrentPeriodRow>(),
      c.env.DB.prepare(
        `SELECT r.id AS room_id, r.name AS room_name, r.mode, r.finished_at, mp.outcome,
              mp.team_id, own_team.name AS team_name,
              (
                SELECT opponent_user.student_no
                FROM match_players opponent
                JOIN users opponent_user ON opponent_user.id = opponent.user_id
                WHERE opponent.room_id = r.id AND opponent.side <> mp.side
                ORDER BY opponent_user.student_no LIMIT 1
              ) AS opponent_student_no,
              (
                SELECT opponent_user.display_name
                FROM match_players opponent
                JOIN users opponent_user ON opponent_user.id = opponent.user_id
                WHERE opponent.room_id = r.id AND opponent.side <> mp.side
                ORDER BY opponent_user.student_no LIMIT 1
              ) AS opponent_display_name,
              (
                SELECT opponent_user.class_name
                FROM match_players opponent
                JOIN users opponent_user ON opponent_user.id = opponent.user_id
                WHERE opponent.room_id = r.id AND opponent.side <> mp.side
                ORDER BY opponent_user.student_no LIMIT 1
              ) AS opponent_class_name,
              (
                SELECT opponent.team_id FROM match_players opponent
                WHERE opponent.room_id = r.id AND opponent.side <> mp.side
                  AND opponent.team_id IS NOT NULL
                ORDER BY opponent.team_id LIMIT 1
              ) AS opponent_team_id,
              (
                SELECT opponent_team.name
                FROM match_players opponent
                JOIN teams opponent_team ON opponent_team.id = opponent.team_id
                WHERE opponent.room_id = r.id AND opponent.side <> mp.side
                ORDER BY opponent.team_id LIMIT 1
              ) AS opponent_team_name
       FROM match_players mp
       JOIN rooms r ON r.id = mp.room_id
       LEFT JOIN teams own_team ON own_team.id = mp.team_id
       WHERE mp.user_id = ? AND r.status = 'ended' AND r.purpose = 'official'
       ORDER BY r.finished_at DESC, r.id`,
      )
        .bind(userId)
        .all<PersonalMatchRow>(),
      c.env.DB.prepare(
        `SELECT id, score, max_tile, valid_move_count, ended_at FROM practice_results
       WHERE user_id = ?
       ORDER BY score DESC, max_tile DESC, valid_move_count ASC, ended_at ASC, id ASC
       LIMIT 5`,
      )
        .bind(userId)
        .all<PracticeBestRow>(),
      c.env.DB.prepare('SELECT COUNT(*) AS count FROM practice_results WHERE user_id = ?')
        .bind(userId)
        .first<{ count: number }>(),
      c.env.DB.prepare(
        `SELECT id, score, max_tile, valid_move_count, started_at, deadline_at,
              duration_seconds, ended_at, end_reason
       FROM timed_practice_results WHERE user_id = ? AND mode = 'timed_3m'
       ORDER BY score DESC, max_tile DESC, valid_move_count ASC, ended_at ASC, id ASC
       LIMIT 10`,
      )
        .bind(userId)
        .all<TimedPracticeBestRow>(),
      c.env.DB.prepare(
        `SELECT COUNT(*) AS count FROM timed_practice_results
       WHERE user_id = ? AND mode = 'timed_3m'`,
      )
        .bind(userId)
        .first<{ count: number }>(),
    ],
  );

  const duelRows = matches.results.filter((row) => row.mode === 'duel');
  const teamRows = matches.results.filter((row) => row.mode === 'team_3v3');
  const currentDuelRows = period
    ? duelRows.filter(
        (row) => row.finished_at >= period.start_at && row.finished_at < period.end_at,
      )
    : [];
  const currentTeamRows = period
    ? teamRows.filter(
        (row) => row.finished_at >= period.start_at && row.finished_at < period.end_at,
      )
    : [];

  const response: PersonalResultsResponse = {
    totalCount: (practiceCount?.count ?? 0) + (timedCount?.count ?? 0) + matches.results.length,
    practiceBest: practices.results.map((row) => ({
      id: row.id,
      score: row.score,
      maxTile: row.max_tile,
      validMoveCount: row.valid_move_count,
      occurredAt: new Date(row.ended_at).toISOString(),
    })),
    timedPracticeBest: timedPractices.results.map((row) => ({
      id: row.id,
      mode: 'timed_3m',
      durationSeconds: row.duration_seconds,
      score: row.score,
      maxTile: row.max_tile,
      validMoveCount: row.valid_move_count,
      startedAt: new Date(row.started_at).toISOString(),
      deadlineAt: new Date(row.deadline_at).toISOString(),
      occurredAt: new Date(row.ended_at).toISOString(),
      endReason: row.end_reason,
    })),
    duel: {
      history: { summary: summarize(duelRows), items: duelRows.slice(0, 100).map(duelResult) },
      currentPeriod: period
        ? {
            period: serializePeriod(period),
            summary: summarize(currentDuelRows),
            items: currentDuelRows.slice(0, 100).map(duelResult),
          }
        : null,
    },
    team: {
      history: { summary: summarize(teamRows), items: teamRows.slice(0, 100).map(teamResult) },
      currentPeriod: period
        ? {
            period: serializePeriod(period),
            summary: summarize(currentTeamRows),
            items: currentTeamRows.slice(0, 100).map(teamResult),
          }
        : null,
    },
  };
  return c.json(response);
});
