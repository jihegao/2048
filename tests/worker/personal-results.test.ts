import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { PersonalResultsResponse } from '../../shared/types';

const origin = 'https://example.com';
const teacherPassword = 'integration-teacher-password';
const studentPassword = 'integration-student-password';

let teacherCookie = '';
let studentCookie = '';
let currentStudentId = '';
let opponentStudentId = '';
let teammateOneId = '';
let teammateTwoId = '';
let opponentTwoId = '';
let opponentThreeId = '';

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`${origin}${path}`, init);
}

async function login(loginId: string, password: string): Promise<string> {
  const response = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId, password, locale: 'zh-CN' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';', 1)[0];
}

async function importStudents(): Promise<void> {
  const rows = [
    { studentNumber: 'P20260001', name: '当前学生甲', className: '六年级一班', gradeLevel: 6 },
    { studentNumber: 'P20260002', name: '对手学生乙', className: '六年级二班', gradeLevel: 6 },
    { studentNumber: 'P20260003', name: '队友学生丙', className: '六年级一班', gradeLevel: 6 },
    { studentNumber: 'P20260004', name: '队友学生丁', className: '六年级一班', gradeLevel: 6 },
    { studentNumber: 'P20260005', name: '对方学生戊', className: '六年级二班', gradeLevel: 6 },
    { studentNumber: 'P20260006', name: '对方学生己', className: '六年级二班', gradeLevel: 6 },
  ];
  const preview = await request('/api/teacher/users/import/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({ rows }),
  });
  const previewBody = (await preview.json()) as { token: string; errors: unknown[] };
  expect(previewBody.errors).toEqual([]);
  const commit = await request('/api/teacher/users/import/commit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({ rows, token: previewBody.token }),
  });
  expect(commit.status).toBe(200);

  const users = await env.DB.prepare(
    `SELECT id, student_no FROM users WHERE student_no LIKE 'P2026%' ORDER BY student_no`,
  ).all<{ id: string; student_no: string }>();
  [
    currentStudentId,
    opponentStudentId,
    teammateOneId,
    teammateTwoId,
    opponentTwoId,
    opponentThreeId,
  ] = users.results.map((user) => user.id);
}

async function insertRoom(
  id: string,
  mode: 'duel' | 'team_3v3',
  finishedAt: number,
  purpose: 'official' | 'friendly' = 'official',
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO rooms (
       id, code, name, mode, duration_minutes, status, created_by, created_at, updated_at,
       starts_at, ends_at, finished_at, finish_reason, winner_side, settled_at, purpose
     ) VALUES (?, ?, ?, ?, 5, 'ended',
       (SELECT id FROM users WHERE role = 'teacher' LIMIT 1), ?, ?, ?, ?, ?, 'time_limit', 'A', ?, ?)`,
  )
    .bind(
      id,
      `CODE-${id}`,
      `房间-${id}`,
      mode,
      finishedAt - 600_000,
      finishedAt,
      finishedAt - 300_000,
      finishedAt,
      finishedAt,
      finishedAt,
      purpose,
    )
    .run();
}

async function insertPlayer(
  roomId: string,
  userId: string,
  side: 'A' | 'B',
  outcome: 'win' | 'loss' | 'draw',
  teamId: string | null = null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO match_players (
       room_id, user_id, team_id, side, score, max_tile, max_tile_reached_at,
       valid_move_count, game_over, final_board_json, outcome, team_total_score
     ) VALUES (?, ?, ?, ?, 1024, 256, 1, 30, 1, '[]', ?, 3072)`,
  )
    .bind(roomId, userId, teamId, side, outcome)
    .run();
}

describe.sequential('classified personal results', () => {
  it('seeds formal and friendly practice, duel, and team history', async () => {
    teacherCookie = await login('teacher', teacherPassword);
    await importStudents();
    studentCookie = await login('P20260001', studentPassword);

    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO leaderboard_periods (
         id, name, start_at, end_at, created_by, created_at, updated_at
       ) VALUES ('personal-current', '秋季比赛期', ?, ?,
         (SELECT id FROM users WHERE role = 'teacher' LIMIT 1), ?, ?)`,
    )
      .bind(now - 86_400_000, now + 86_400_000, now, now)
      .run();

    for (const [index, score, maxTile, moves] of [
      [1, 5000, 512, 90],
      [2, 5000, 512, 80],
      [3, 4500, 1024, 120],
      [4, 4000, 512, 60],
      [5, 3500, 256, 50],
      [6, 3000, 256, 40],
    ]) {
      await env.DB.prepare(
        `INSERT INTO practice_results (
           id, challenge_id, user_id, engine_version, score, max_tile,
           valid_move_count, final_board_json, started_at, ended_at
         ) VALUES (?, ?, ?, 'test', ?, ?, ?, '[]', ?, ?)`,
      )
        .bind(
          `personal-practice-${index}`,
          `personal-challenge-${index}`,
          currentStudentId,
          score,
          maxTile,
          moves,
          now - Number(index) * 1000 - 500,
          now - Number(index) * 1000,
        )
        .run();
    }

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO teams (id, code, name, created_at, updated_at)
         VALUES ('personal-team-a', 'PTEAM-A', '追光队', ?, ?)`,
      ).bind(now, now),
      env.DB.prepare(
        `INSERT INTO teams (id, code, name, created_at, updated_at)
         VALUES ('personal-team-b', 'PTEAM-B', '星火队', ?, ?)`,
      ).bind(now, now),
    ]);

    await insertRoom('duel-current', 'duel', now - 10_000);
    await insertPlayer('duel-current', currentStudentId, 'A', 'win');
    await insertPlayer('duel-current', opponentStudentId, 'B', 'loss');

    await insertRoom('duel-history', 'duel', now - 172_800_000);
    await insertPlayer('duel-history', currentStudentId, 'A', 'draw');
    await insertPlayer('duel-history', opponentStudentId, 'B', 'draw');

    await insertRoom('duel-friendly', 'duel', now - 5_000, 'friendly');
    await insertPlayer('duel-friendly', currentStudentId, 'A', 'win');
    await insertPlayer('duel-friendly', opponentStudentId, 'B', 'loss');

    await insertRoom('team-current', 'team_3v3', now - 8_000);
    for (const userId of [currentStudentId, teammateOneId, teammateTwoId]) {
      await insertPlayer('team-current', userId, 'A', 'draw', 'personal-team-a');
    }
    for (const userId of [opponentStudentId, opponentTwoId, opponentThreeId]) {
      await insertPlayer('team-current', userId, 'B', 'draw', 'personal-team-b');
    }

    await insertRoom('team-history', 'team_3v3', now - 172_700_000);
    for (const userId of [currentStudentId, teammateOneId, teammateTwoId]) {
      await insertPlayer('team-history', userId, 'A', 'loss', 'personal-team-a');
    }
    for (const userId of [opponentStudentId, opponentTwoId, opponentThreeId]) {
      await insertPlayer('team-history', userId, 'B', 'win', 'personal-team-b');
    }
  });

  it('returns stable best-five ordering, scoped summaries, and masked opponents', async () => {
    const response = await request('/api/me/results', { headers: { Cookie: studentCookie } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as PersonalResultsResponse;

    expect(body.totalCount).toBe(10);
    expect(body.practiceBest.map((item) => item.id)).toEqual([
      'personal-practice-2',
      'personal-practice-1',
      'personal-practice-3',
      'personal-practice-4',
      'personal-practice-5',
    ]);
    expect(body.duel.history.summary).toEqual({
      played: 2,
      wins: 1,
      draws: 1,
      losses: 0,
      points: 4,
    });
    expect(body.duel.currentPeriod?.summary).toEqual({
      played: 1,
      wins: 1,
      draws: 0,
      losses: 0,
      points: 3,
    });
    expect(body.duel.history.items[0].opponent).toEqual({
      className: '六年级二班',
      maskedName: '对手学生*',
      studentNumberSuffix: '260002',
    });
    expect(body.team.history.summary).toEqual({
      played: 2,
      wins: 0,
      draws: 1,
      losses: 1,
      points: 1,
    });
    expect(body.team.currentPeriod?.summary.played).toBe(1);
    expect(body.team.history.items[0]).toMatchObject({
      team: { id: 'personal-team-a', name: '追光队' },
      opponentTeam: { id: 'personal-team-b', name: '星火队' },
    });
    expect(JSON.stringify(body)).not.toContain('对手学生乙');
    expect(JSON.stringify(body)).not.toContain('P20260002');
    expect(body.duel.history.items.map((item) => item.roomId)).not.toContain('duel-friendly');
  });

  it('keeps history available when there is no active period', async () => {
    await env.DB.prepare("DELETE FROM leaderboard_periods WHERE id = 'personal-current'").run();
    const response = await request('/api/me/results', { headers: { Cookie: studentCookie } });
    const body = (await response.json()) as PersonalResultsResponse;
    expect(body.duel.currentPeriod).toBeNull();
    expect(body.team.currentPeriod).toBeNull();
    expect(body.duel.history.summary.played).toBe(2);
    expect(body.team.history.summary.played).toBe(2);
  });
});
