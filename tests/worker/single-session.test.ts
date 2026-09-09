import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { ServerPlayerState } from '../../shared/types';
import { RoomSession } from '../../worker/durable/room-session';

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

    expect(await me(firstCookie)).toBeNull();
    expect(await me(secondCookie)).toMatchObject({ loginId: 'P201' });
    expect(await me(peerCookie)).toMatchObject({ loginId: 'P202' });
    const sessionCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE user_id = (SELECT id FROM users WHERE login_id = 'P201')",
    ).first<{ count: number }>();
    expect(sessionCount!.count).toBe(1);
    expect(await closedCode).toBe(4001);

    // The NEW session's socket must survive the (already-fired) kick.
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
    const outcome = await Promise.race([
      newClosed.then(() => 'closed' as const),
      new Promise((resolve) => setTimeout(() => resolve('open' as const), 500)),
    ]);
    expect(outcome).toBe('open');
    newSocket.close(1000);

    // An upgrade carrying a dead session hash is rejected by the DO itself.
    const studentRow = await env.DB.prepare("SELECT id FROM users WHERE login_id = 'P201'").first<{
      id: string;
    }>();
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
    expect(await deadClosed).toBe(4001);
  }, 15_000);

  it('keeps teacher sessions unlimited', async () => {
    const first = await login('teacher', 'integration-teacher-password');
    const second = await login('teacher', 'integration-teacher-password');
    expect(await me(first)).toMatchObject({ loginId: 'teacher' });
    expect(await me(second)).toMatchObject({ loginId: 'teacher' });
  });
});
