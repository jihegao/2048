import { exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const origin = 'https://example.com';

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
  const setCookie = response.headers.get('set-cookie');
  expect(setCookie).toContain('__Host-session=');
  return setCookie!.split(';', 1)[0];
}

async function teacherCookie(): Promise<string> {
  return login('teacher', 'integration-teacher-password');
}

describe('authentication and authorization', () => {
  it('bootstraps the only teacher and creates an eight-hour secure session', async () => {
    const response = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        loginId: 'teacher',
        password: 'integration-teacher-password',
        locale: 'en',
      }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('__Host-session=');
    expect(cookie).toContain('Max-Age=28800');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
    expect(await response.json()).toMatchObject({ user: { role: 'teacher', locale: 'en' } });
  });

  it('rejects cross-origin mutations', async () => {
    const response = await request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Origin: 'https://attacker.example' },
      body: JSON.stringify({ loginId: 'teacher', password: 'wrong' }),
    });
    expect(response.status).toBe(403);
  });
});

describe('room duration validation', () => {
  it.each([
    [0, 422],
    [11, 422],
    [-1, 422],
    [1.5, 422],
    ['5', 422],
    [1, 201],
    [5, 201],
    [10, 201],
  ])('validates duration %s', async (durationMinutes, expectedStatus) => {
    const cookie = await teacherCookie();
    const response = await request('/api/teacher/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        name: `room-${String(durationMinutes)}`,
        mode: 'duel',
        durationMinutes,
      }),
    });
    expect(response.status).toBe(expectedStatus);
  });

  it('uses five minutes when duration is omitted', async () => {
    const cookie = await teacherCookie();
    const response = await request('/api/teacher/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: 'default-duration', mode: 'duel' }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ room: { durationMinutes: 5 } });
  });

  it.each([
    [0, 422],
    [11, 422],
    [-1, 422],
    [1.5, 422],
    ['5', 422],
    [1, 200],
    [5, 200],
    [10, 200],
  ])('validates updated duration %s', async (durationMinutes, expectedStatus) => {
    const cookie = await teacherCookie();
    const create = await request('/api/teacher/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: `patch-${String(durationMinutes)}`, mode: 'duel' }),
    });
    const roomId = ((await create.json()) as { room: { id: string } }).room.id;
    const response = await request(`/api/teacher/rooms/${roomId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ durationMinutes }),
    });
    expect(response.status).toBe(expectedStatus);
  });
});

describe('import request limits', () => {
  it('rejects oversized import payloads before parsing them', async () => {
    const cookie = await teacherCookie();
    const response = await request('/api/teacher/users/import/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ rows: ['x'.repeat(8 * 1024 * 1024)] }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: 'IMPORT_PAYLOAD_TOO_LARGE', message: '导入请求体积过大' },
    });
  });
});
