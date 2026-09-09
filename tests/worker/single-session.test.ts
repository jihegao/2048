import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SESSION_REPLACED_CLOSE_CODE, type ServerPlayerState } from '../../shared/types';
import { RoomSession } from '../../worker/durable/room-session';
import { persistSessionRecord, SESSION_COOKIE } from '../../worker/lib/auth';

const origin = 'https://example.com';

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

async function me(cookie: string): Promise<unknown> {
  const response = await request('/api/me', { headers: { Cookie: cookie } });
  return ((await response.json()) as { user: unknown }).user;
}

async function importStudents(teacherCookie: string) {
  const students = [
    { studentNumber: 'P201', name: '单点一', className: '一班', gradeLevel: 6 },
    { studentNumber: 'P202', name: '单点二', className: '一班', gradeLevel: 6 },
  ];
  const previewResponse = await request('/api/teacher/users/import/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({ rows: students }),
  });
  const preview = (await previewResponse.json()) as { token: string };
  const commit = await request('/api/teacher/users/import/commit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({ rows: students, token: preview.token }),
  });
  expect(commit.status).toBe(200);
}

describe('student single-session login', () => {
  it('invalidates the previous student session and closes its live room socket', async () => {
    const teacher = await login('teacher', 'integration-teacher-password');
    await importStudents(teacher);
    const firstCookie = await login('P201', 'integration-student-password');
    const peerCookie = await login('P202', 'integration-student-password');

    const roomResponse = await request('/api/teacher/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacher },
      body: JSON.stringify({ name: '单点登录房间', mode: 'duel', durationMinutes: 1 }),
    });
    const roomId = ((await roomResponse.json()) as { room: { id: string } }).room.id;
    for (const cookie of [firstCookie, peerCookie]) {
      expect(
        (
          await request(`/api/rooms/${roomId}/join`, {
            method: 'POST',
            headers: { Cookie: cookie },
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (
        await request(`/api/teacher/rooms/${roomId}/start`, {
          method: 'POST',
          headers: { Cookie: teacher },
        })
      ).status,
    ).toBe(200);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomSession>;
    await runInDurableObject(stub, async (instance: RoomSession, state) => {
      const target = instance as unknown as { runtime: { startsAt: number; endsAt: number } };
      target.runtime.startsAt = Date.now() - 1;
      target.runtime.endsAt = Date.now() + 60_000;
      await state.storage.put('room-runtime', target.runtime);
      return new Response('ok');
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const socketResponse = await request(`/api/rooms/${roomId}/ws`, {
      headers: { Cookie: firstCookie, Upgrade: 'websocket' },
    });
    expect(socketResponse.status).toBe(101);
    const socket = socketResponse.webSocket!;
    const initialState = new Promise<ServerPlayerState>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket message timeout')), 2000);
      socket.addEventListener(
        'message',
        (event) => {
          clearTimeout(timer);
          resolve(JSON.parse(String(event.data)) as ServerPlayerState);
        },
        { once: true },
      );
    });
    socket.accept();
    expect(await initialState).toMatchObject({ roomStatus: 'live', canControl: true });

    const closedCode = new Promise<number | undefined>((resolve) => {
      socket.addEventListener('close', (event: CloseEvent) => resolve(event.code), { once: true });
    });
    const secondCookie = await login('P201', 'integration-student-password');

    const staleMeResponse = await request('/api/me', { headers: { Cookie: firstCookie } });
    expect(staleMeResponse.headers.get('set-cookie')).toBeNull();
    expect(await staleMeResponse.json()).toEqual({ user: null });
    const currentUser = await me(secondCookie);
    expect(currentUser).toMatchObject({ loginId: 'P201' });
    expect(currentUser).not.toHaveProperty('sessionHash');
    expect(await me(peerCookie)).toMatchObject({ loginId: 'P202' });
    const sessionCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE user_id = (SELECT id FROM users WHERE login_id = 'P201')",
    ).first<{ count: number }>();
    expect(sessionCount!.count).toBe(1);
    expect(await closedCode).toBe(SESSION_REPLACED_CLOSE_CODE);

    // The NEW session's socket must survive a delayed kick from an older login.
    const newSocketResponse = await request(`/api/rooms/${roomId}/ws`, {
      headers: { Cookie: secondCookie, Upgrade: 'websocket' },
    });
    expect(newSocketResponse.status).toBe(101);
    const newSocket = newSocketResponse.webSocket!;
    const newInitialState = new Promise<ServerPlayerState>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket message timeout')), 2000);
      newSocket.addEventListener(
        'message',
        (event) => {
          clearTimeout(timer);
          resolve(JSON.parse(String(event.data)) as ServerPlayerState);
        },
        { once: true },
      );
    });
    newSocket.accept();
    expect(await newInitialState).toMatchObject({ roomStatus: 'live', canControl: true });
    const newClosed = new Promise<number | undefined>((resolve) => {
      newSocket.addEventListener('close', (event: CloseEvent) => resolve(event.code), {
        once: true,
      });
    });
    const studentRow = await env.DB.prepare("SELECT id FROM users WHERE login_id = 'P201'").first<{
      id: string;
    }>();
    const delayedKick = await stub.fetch('https://room.internal/kick', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-Room-Id': roomId },
      body: JSON.stringify({ userId: studentRow!.id }),
    });
    expect(delayedKick.status).toBe(200);
    const outcome = await Promise.race([
      newClosed.then(() => 'closed' as const),
      new Promise((resolve) => setTimeout(() => resolve('open' as const), 500)),
    ]);
    expect(outcome).toBe('open');

    // Even if proactive reconciliation is unavailable, the next player
    // message must revalidate the attached session and fail closed.
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(studentRow!.id).run();
    newSocket.send(JSON.stringify({ type: 'move', seq: 1, direction: 'left' }));
    expect(await newClosed).toBe(SESSION_REPLACED_CLOSE_CODE);

    // An upgrade carrying a dead session hash is rejected by the DO itself.
    const deadHashSocketResponse = await stub.fetch('https://room.internal/ws', {
      headers: {
        Upgrade: 'websocket',
        'X-Room-Id': roomId,
        'X-Role': 'student',
        'X-User-Id': studentRow!.id,
        'X-Session-Hash': 'dead-session-hash',
      },
    });
    expect(deadHashSocketResponse.status).toBe(101);
    const deadHashSocket = deadHashSocketResponse.webSocket!;
    const deadClosed = new Promise<number | undefined>((resolve) => {
      deadHashSocket.addEventListener('close', (event: CloseEvent) => resolve(event.code), {
        once: true,
      });
    });
    deadHashSocket.accept();
    expect(await deadClosed).toBe(SESSION_REPLACED_CLOSE_CODE);

    const missingHashSocketResponse = await stub.fetch('https://room.internal/ws', {
      headers: {
        Upgrade: 'websocket',
        'X-Room-Id': roomId,
        'X-Role': 'student',
        'X-User-Id': studentRow!.id,
      },
    });
    expect(missingHashSocketResponse.status).toBe(101);
    const missingHashSocket = missingHashSocketResponse.webSocket!;
    const missingHashClosed = new Promise<number | undefined>((resolve) => {
      missingHashSocket.addEventListener('close', (event: CloseEvent) => resolve(event.code), {
        once: true,
      });
    });
    missingHashSocket.accept();
    expect(await missingHashClosed).toBe(SESSION_REPLACED_CLOSE_CODE);
  }, 15_000);

  it('keeps teacher sessions unlimited', async () => {
    const first = await login('teacher', 'integration-teacher-password');
    const second = await login('teacher', 'integration-teacher-password');
    expect(await me(first)).toMatchObject({ loginId: 'teacher' });
    expect(await me(second)).toMatchObject({ loginId: 'teacher' });
  });

  it('revokes an unselected legacy cookie instead of falling back to its identity', async () => {
    const teacherCookie = await login('teacher', 'integration-teacher-password');
    await importStudents(teacherCookie);
    await env.DB.prepare(
      "UPDATE sessions SET created_at = 0 WHERE user_id = (SELECT id FROM users WHERE login_id = 'teacher')",
    ).run();
    const legacyTeacherCookie = `${SESSION_COOKIE}=${teacherCookie.split('=', 2)[1]}`;
    const studentCookie = await login('P201', 'integration-student-password');

    const selected = await request('/api/me', {
      headers: { Cookie: `${legacyTeacherCookie}; ${studentCookie}` },
    });
    expect(await selected.json()).toMatchObject({ user: { loginId: 'P201', role: 'student' } });
    expect(selected.headers.get('set-cookie')).toBeNull();

    const legacyFallback = await request('/api/me', { headers: { Cookie: legacyTeacherCookie } });
    expect(await legacyFallback.json()).toEqual({ user: null });
  });

  it('keeps exactly one winner after concurrent student logins', async () => {
    const teacher = await login('teacher', 'integration-teacher-password');
    await importStudents(teacher);
    const responses = await Promise.all([
      loginResponse('P201', 'integration-student-password'),
      loginResponse('P201', 'integration-student-password'),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const cookies = responses.map(
      (response) => response.headers.get('set-cookie')!.split(';', 1)[0],
    );
    expect(new Set(cookies.map((cookie) => cookie.split('=', 1)[0])).size).toBe(2);
    const users = await Promise.all(cookies.map((cookie) => me(cookie)));
    expect(users.filter(Boolean)).toHaveLength(1);
    const winningCookie = cookies[users.findIndex(Boolean)];
    const losingCookie = cookies[users.findIndex((user) => !user)];
    for (const orderedCookies of [cookies, [...cookies].reverse()]) {
      const sharedBrowserMe = await request('/api/me', {
        headers: { Cookie: orderedCookies.join('; ') },
      });
      expect(await sharedBrowserMe.json()).toMatchObject({ user: { loginId: 'P201' } });
      expect(sharedBrowserMe.headers.get('set-cookie')).toContain(
        `${losingCookie.split('=', 1)[0]}=`,
      );
      expect(sharedBrowserMe.headers.get('set-cookie')).not.toContain(
        `${winningCookie.split('=', 1)[0]}=`,
      );
    }
    const sessionCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE user_id = (SELECT id FROM users WHERE login_id = 'P201')",
    ).first<{ count: number }>();
    expect(sessionCount!.count).toBe(1);
  });

  it('does not delete a valid new-password session when a stale insert is rejected', async () => {
    const teacher = await login('teacher', 'integration-teacher-password');
    await importStudents(teacher);
    const student = await env.DB.prepare(
      "SELECT id, credential_version FROM users WHERE login_id = 'P201'",
    ).first<{ id: string; credential_version: number }>();
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(student!.id).run();
    const nextCredentialVersion = student!.credential_version + 1;
    await env.DB.prepare('UPDATE users SET credential_version = ? WHERE id = ?')
      .bind(nextCredentialVersion, student!.id)
      .run();
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO sessions (
         token_hash, user_id, credential_version, created_at, expires_at, last_seen_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        'valid-new-password-session',
        student!.id,
        nextCredentialVersion,
        now,
        now + 60_000,
        now,
      )
      .run();

    const inserted = await persistSessionRecord(
      env.DB,
      { id: student!.id, role: 'student' },
      student!.credential_version,
      'stale-old-password-attempt',
      now + 1,
    );
    expect(inserted).toBe(false);
    const sessions = await env.DB.prepare(
      'SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY token_hash',
    )
      .bind(student!.id)
      .all<{ token_hash: string }>();
    expect(sessions.results).toEqual([{ token_hash: 'valid-new-password-session' }]);
  });
});
