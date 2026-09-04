import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { maskStudentName, studentNumberSuffix } from '../../worker/routes/leaderboards';

const origin = 'https://example.com';
const teacherPassword = 'integration-teacher-password';
const studentPassword = 'integration-student-password';

let teacherCookie = '';
let currentStudentCookie = '';
let legacyStudentCookie = '';
let firstStudentCookie = '';
let previousPeriodId = '';
let currentPeriodId = '';
let futurePeriodId = '';
let currentStart = 0;
let currentEnd = 0;

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

async function importStudents(rows: unknown[]): Promise<Response> {
  const previewResponse = await request('/api/teacher/users/import/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({ rows }),
  });
  expect(previewResponse.status).toBe(200);
  const preview = (await previewResponse.json()) as {
    token: string;
    errors: Array<{ row: number; field: string; message: string }>;
  };
  expect(preview.errors).toEqual([]);
  return request('/api/teacher/users/import/commit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({ rows, token: preview.token }),
  });
}

async function createPeriod(name: string, startAt: number, endAt: number): Promise<string> {
  const response = await request('/api/teacher/leaderboard-periods', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({
      name,
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(),
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { period: { id: string } }).period.id;
}

function scoreForStudent(index: number): {
  score: number;
  maxTile: number;
  validMoveCount: number;
} {
  if (index <= 2) return { score: 10_000, maxTile: 1024, validMoveCount: 100 };
  if (index <= 19) {
    return { score: 10_000 - index * 100, maxTile: 512, validMoveCount: 100 + index };
  }
  if (index <= 21) return { score: 8_000, maxTile: 512, validMoveCount: 200 };
  return { score: 10_100 - index * 100, maxTile: 256, validMoveCount: 200 + index };
}

describe.sequential('practice leaderboards', () => {
  it('requires a valid imported grade and enforces route roles', async () => {
    expect((await request('/api/leaderboard')).status).toBe(401);
    expect((await request('/api/teacher/leaderboard-periods')).status).toBe(401);

    teacherCookie = await login('teacher', teacherPassword);
    expect(
      (
        await request('/api/leaderboard', {
          headers: { Cookie: teacherCookie },
        })
      ).status,
    ).toBe(403);

    const template = await request('/api/teacher/users/template.csv', {
      headers: { Cookie: teacherCookie },
    });
    expect(await template.text()).toBe('学号,姓名,班级,年级\n20260001,张三,六年级1班,6\n');

    for (const gradeLevel of [undefined, 0, 1.5, 13]) {
      const response = await request('/api/teacher/users/import/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: teacherCookie },
        body: JSON.stringify({
          rows: [
            {
              studentNumber: 'invalid-grade',
              name: '无效年级',
              className: '测试班',
              ...(gradeLevel === undefined ? {} : { gradeLevel }),
            },
          ],
        }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        errors: Array<{ field: string; message: string }>;
      };
      expect(body.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ field: 'gradeLevel' })]),
      );
    }

    const students = Array.from({ length: 25 }, (_, offset) => {
      const index = offset + 1;
      return {
        studentNumber: `2026${String(index).padStart(4, '0')}`,
        name: `学生${String(index).padStart(2, '0')}甲`,
        className: index <= 12 || index === 24 ? '六年级一班' : '七年级一班',
        gradeLevel: index <= 12 || index === 24 ? 6 : 7,
      };
    });
    students[23].gradeLevel = 7;
    expect((await importStudents(students)).status).toBe(200);

    expect(
      (
        await importStudents([
          {
            studentNumber: '20260024',
            name: '学生24甲',
            className: '六年级一班',
            gradeLevel: 6,
          },
        ])
      ).status,
    ).toBe(200);

    currentStudentCookie = await login('20260024', studentPassword);
    legacyStudentCookie = await login('20260025', studentPassword);
    firstStudentCookie = await login('20260001', studentPassword);
    const me = await request('/api/me', { headers: { Cookie: currentStudentCookie } });
    expect(await me.json()).toMatchObject({ user: { gradeLevel: 6 } });
    expect(
      (
        await request('/api/teacher/leaderboard-periods', {
          headers: { Cookie: currentStudentCookie },
        })
      ).status,
    ).toBe(403);

    await env.DB.prepare("UPDATE users SET grade_level = NULL WHERE login_id = '20260025'").run();
    const unavailable = await request('/api/leaderboard', {
      headers: { Cookie: currentStudentCookie },
    });
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toEqual({
      status: 'no_active_period',
      period: null,
      overall: null,
      grade: null,
    });
  });

  it('manages non-overlapping half-open periods and returns history', async () => {
    const now = Date.now();
    currentStart = now - 60 * 60 * 1000;
    currentEnd = now + 60 * 60 * 1000;

    const invalid = await request('/api/teacher/leaderboard-periods', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({
        name: '无效周期',
        startAt: new Date(currentStart).toISOString(),
        endAt: new Date(currentStart).toISOString(),
      }),
    });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR', issues: [{ path: 'endAt' }] },
    });

    previousPeriodId = await createPeriod('上一期', currentStart - 60 * 60 * 1000, currentStart);
    currentPeriodId = await createPeriod('本期', currentStart, currentEnd);
    futurePeriodId = await createPeriod('下一期', currentEnd, currentEnd + 60 * 60 * 1000);

    const overlap = await request('/api/teacher/leaderboard-periods', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({
        name: '重叠期',
        startAt: new Date(currentStart + 1000).toISOString(),
        endAt: new Date(currentEnd - 1000).toISOString(),
      }),
    });
    expect(overlap.status).toBe(409);
    const overlapBody = await overlap.json();
    expect(overlapBody).toEqual({
      error: {
        code: 'LEADERBOARD_PERIOD_OVERLAP',
        message: '榜单周期不能与已有周期重叠',
      },
    });
    expect(JSON.stringify(overlapBody)).not.toContain('SQLite');
    expect(JSON.stringify(overlapBody)).not.toContain('leaderboard period overlaps');

    const lockedPreviousPatch = await request(
      `/api/teacher/leaderboard-periods/${previousPeriodId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', Cookie: teacherCookie },
        body: JSON.stringify({ endAt: new Date(currentStart + 1000).toISOString() }),
      },
    );
    expect(lockedPreviousPatch.status).toBe(409);
    expect(await lockedPreviousPatch.json()).toEqual({
      error: {
        code: 'LEADERBOARD_PERIOD_LOCKED',
        message: '榜单周期开始后只能修改名称',
      },
    });

    const lockedCurrentPatch = await request(
      `/api/teacher/leaderboard-periods/${currentPeriodId}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', Cookie: teacherCookie },
        body: JSON.stringify({ endAt: new Date(currentEnd + 1000).toISOString() }),
      },
    );
    expect(lockedCurrentPatch.status).toBe(409);
    expect(await lockedCurrentPatch.json()).toMatchObject({
      error: { code: 'LEADERBOARD_PERIOD_LOCKED' },
    });

    const overlapPatch = await request(`/api/teacher/leaderboard-periods/${futurePeriodId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({ startAt: new Date(currentEnd - 1000).toISOString() }),
    });
    expect(overlapPatch.status).toBe(409);
    expect(await overlapPatch.json()).toMatchObject({
      error: { code: 'LEADERBOARD_PERIOD_OVERLAP' },
    });

    const rename = await request(`/api/teacher/leaderboard-periods/${previousPeriodId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({ name: '上一期（已结束）' }),
    });
    expect(rename.status).toBe(200);

    const history = await request('/api/teacher/leaderboard-periods', {
      headers: { Cookie: teacherCookie },
    });
    const historyBody = (await history.json()) as {
      items: Array<{ id: string; name: string; status: string }>;
    };
    expect(historyBody.items).toHaveLength(3);
    expect(historyBody.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: previousPeriodId, status: 'ended' }),
        expect.objectContaining({ id: currentPeriodId, status: 'active' }),
        expect.objectContaining({ id: futurePeriodId, status: 'upcoming' }),
      ]),
    );
  });

  it('attributes boundary results and builds one stable best result per student', async () => {
    const users = await env.DB.prepare(
      "SELECT id, student_no FROM users WHERE role = 'student' ORDER BY student_no",
    ).all<{ id: string; student_no: string }>();
    const userIds = new Map(users.results.map((user) => [user.student_no, user.id]));
    const statements: D1PreparedStatement[] = [];
    let resultIndex = 0;
    const addResult = (
      studentNumber: string,
      score: number,
      maxTile: number,
      validMoveCount: number,
      endedAt: number,
    ) => {
      resultIndex += 1;
      statements.push(
        env.DB.prepare(
          `INSERT INTO practice_results (
             id, challenge_id, user_id, engine_version, score, max_tile,
             valid_move_count, final_board_json, started_at, ended_at
           ) VALUES (?, ?, ?, 'test-engine', ?, ?, ?, ?, ?, ?)`,
        ).bind(
          `result-${resultIndex}`,
          `challenge-${resultIndex}`,
          userIds.get(studentNumber),
          score,
          maxTile,
          validMoveCount,
          JSON.stringify(['secret-final-board', resultIndex]),
          endedAt - 1000,
          endedAt,
        ),
      );
    };

    for (let index = 1; index <= 25; index += 1) {
      const metrics = scoreForStudent(index);
      addResult(
        `2026${String(index).padStart(4, '0')}`,
        metrics.score,
        metrics.maxTile,
        metrics.validMoveCount,
        index === 1 ? currentStart : currentStart + index * 1000,
      );
    }
    addResult('20260001', 10_000, 1024, 100, currentStart + 50_000);
    addResult('20260024', 100, 2, 999, currentStart + 60_000);
    addResult('20260001', 5_000, 256, 300, currentStart - 1);
    addResult('20260001', 50_000, 2048, 50, currentEnd);
    await env.DB.batch(statements);

    await env.DB.prepare(
      `UPDATE users
       SET login_id = ' 20260001 ', student_no = ' 20260001 ', display_name = '  张三😀  '
       WHERE id = ?`,
    )
      .bind(userIds.get('20260001'))
      .run();
    await env.DB.prepare(
      `UPDATE users
       SET login_id = '7', student_no = '7', display_name = ' 王 '
       WHERE id = ?`,
    )
      .bind(userIds.get('20260025'))
      .run();
  });

  it('gives teachers complete independently-ranked overall and grade views', async () => {
    const overallResponse = await request(
      `/api/teacher/leaderboards/practice?periodId=${currentPeriodId}`,
      { headers: { Cookie: teacherCookie } },
    );
    expect(overallResponse.status).toBe(200);
    const overall = (await overallResponse.json()) as {
      participantCount: number;
      entries: Array<{
        rank: number;
        studentNumber: string;
        score: number;
        endedAt: string;
        validMoveCount: number;
      }>;
    };
    expect(overall.participantCount).toBe(25);
    expect(overall.entries).toHaveLength(25);
    expect(overall.entries.slice(0, 3).map((entry) => entry.rank)).toEqual([1, 1, 3]);
    expect(overall.entries.filter((entry) => entry.rank === 20)).toHaveLength(2);
    expect(overall.entries.find((entry) => entry.rank === 24)?.score).toBe(7700);
    expect(overall.entries[0].endedAt).toBe(new Date(currentStart).toISOString());
    expect(overall.entries[0].validMoveCount).toBe(100);

    const gradeResponse = await request(
      `/api/teacher/leaderboards/practice?periodId=${currentPeriodId}&gradeLevel=6`,
      { headers: { Cookie: teacherCookie } },
    );
    const grade = (await gradeResponse.json()) as {
      gradeLevel: number;
      participantCount: number;
      entries: Array<{ rank: number; studentNumber: string }>;
    };
    expect(grade.gradeLevel).toBe(6);
    expect(grade.participantCount).toBe(13);
    expect(grade.entries).toHaveLength(13);
    expect(grade.entries.at(-1)).toMatchObject({ rank: 13, studentNumber: '20260024' });

    const previous = await request(
      `/api/teacher/leaderboards/practice?periodId=${previousPeriodId}`,
      { headers: { Cookie: teacherCookie } },
    );
    expect(await previous.json()).toMatchObject({
      participantCount: 1,
      entries: [{ score: 5000 }],
    });
    const future = await request(`/api/teacher/leaderboards/practice?periodId=${futurePeriodId}`, {
      headers: { Cookie: teacherCookie },
    });
    expect(await future.json()).toMatchObject({
      participantCount: 1,
      entries: [{ score: 50000 }],
    });
  });

  it('returns top-20 rank ties plus self without sensitive student fields', async () => {
    const response = await request('/api/leaderboard?type=practice&period=current', {
      headers: { Cookie: currentStudentCookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      overall: {
        participantCount: number;
        currentUserRank: number;
        entries: Array<Record<string, unknown>>;
      };
      grade: {
        status: string;
        gradeLevel: number;
        participantCount: number;
        currentUserRank: number;
        entries: Array<Record<string, unknown>>;
      };
    };
    expect(body.status).toBe('available');
    expect(body.overall.participantCount).toBe(25);
    expect(body.overall.currentUserRank).toBe(24);
    expect(body.overall.entries).toHaveLength(22);
    expect(body.overall.entries.filter((entry) => entry.rank === 20)).toHaveLength(2);
    expect(body.overall.entries).toEqual(
      expect.arrayContaining([expect.objectContaining({ rank: 24, isCurrentUser: true })]),
    );
    expect(body.grade).toMatchObject({
      status: 'available',
      gradeLevel: 6,
      participantCount: 13,
      currentUserRank: 13,
    });

    const allowedKeys = [
      'className',
      'isCurrentUser',
      'maskedName',
      'maxTile',
      'rank',
      'score',
      'studentNumberSuffix',
    ];
    for (const entry of [...body.overall.entries, ...body.grade.entries]) {
      expect(Object.keys(entry).sort()).toEqual(allowedKeys);
    }
    expect(body.overall.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ maskedName: '张三*', studentNumberSuffix: '260001' }),
      ]),
    );
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      'validMoveCount',
      'endedAt',
      'studentId',
      'userId',
      'finalBoard',
      'final_board_json',
      'secret-final-board',
      '张三😀',
      '20260001',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('returns an explicit grade-null state and handles masking boundaries', async () => {
    expect(maskStudentName('')).toBe('*');
    expect(maskStudentName(' 王 ')).toBe('*');
    expect(maskStudentName(' 张三😀 ')).toBe('张三*');
    expect(studentNumberSuffix('')).toBe('******');
    expect(studentNumberSuffix('12')).toBe('****12');
    expect(studentNumberSuffix(' 20260001 ')).toBe('260001');

    const response = await request('/api/leaderboard', {
      headers: { Cookie: legacyStudentCookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      overall: {
        currentUserRank: number;
        entries: Array<Record<string, unknown>>;
      };
      grade: unknown;
    };
    expect(body.grade).toEqual({
      status: 'grade_missing',
      gradeLevel: null,
      participantCount: 0,
      currentUserRank: null,
      entries: [],
    });
    expect(body.overall.currentUserRank).toBe(25);
    expect(body.overall.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rank: 25,
          maskedName: '*',
          studentNumberSuffix: '*****7',
          isCurrentUser: true,
        }),
      ]),
    );

    const firstStudent = await request('/api/leaderboard', {
      headers: { Cookie: firstStudentCookie },
    });
    expect(firstStudent.status).toBe(200);
  });
});
