import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const origin = 'https://example.com';
let teacherCookie = '';
const studentCookies = new Map<string, string>();

function request(path: string, init: RequestInit = {}) {
  return exports.default.fetch(`${origin}${path}`, init);
}

async function login(loginId: string, password: string): Promise<string> {
  const response = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId, password }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';', 1)[0];
}

async function previewUsers(rows: unknown[]) {
  const response = await request('/api/teacher/users/import/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({ rows }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ token: string; errors: Array<{ message: string }> }>;
}

async function importUsers(rows: unknown[]) {
  const preview = await previewUsers(rows);
  expect(preview.errors).toEqual([]);
  const response = await request('/api/teacher/users/import/commit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({ rows, token: preview.token }),
  });
  expect(response.status).toBe(200);
}

async function createTeam(student: string, name: string): Promise<string> {
  const response = await request('/api/teams', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: studentCookies.get(student)! },
    body: JSON.stringify({ name, logo: 'lion' }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { teamId: string }).teamId;
}

describe.sequential('grade groups and historical grade attribution', () => {
  it('resolves K and numeric boundaries, while coded grades require explicit confirmation', async () => {
    teacherCookie = await login('teacher', 'integration-teacher-password');
    const rows = [
      ['K1', 'K'],
      ['K2', 'K'],
      ['G1', 1],
      ['G2', 2],
      ['G2B', 2],
      ['G3', 3],
      ['G5', 5],
      ['G6', 6],
      ['G12', 12],
      ['CODE', 'G6'],
      ['AB', 'AB'],
    ].map(([studentNumber, gradeLevel]) => ({
      studentNumber,
      gradeLevel,
      name: String(studentNumber),
      className: '测试班',
    }));
    await importUsers(rows);
    const gradeRows = await env.DB.prepare(
      `SELECT u.student_no, g.ranking_grade, g.team_group
       FROM users u JOIN student_grade_resolution g ON g.user_id = u.id
       ORDER BY u.student_no`,
    ).all<{ student_no: string; ranking_grade: string | null; team_group: string | null }>();
    const groups = new Map(gradeRows.results.map((row) => [row.student_no, row.team_group]));
    expect(groups.get('K1')).toBe('K');
    expect(groups.get('G1')).toBe('1-2');
    expect(groups.get('G2')).toBe('1-2');
    expect(groups.get('G3')).toBe('3-5');
    expect(groups.get('G5')).toBe('3-5');
    expect(groups.get('G6')).toBe('6-12');
    expect(groups.get('G12')).toBe('6-12');
    expect(groups.get('CODE')).toBeNull();
    expect(groups.get('AB')).toBeNull();

    const options = await request('/api/teacher/users/grade-options', {
      headers: { Cookie: teacherCookie },
    });
    expect(await options.json()).toEqual({ items: ['K', 1, 2, 3, 5, 6, 12] });
    for (const row of rows) {
      studentCookies.set(
        String(row.studentNumber),
        await login(String(row.studentNumber), 'integration-student-password'),
      );
    }
  });

  it('accepts same group different grades and rejects cross group joins and imports', async () => {
    const teamId = await createTeam('G1', '一年级与二年级队');
    const join = await request(`/api/teams/${teamId}/join`, {
      method: 'POST',
      headers: { Cookie: studentCookies.get('G2')! },
    });
    expect(join.status).toBe(200);
    const wrong = await request(`/api/teams/${teamId}/join`, {
      method: 'POST',
      headers: { Cookie: studentCookies.get('G3')! },
    });
    expect(wrong.status).toBe(409);
    expect(await wrong.json()).toMatchObject({ error: { code: 'TEAM_GROUP_MISMATCH' } });
    const unknown = await request('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: studentCookies.get('CODE')! },
      body: JSON.stringify({ name: '未知组队', logo: 'lion' }),
    });
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toMatchObject({ error: { code: 'TEAM_GROUP_UNRESOLVED' } });

    const visible = await request('/api/teams/search?query=%E5%B9%B4%E7%BA%A7', {
      headers: { Cookie: studentCookies.get('G2B')! },
    });
    expect(await visible.json()).toMatchObject({
      items: [expect.objectContaining({ id: teamId, team_group: '1-2' })],
    });
    const hidden = await request('/api/teams/search?query=%E5%B9%B4%E7%BA%A7', {
      headers: { Cookie: studentCookies.get('G3')! },
    });
    expect(await hidden.json()).toEqual({ items: [] });

    const teacherImport = await request('/api/teacher/teams/import/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({
        rows: [{ name: '跨组导入', memberStudentNumbers: ['G3', 'G5', 'G6'] }],
      }),
    });
    const preview = (await teacherImport.json()) as { errors: Array<{ message: string }> };
    expect(preview.errors.some((error) => error.message.includes('同一赛事组别'))).toBe(true);

    const change = await previewUsers([
      { studentNumber: 'G2', name: 'G2', className: '测试班', gradeLevel: 3 },
    ]);
    expect(change.errors.some((error) => error.message.includes('现有团队'))).toBe(true);
    const userId = await env.DB.prepare("SELECT id FROM users WHERE student_no = 'G2'").first<{
      id: string;
    }>();
    await expect(
      env.DB.prepare('UPDATE users SET grade_level = 3 WHERE id = ?').bind(userId!.id).run(),
    ).rejects.toThrow('team group mismatch');

    await importUsers([
      {
        studentNumber: 'CODE',
        name: 'CODE',
        className: '测试班',
        gradeLevel: 'G6',
        confirmedGrade: 6,
      },
    ]);
    const codeGroup = await env.DB.prepare(
      "SELECT team_group FROM student_grade_resolution WHERE user_id = (SELECT id FROM users WHERE student_no = 'CODE')",
    ).first<{ team_group: string }>();
    expect(codeGroup?.team_group).toBe('6-12');
  });

  it('freezes new grades and keeps older results out of individual and team rankings', async () => {
    const now = Date.now();
    const period = await request('/api/teacher/leaderboard-periods', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({
        name: '历史期',
        startAt: new Date(now - 20_000).toISOString(),
        endAt: new Date(now - 10_000).toISOString(),
      }),
    });
    expect(period.status).toBe(201);
    const periodId = ((await period.json()) as { period: { id: string } }).period.id;
    const user = await env.DB.prepare("SELECT id FROM users WHERE student_no = 'K2'").first<{
      id: string;
    }>();
    await env.DB.prepare(
      `INSERT INTO practice_results (id, challenge_id, user_id, engine_version, score, max_tile,
        valid_move_count, final_board_json, started_at, ended_at)
       VALUES ('grade-k-result', 'grade-k-challenge', ?, 'test', 2048, 128, 20, '[]', ?, ?)`,
    )
      .bind(user!.id, now - 16_000, now - 15_000)
      .run();
    for (const [studentNo, id, score] of [
      ['K1', 'grade-old-k', 9000],
      ['G1', 'grade-old-team', 8000],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO practice_results (id, challenge_id, user_id, engine_version, score, max_tile,
          valid_move_count, final_board_json, started_at, ended_at)
         SELECT ?, ?, id, 'test', ?, 1024, 20, '[]', ?, ? FROM users WHERE student_no = ?`,
      )
        .bind(id, `${id}-challenge`, score, now - 16_000, now - 15_000, studentNo)
        .run();
      // These rows represent records that existed before migration 0007.
      await env.DB.prepare(
        "UPDATE practice_results SET grade_source = 'legacy_unranked', grade_at_completion = NULL WHERE id = ?",
      )
        .bind(id)
        .run();
    }
    await importUsers([{ studentNumber: 'K2', name: 'K2', className: '测试班', gradeLevel: 1 }]);
    const kBoard = await request(
      `/api/teacher/leaderboards/practice?periodId=${periodId}&gradeLevel=K`,
      {
        headers: { Cookie: teacherCookie },
      },
    );
    expect(await kBoard.json()).toMatchObject({
      participantCount: 1,
      entries: [{ studentNumber: 'K2', gradeLevel: 'K', gradeSource: 'completion' }],
    });
    const oneBoard = await request(
      `/api/teacher/leaderboards/practice?periodId=${periodId}&gradeLevel=1`,
      {
        headers: { Cookie: teacherCookie },
      },
    );
    expect(await oneBoard.json()).toMatchObject({ participantCount: 0, entries: [] });
    const overall = await request(`/api/teacher/leaderboards/practice?periodId=${periodId}`, {
      headers: { Cookie: teacherCookie },
    });
    expect(await overall.json()).toMatchObject({ participantCount: 1 });
    const teams = await request(`/api/teacher/leaderboards/teams?periodId=${periodId}`, {
      headers: { Cookie: teacherCookie },
    });
    const teamData = (await teams.json()) as {
      entries: Array<{ teamName: string; totalScore: number }>;
    };
    expect(
      teamData.entries.find((entry) => entry.teamName === '一年级与二年级队')?.totalScore,
    ).toBe(0);
    const personal = await request('/api/me/results', {
      headers: { Cookie: studentCookies.get('K1')! },
    });
    expect(await personal.json()).toMatchObject({
      practiceBest: [expect.objectContaining({ score: 9000 })],
    });
  });
});
