import ExcelJS from 'exceljs';
import { Hono } from 'hono';
import type { AppHonoEnv } from '../app-types';
import { AppError } from '../lib/errors';

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

studentResultRoutes.get('/me/results', async (c) => {
  const userId = c.get('user').id;
  const [matches, practices] = await Promise.all([
    c.env.DB.prepare(
      `SELECT 'match' AS type, r.id, r.name AS room_name, r.mode, r.duration_minutes,
              r.finished_at AS occurred_at, mp.score, mp.max_tile, mp.outcome,
              mp.team_total_score
       FROM match_players mp JOIN rooms r ON r.id = mp.room_id
       WHERE mp.user_id = ? ORDER BY r.finished_at DESC LIMIT 100`,
    )
      .bind(userId)
      .all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT 'practice' AS type, id, ended_at AS occurred_at, score, max_tile,
              valid_move_count FROM practice_results
       WHERE user_id = ? ORDER BY ended_at DESC LIMIT 100`,
    )
      .bind(userId)
      .all<Record<string, unknown>>(),
  ]);
  const items = [...matches.results, ...practices.results]
    .sort((a, b) => Number(b.occurred_at) - Number(a.occurred_at))
    .slice(0, 100);
  return c.json({ items });
});
