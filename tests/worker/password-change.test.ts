import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const origin = 'https://example.com';
const teacherPassword = 'integration-teacher-password';
const studentPassword = 'integration-student-password';

async function request(path: string, init: RequestInit = {}) {
  return exports.default.fetch(`${origin}${path}`, init);
}

async function loginResponse(loginId: string, password: string): Promise<Response> {
  return request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId, password, locale: 'zh-CN' }),
  });
}

async function login(loginId: string, password: string): Promise<string> {
  const response = await loginResponse(loginId, password);
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';', 1)[0];
}

async function importStudent(teacher: string, studentNumber: string): Promise<void> {
  const rows = [{ studentNumber, name: `学生${studentNumber}`, className: '一班', gradeLevel: 6 }];
  const preview = await request('/api/teacher/users/import/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacher },
    body: JSON.stringify({ rows }),
  });
  expect(preview.status).toBe(200);
  const { token } = (await preview.json()) as { token: string };
  const commit = await request('/api/teacher/users/import/commit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacher },
    body: JSON.stringify({ rows, token }),
  });
  expect(commit.status).toBe(200);
}

async function changePassword(
  cookie: string | undefined,
  currentPassword: string,
  newPassword: string,
): Promise<Response> {
  return request('/api/me/password', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

describe.sequential('personal password changes', () => {
  it('requires an authenticated user', async () => {
    const response = await changePassword(undefined, teacherPassword, 'new-password-value');
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });

  it('keeps the password and current session when the current password is wrong', async () => {
    const session = await login('teacher', teacherPassword);
    const response = await changePassword(session, 'wrong-current-password', 'new-password-value');
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      error: { code: 'CURRENT_PASSWORD_INCORRECT', message: '当前密码不正确' },
    });

    const me = await request('/api/me', { headers: { Cookie: session } });
    expect(await me.json()).toMatchObject({ user: { loginId: 'teacher' } });
    expect((await loginResponse('teacher', teacherPassword)).status).toBe(200);
  });

  it.each([
    ['short', teacherPassword, 'too-short'],
    ['unchanged', teacherPassword, teacherPassword],
    ['too long', teacherPassword, 'x'.repeat(257)],
  ])('rejects a %s new password', async (_case, currentPassword, newPassword) => {
    const session = await login('teacher', teacherPassword);
    const response = await changePassword(session, currentPassword, newPassword);
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it("lets a student change their password and invalidates only that user's sessions", async () => {
    const teacher = await login('teacher', teacherPassword);
    await importStudent(teacher, 'PASSWORD-STUDENT');
    const firstSession = await login('PASSWORD-STUDENT', studentPassword);
    const secondSession = await login('PASSWORD-STUDENT', studentPassword);
    const newPassword = 'student-password-after-change';

    const response = await changePassword(firstSession, studentPassword, newPassword);
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('__Host-session=');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await response.json()).toMatchObject({ ok: true });

    for (const session of [firstSession, secondSession]) {
      const me = await request('/api/me', { headers: { Cookie: session } });
      expect(await me.json()).toEqual({ user: null });
    }
    const teacherMe = await request('/api/me', { headers: { Cookie: teacher } });
    expect(await teacherMe.json()).toMatchObject({ user: { role: 'teacher' } });
    expect((await loginResponse('PASSWORD-STUDENT', studentPassword)).status).toBe(401);
    expect((await loginResponse('PASSWORD-STUDENT', newPassword)).status).toBe(200);
  });

  it('lets the teacher change their own password and invalidates every teacher session', async () => {
    const firstSession = await login('teacher', teacherPassword);
    const secondSession = await login('teacher', teacherPassword);
    const newPassword = 'teacher-password-after-change';

    const response = await changePassword(firstSession, teacherPassword, newPassword);
    expect(response.status).toBe(200);
    for (const session of [firstSession, secondSession]) {
      const me = await request('/api/me', { headers: { Cookie: session } });
      expect(await me.json()).toEqual({ user: null });
    }
    expect((await loginResponse('teacher', teacherPassword)).status).toBe(401);
    expect((await loginResponse('teacher', newPassword)).status).toBe(200);
  });
});
