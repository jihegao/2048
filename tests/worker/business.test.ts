import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const origin = 'https://example.com';
const teacherPassword = 'integration-teacher-password';
const studentPassword = 'integration-student-password';

async function request(path: string, init: RequestInit = {}) {
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

async function importRows(
  cookie: string,
  type: 'users' | 'teams',
  rows: unknown[],
): Promise<Response> {
  const base = `/api/teacher/${type}`;
  const previewResponse = await request(`${base}/import/validate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ rows }),
  });
  expect(previewResponse.status).toBe(200);
  const preview = (await previewResponse.json()) as {
    token: string;
    errors: unknown[];
  };
  expect(preview.errors).toEqual([]);
  return request(`${base}/import/commit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ rows, token: preview.token }),
  });
}

describe.sequential('business workflows', () => {
  it('keeps existing passwords while incrementally updating imported students', async () => {
    const teacher = await login('teacher', teacherPassword);
    const students = [
      { studentNumber: 'S001', name: '学生一', className: '一班' },
      { studentNumber: 'S002', name: '学生二', className: '一班' },
      { studentNumber: 'S003', name: '学生三', className: '一班' },
      { studentNumber: 'S004', name: '学生四', className: '二班' },
      { studentNumber: 'S005', name: '学生五', className: '二班' },
    ];
    expect((await importRows(teacher, 'users', students)).status).toBe(200);
    expect(await login('S001', studentPassword)).toContain('__Host-session=');

    const updated = [{ studentNumber: 'S001', name: '学生一新', className: '三班' }];
    expect((await importRows(teacher, 'users', updated)).status).toBe(200);
    const studentCookie = await login('S001', studentPassword);
    const me = await request('/api/me', { headers: { Cookie: studentCookie } });
    expect(await me.json()).toMatchObject({ user: { name: '学生一新', className: '三班' } });
  });

  it('rejects a student number that collides with the teacher login', async () => {
    const teacher = await login('teacher', teacherPassword);
    const response = await request('/api/teacher/users/import/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacher },
      body: JSON.stringify({
        rows: [{ studentNumber: 'teacher', name: '冲突账号', className: '一班' }],
      }),
    });
    expect(response.status).toBe(200);
    const preview = (await response.json()) as { errors: Array<{ message: string }> };
    expect(preview.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ message: '学号与教师账号冲突' })]),
    );
  });

  it('rolls back a conflicting team import without creating a partial team', async () => {
    const teacher = await login('teacher', teacherPassword);
    const firstTeam = [{ name: '甲队', memberStudentNumbers: ['S001', 'S002', 'S003'] }];
    expect((await importRows(teacher, 'teams', firstTeam)).status).toBe(200);

    const conflictRows = [{ name: '乙队', memberStudentNumbers: ['S001', 'S004', 'S005'] }];
    const preview = await request('/api/teacher/teams/import/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacher },
      body: JSON.stringify({ rows: conflictRows }),
    });
    const body = (await preview.json()) as { token: string; errors: unknown[] };
    expect(body.errors.length).toBeGreaterThan(0);
    const commit = await request('/api/teacher/teams/import/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacher },
      body: JSON.stringify({ rows: conflictRows, token: body.token }),
    });
    expect(commit.status).toBe(422);
    const teams = await request('/api/teacher/teams?query=%E4%B9%99%E9%98%9F', {
      headers: { Cookie: teacher },
    });
    expect(await teams.json()).toMatchObject({ total: 0, items: [] });
  });

  it('allows only one concurrent active room per student', async () => {
    const teacher = await login('teacher', teacherPassword);
    const student = await login('S001', studentPassword);
    const createRoom = async (name: string) => {
      const response = await request('/api/teacher/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: teacher },
        body: JSON.stringify({ name, mode: 'duel', durationMinutes: 1 }),
      });
      return ((await response.json()) as { room: { id: string } }).room.id;
    };
    const roomIds = await Promise.all([createRoom('并发房间一'), createRoom('并发房间二')]);
    const responses = await Promise.all(
      roomIds.map((roomId) =>
        request(`/api/rooms/${roomId}/join`, { method: 'POST', headers: { Cookie: student } }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
  });

  it('invalidates every old session after a password reset', async () => {
    const teacher = await login('teacher', teacherPassword);
    const oldSession = await login('S004', studentPassword);
    const usersResponse = await request('/api/teacher/users?query=S004', {
      headers: { Cookie: teacher },
    });
    const users = (await usersResponse.json()) as { items: Array<{ id: string }> };
    const reset = await request(`/api/teacher/users/${users.items[0].id}/reset-password`, {
      method: 'POST',
      headers: { Cookie: teacher },
    });
    expect(reset.status).toBe(200);
    const me = await request('/api/me', { headers: { Cookie: oldSession } });
    expect(await me.json()).toEqual({ user: null });
    expect(await login('S004', studentPassword)).toContain('__Host-session=');
  });
});
