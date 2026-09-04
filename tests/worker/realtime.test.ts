import { env, exports } from 'cloudflare:workers';
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { GameSnapshot, ServerPlayerState } from '../../shared/types';
import { projectMove } from '../../shared/game';
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

async function nextMessage(socket: WebSocket): Promise<ServerPlayerState> {
  return new Promise((resolve, reject) => {
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
}

describe('authoritative room Durable Object', () => {
  it('survives a runtime restart, gives control to the newest tab, and settles exactly once', async () => {
    const teacher = await login('teacher', 'integration-teacher-password');
    const students = [
      { studentNumber: 'P001', name: '选手一', className: '一班', gradeLevel: 6 },
      { studentNumber: 'P002', name: '选手二', className: '一班', gradeLevel: 6 },
      { studentNumber: 'P003', name: '非参赛学生', className: '一班', gradeLevel: 6 },
    ];
    const previewResponse = await request('/api/teacher/users/import/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacher },
      body: JSON.stringify({ rows: students }),
    });
    const preview = (await previewResponse.json()) as { token: string };
    const commit = await request('/api/teacher/users/import/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacher },
      body: JSON.stringify({ rows: students, token: preview.token }),
    });
    expect(commit.status).toBe(200);
    const firstCookie = await login('P001', 'integration-student-password');
    const secondCookie = await login('P002', 'integration-student-password');
    const nonParticipantCookie = await login('P003', 'integration-student-password');

    const roomResponse = await request('/api/teacher/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacher },
      body: JSON.stringify({ name: '实时测试房间', mode: 'duel', durationMinutes: 1 }),
    });
    const roomId = ((await roomResponse.json()) as { room: { id: string } }).room.id;
    expect(
      (
        await request(`/api/rooms/${roomId}/join`, {
          method: 'POST',
          headers: { Cookie: firstCookie },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await request(`/api/rooms/${roomId}/join`, {
          method: 'POST',
          headers: { Cookie: secondCookie },
        })
      ).status,
    ).toBe(200);
    const requestedStartAt = Date.now();
    const startResponse = await request(`/api/teacher/rooms/${roomId}/start`, {
      method: 'POST',
      headers: { Cookie: teacher },
    });
    expect(startResponse.status).toBe(200);
    const start = (await startResponse.json()) as { startsAt: number; endsAt: number };
    expect(start.startsAt - requestedStartAt).toBeGreaterThanOrEqual(2500);
    expect(start.startsAt - requestedStartAt).toBeLessThanOrEqual(4000);
    expect(start.endsAt - start.startsAt).toBe(60_000);

    let stub = env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomSession>;
    await runInDurableObject(stub, async (instance: RoomSession, state) => {
      const target = instance as unknown as {
        runtime: {
          startsAt: number;
          endsAt: number;
          status: string;
          players: Array<{ userId: string; game: GameSnapshot }>;
        };
      };
      target.runtime.startsAt = Date.now() - 1;
      target.runtime.endsAt = Date.now() + 60_000;
      await state.storage.put('room-runtime', target.runtime);
      return new Response('ok');
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const newerRoomResponse = await request('/api/teacher/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacher },
      body: JSON.stringify({ name: '更新的开放房间', mode: 'duel', durationMinutes: 1 }),
    });
    expect(newerRoomResponse.status).toBe(201);

    const roomListResponse = await request('/api/rooms?pageSize=20', {
      headers: { Cookie: firstCookie },
    });
    expect(roomListResponse.status).toBe(200);
    const roomList = (await roomListResponse.json()) as {
      items: Array<{ id: string; status: string; isParticipant: boolean }>;
    };
    expect(roomList.items[0]).toMatchObject({
      id: roomId,
      status: 'live',
      isParticipant: true,
    });
    const rejoinResponse = await request(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { Cookie: firstCookie },
    });
    expect(rejoinResponse.status).toBe(200);
    expect(await rejoinResponse.json()).toMatchObject({
      ok: true,
      alreadyParticipant: true,
      roomStatus: 'live',
    });
    const blockedRejoin = await request(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { Cookie: nonParticipantCookie },
    });
    expect(blockedRejoin.status).toBe(409);
    const nonParticipantRooms = (await (
      await request('/api/rooms?pageSize=20', { headers: { Cookie: nonParticipantCookie } })
    ).json()) as { items: Array<{ id: string; isParticipant: boolean }> };
    expect(nonParticipantRooms.items.find((room) => room.id === roomId)?.isParticipant).toBe(false);

    const studentSnapshotResponse = await request(`/api/rooms/${roomId}/match`, {
      headers: { Cookie: firstCookie },
    });
    const studentSnapshot = (await studentSnapshotResponse.json()) as Record<string, unknown>;
    expect(studentSnapshot).toHaveProperty('game');
    expect(studentSnapshot).not.toHaveProperty('players');
    const teacherSnapshotResponse = await request(`/api/teacher/rooms/${roomId}/live`, {
      headers: { Cookie: teacher },
    });
    const teacherSnapshot = (await teacherSnapshotResponse.json()) as {
      players: Array<{ game: GameSnapshot }>;
    };
    expect(teacherSnapshot.players).toHaveLength(2);
    expect(teacherSnapshot.players.every((candidate) => candidate.game.board.length === 16)).toBe(
      true,
    );

    const player = await env.DB.prepare("SELECT id FROM users WHERE login_id = 'P001'").first<{
      id: string;
    }>();
    const connect = async (captureInitial: boolean) => {
      const response = await stub.fetch('https://room.internal/ws', {
        headers: {
          Upgrade: 'websocket',
          'X-Room-Id': roomId,
          'X-Role': 'student',
          'X-User-Id': player!.id,
        },
      });
      expect(response.status).toBe(101);
      const socket = response.webSocket!;
      const initialState = captureInitial ? nextMessage(socket) : null;
      socket.accept();
      return { socket, initialState };
    };

    const firstConnection = await connect(true);
    const firstTab = firstConnection.socket;
    const initialPlayerState = await firstConnection.initialState!;
    expect(initialPlayerState.canControl).toBe(true);
    const validDirection = (['up', 'down', 'left', 'right'] as const).find(
      (direction) => projectMove(initialPlayerState.game!.board, direction).moved,
    )!;
    const firstTabUpdate = nextMessage(firstTab);
    const secondConnection = await connect(false);
    const secondTab = secondConnection.socket;
    const oldTabState = await firstTabUpdate;
    expect(oldTabState.canControl).toBe(false);

    const rejectedMove = nextMessage(firstTab);
    firstTab.send(JSON.stringify({ type: 'move', seq: 1, direction: validDirection }));
    expect((await rejectedMove).game?.seq).toBe(0);

    const moveResult = nextMessage(firstTab);
    secondTab.send(JSON.stringify({ type: 'move', seq: 1, direction: validDirection }));
    expect((await moveResult).game?.seq).toBe(1);
    firstTab.close(1000);
    secondTab.close(1000);
    await abortAllDurableObjects();
    stub = env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomSession>;
    const afterEviction = await stub.fetch('https://room.internal/snapshot', {
      headers: { 'X-Room-Id': roomId, 'X-Role': 'student', 'X-User-Id': player!.id },
    });
    expect((await afterEviction.json()) as ServerPlayerState).toMatchObject({
      roomStatus: 'live',
      game: { seq: 1 },
    });
    const returnResponse = await request(`/api/rooms/${roomId}/ws`, {
      headers: { Cookie: firstCookie, Upgrade: 'websocket' },
    });
    expect(returnResponse.status).toBe(101);
    const returnSocket = returnResponse.webSocket!;
    const returnedState = nextMessage(returnSocket);
    returnSocket.accept();
    expect(await returnedState).toMatchObject({
      roomStatus: 'live',
      canControl: true,
      game: { seq: 1 },
    });
    returnSocket.close(1000);

    await runInDurableObject(stub, async (instance: RoomSession, state) => {
      const target = instance as unknown as {
        runtime: { endsAt: number; status: string };
      };
      target.runtime.status = 'live';
      target.runtime.endsAt = Date.now() - 1;
      await state.storage.put('room-runtime', target.runtime);
      return new Response('ok');
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM match_players WHERE room_id = ?')
        .bind(roomId)
        .first(),
    ).toMatchObject({ count: 2 });
    expect(
      await env.DB.prepare('SELECT status, finish_reason FROM rooms WHERE id = ?')
        .bind(roomId)
        .first(),
    ).toMatchObject({ status: 'ended', finish_reason: 'time_limit' });
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM match_players WHERE room_id = ?')
        .bind(roomId)
        .first(),
    ).toMatchObject({ count: 2 });

    const details = await request(`/api/teacher/results/${roomId}`, {
      headers: { Cookie: teacher },
    });
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({ result: { id: roomId, players: [{}, {}] } });
    const csv = await request('/api/teacher/results/export.csv', {
      headers: { Cookie: teacher },
    });
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('房间编号,房间名称,模式,配置时长（分钟）');
    const xlsx = await request('/api/teacher/results/export.xlsx', {
      headers: { Cookie: teacher },
    });
    expect(xlsx.headers.get('content-type')).toContain('spreadsheetml.sheet');
    expect([...new Uint8Array(await xlsx.arrayBuffer()).slice(0, 2)]).toEqual([0x50, 0x4b]);

    const tenMinuteRoomResponse = await request('/api/teacher/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacher },
      body: JSON.stringify({ name: '十分钟房间', mode: 'duel', durationMinutes: 10 }),
    });
    const tenMinuteRoomId = ((await tenMinuteRoomResponse.json()) as { room: { id: string } }).room
      .id;
    for (const cookie of [firstCookie, secondCookie]) {
      expect(
        (
          await request(`/api/rooms/${tenMinuteRoomId}/join`, {
            method: 'POST',
            headers: { Cookie: cookie },
          })
        ).status,
      ).toBe(200);
    }
    const tenMinuteStart = await request(`/api/teacher/rooms/${tenMinuteRoomId}/start`, {
      method: 'POST',
      headers: { Cookie: teacher },
    });
    const tenMinuteTiming = (await tenMinuteStart.json()) as {
      startsAt: number;
      endsAt: number;
    };
    expect(tenMinuteTiming.endsAt - tenMinuteTiming.startsAt).toBe(600_000);
  }, 15_000);
});
