import { Hono } from 'hono';
import type { AppHonoEnv } from '../app-types';
import { AppError } from '../lib/errors';

interface CandidateRow {
  id: string;
  session_id: string;
  student_no: string;
  display_name: string;
  class_name: string;
  grade_at_completion: string | null;
  rank: number;
  mode: string;
  duration_seconds: number;
  engine_version: string;
  score: number;
  max_tile: number;
  valid_move_count: number;
  started_at: number;
  deadline_at: number;
  ended_at: number;
  end_reason: string;
  settled_at: number;
}

const HEADERS = [
  '学号',
  '姓名',
  '班级',
  '年级',
  '个人最高10局名次',
  '记录ID',
  '会话ID',
  '模式',
  '时长（秒）',
  '引擎版本',
  '得分',
  '最高方块',
  '有效步数',
  '开始时间',
  '截止时间',
  '结束时间',
  '结束原因',
  '结算时间',
];

function csvCell(value: string | number): string {
  const text = /^[=+\-@\t\r]/u.test(String(value)) ? `'${value}` : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function candidateValues(row: CandidateRow): Array<string | number> {
  return [
    row.student_no,
    row.display_name,
    row.class_name,
    row.grade_at_completion ?? '',
    row.rank,
    row.id,
    row.session_id,
    row.mode,
    row.duration_seconds,
    row.engine_version,
    row.score,
    row.max_tile,
    row.valid_move_count,
    new Date(row.started_at).toISOString(),
    new Date(row.deadline_at).toISOString(),
    new Date(row.ended_at).toISOString(),
    row.end_reason,
    new Date(row.settled_at).toISOString(),
  ];
}

async function topTen(env: Env): Promise<CandidateRow[]> {
  const rows = await env.DB.prepare(
    `WITH ranked AS (
       SELECT r.*, ROW_NUMBER() OVER (
         PARTITION BY r.user_id
         ORDER BY r.score DESC, r.max_tile DESC, r.valid_move_count ASC,
                  r.ended_at ASC, r.id ASC
       ) AS rank
       FROM timed_practice_results r WHERE r.mode = 'timed_3m'
     )
     SELECT ranked.id, ranked.session_id, ranked.rank, ranked.mode,
            ranked.duration_seconds, ranked.engine_version, ranked.score,
            ranked.max_tile, ranked.valid_move_count, ranked.started_at,
            ranked.deadline_at, ranked.ended_at, ranked.end_reason, ranked.settled_at,
            ranked.grade_at_completion,
            u.student_no, u.display_name, u.class_name
     FROM ranked JOIN users u ON u.id = ranked.user_id
     WHERE ranked.rank <= 10 AND u.role = 'student'
     ORDER BY u.student_no, ranked.rank`,
  ).all<CandidateRow>();
  return rows.results;
}

export const teacherTimedPracticeRoutes = new Hono<AppHonoEnv>();

teacherTimedPracticeRoutes.get('/top', async (c) => {
  const rows = await topTen(c.env);
  return c.json({
    kind: 'raw_candidate_results',
    qualificationDecided: false,
    includesTestAccounts: true,
    items: rows.map((row) => ({
      ...row,
      started_at: new Date(row.started_at).toISOString(),
      deadline_at: new Date(row.deadline_at).toISOString(),
      ended_at: new Date(row.ended_at).toISOString(),
      settled_at: new Date(row.settled_at).toISOString(),
    })),
  });
});

teacherTimedPracticeRoutes.get('/export.csv', async (c) => {
  const rows = await topTen(c.env);
  const csv = [HEADERS, ...rows.map(candidateValues)]
    .map((values) => values.map(csvCell).join(','))
    .join('\r\n');
  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', 'attachment; filename="timed-practice-raw-top10.csv"');
  c.header('X-Qualification-Status', 'raw-candidates-includes-test-accounts');
  return c.body(`\uFEFF${csv}`);
});

teacherTimedPracticeRoutes.get('/:sessionId', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT r.*, s.seed, s.seq, s.moves_json,
            u.student_no, u.display_name, u.class_name, u.grade_code
     FROM timed_practice_results r
     JOIN timed_practice_sessions s ON s.id = r.session_id
     JOIN users u ON u.id = r.user_id
     WHERE r.session_id = ?`,
  )
    .bind(c.req.param('sessionId'))
    .first();
  if (!row) throw new AppError(404, 'TIMED_RESULT_NOT_FOUND', '限时练习成绩不存在');
  return c.json({ result: row, qualificationDecided: false });
});
