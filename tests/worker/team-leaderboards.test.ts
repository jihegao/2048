import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const origin = 'https://example.com';

async function login(loginId: string, password: string): Promise<string> {
  const response = await exports.default.fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId, password, locale: 'zh-CN' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';', 1)[0];
}

describe('retired personal-score team leaderboard', () => {
  it('does not expose practice sums through either old team endpoint', async () => {
    const teacher = await login('teacher', 'integration-teacher-password');
    const teacherResponse = await exports.default.fetch(
      `${origin}/api/teacher/leaderboards/teams?periodId=old-period`,
      { headers: { Cookie: teacher } },
    );
    expect(teacherResponse.status).toBe(410);
    expect(await teacherResponse.json()).toMatchObject({
      error: { code: 'TEAM_LEADERBOARD_REPLACED' },
    });

    const rows = [
      { studentNumber: 'RETIRED-TEAM-BOARD', name: '测试学生', className: '六班', gradeLevel: 6 },
    ];
    const preview = await exports.default.fetch(`${origin}/api/teacher/users/import/validate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacher },
      body: JSON.stringify({ rows }),
    });
    const { token } = (await preview.json()) as { token: string };
    const commit = await exports.default.fetch(`${origin}/api/teacher/users/import/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacher },
      body: JSON.stringify({ rows, token }),
    });
    expect(commit.status).toBe(200);
    const student = await login('RETIRED-TEAM-BOARD', 'integration-student-password');
    const studentResponse = await exports.default.fetch(`${origin}/api/leaderboard/teams`, {
      headers: { Cookie: student },
    });
    expect(studentResponse.status).toBe(410);
    expect(await studentResponse.json()).toMatchObject({
      error: { code: 'TEAM_LEADERBOARD_REPLACED' },
    });
  });
});
