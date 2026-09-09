import { env, exports } from 'cloudflare:workers';
import { abortAllDurableObjects, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { GameSnapshot, ServerPlayerState } from '../../shared/types';
import { applyMove, projectMove } from '../../shared/game';
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
  it('accepts authoritative moves one-way with merged teacher snapshots', async () => {
    const teacher = await login('teacher', 'integration-teacher-password');
    const students = [
      { studentNumber: 'P301', name: '同步一', className: '一班', gradeLevel: 6 },
      { studentNumber: 'P302', name: '同步二', className: '一班', gradeLevel: 6 },
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
    const firstCookie = await login('P301', 'integration-student-password');
    const secondCookie = await login('P302', 'integration-student-password');
    const roomResponse = await request('/api/teacher/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacher },
      body: JSON.stringify({ name: '单向同步房间', mode: 'duel', durationMinutes: 1 }),
    });
    const roomId = ((await roomResponse.json()) as { room: { id: string } }).room.id;
    for (const cookie of [firstCookie, secondCookie]) {
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
      const target = instance as unknown as { runtime: { startsAt: number } };
      target.runtime.startsAt = Date.now() - 1;
      await state.storage.put('room-runtime', target.runtime);
      return new Response('ok');
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const teacherSocketResponse = await request(`/api/rooms/${roomId}/ws`, {
      headers: { Cookie: teacher, Upgrade: 'websocket' },
    });
    expect(teacherSocketResponse.status).toBe(101);
    const teacherSocket = teacherSocketResponse.webSocket!;
    const teacherInitial = nextMessage(teacherSocket);
    teacherSocket.accept();
    await teacherInitial;
    const studentSocketResponse = await request(`/api/rooms/${roomId}/ws`, {
      headers: { Cookie: firstCookie, Upgrade: 'websocket' },
    });
    expect(studentSocketResponse.status).toBe(101);
    const studentSocket = studentSocketResponse.webSocket!;
    const initialStudentPromise = nextMessage(studentSocket);
    studentSocket.accept();
    const initialStudentState = await initialStudentPromise;
    expect(initialStudentState).toMatchObject({ roomStatus: 'live', canControl: true });

    const studentMessages: ServerPlayerState[] = [];
    studentSocket.addEventListener('message', (event) => {
      studentMessages.push(JSON.parse(String(event.data)) as ServerPlayerState);
    });
    const teacherMessages: Array<Record<string, unknown>> = [];
    teacherSocket.addEventListener('message', (event) => {
      teacherMessages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });

    let game = initialStudentState.game!;
    for (let step = 0; step < 3; step += 1) {
      const direction = (['up', 'down', 'left', 'right'] as const).find(
        (candidate) => projectMove(game.board, candidate).moved,
      )!;
      game = applyMove(game, direction, Date.now()).snapshot;
      studentSocket.send(JSON.stringify({ type: 'move', seq: game.seq, direction }));
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(studentMessages).toHaveLength(0); // no per-move ACK or board downlink
    expect(teacherMessages).toHaveLength(0); // merged push waits for the ~1s window

    await runDurableObjectAlarm(stub);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const mergedSnapshots = teacherMessages.filter(
      (message) => message.type === 'teacher-snapshot',
    );
    expect(mergedSnapshots.length).toBeLessThanOrEqual(1);
    const mergedPlayers = mergedSnapshots[mergedSnapshots.length - 1]?.players as
      Array<{ studentNumber: string; game: GameSnapshot }> | undefined;
    expect(mergedPlayers?.find((player) => player.studentNumber === 'P301')?.game.seq).toBe(
      game.seq,
    );

    const playerRow = await env.DB.prepare("SELECT id FROM users WHERE login_id = 'P301'").first<{
      id: string;
    }>();
    const forgedBoardCorrection = nextMessage(studentSocket);
    studentSocket.send(
      JSON.stringify({ type: 'board', game: { ...game, score: game.score + 999_999 } }),
    );
    expect(await forgedBoardCorrection).toMatchObject({
      game: { seq: game.seq, score: game.score },
    });
    const gapCorrection = nextMessage(studentSocket);
    studentSocket.send(JSON.stringify({ type: 'move', seq: game.seq + 2, direction: 'left' }));
    expect(await gapCorrection).toMatchObject({ game: { seq: game.seq, score: game.score } });
    studentSocket.send(JSON.stringify({ type: 'move', seq: game.seq, direction: 'down' }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    const staleCheck = await stub.fetch('https://room.internal/snapshot', {
      headers: { 'X-Room-Id': roomId, 'X-Role': 'student', 'X-User-Id': playerRow!.id },
    });
    expect((await staleCheck.json()) as ServerPlayerState).toMatchObject({
      game: { seq: game.seq, score: game.score },
    });

    await runInDurableObject(stub, async (instance: RoomSession, state) => {
      const target = instance as unknown as {
        runtime: { status: string; endsAt: number };
      };
      target.runtime.status = 'live';
      target.runtime.endsAt = Date.now() - 1;
      await state.storage.put('room-runtime', target.runtime);
      return new Response('ok');
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(
      await env.DB.prepare(
        'SELECT score, valid_move_count FROM match_players WHERE room_id = ? AND user_id = ?',
      )
        .bind(roomId, playerRow!.id)
        .first(),
    ).toMatchObject({ score: game.score, valid_move_count: game.moveCount });

    studentSocket.close(1000);
    teacherSocket.close(1000);
  }, 15_000);

  it('delivers a pending teacher snapshot after an object rebuild', async () => {
    const teacher = await login('teacher', 'integration-teacher-password');
    const students = [
      { studentNumber: 'P303', name: '重建一', className: '一班', gradeLevel: 6 },
      { studentNumber: 'P304', name: '重建二', className: '一班', gradeLevel: 6 },
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
    const firstCookie = await login('P303', 'integration-student-password');
    const secondCookie = await login('P304', 'integration-student-password');
    const roomResponse = await request('/api/teacher/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacher },
      body: JSON.stringify({ name: '重建推送房间', mode: 'duel', durationMinutes: 1 }),
    });
    const roomId = ((await roomResponse.json()) as { room: { id: string } }).room.id;
    for (const cookie of [firstCookie, secondCookie]) {
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
    let stub = env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomSession>;
    await runInDurableObject(stub, async (instance: RoomSession, state) => {
      const target = instance as unknown as { runtime: { startsAt: number } };
      target.runtime.startsAt = Date.now() - 1;
      await state.storage.put('room-runtime', target.runtime);
      return new Response('ok');
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const teacherSocketResponse = await request(`/api/rooms/${roomId}/ws`, {
      headers: { Cookie: teacher, Upgrade: 'websocket' },
    });
    expect(teacherSocketResponse.status).toBe(101);
    const teacherSocket = teacherSocketResponse.webSocket!;
    const teacherInitial = nextMessage(teacherSocket);
    teacherSocket.accept();
    await teacherInitial;

    const studentSocketResponse = await request(`/api/rooms/${roomId}/ws`, {
      headers: { Cookie: firstCookie, Upgrade: 'websocket' },
    });
    expect(studentSocketResponse.status).toBe(101);
    const studentSocket = studentSocketResponse.webSocket!;
    const initialStudentPromise = nextMessage(studentSocket);
    studentSocket.accept();
    const initialStudentState = await initialStudentPromise;
    expect(initialStudentState).toMatchObject({ roomStatus: 'live', canControl: true });

    const direction = (['up', 'down', 'left', 'right'] as const).find(
      (candidate) => projectMove(initialStudentState.game!.board, candidate).moved,
    )!;
    const uploaded = applyMove(initialStudentState.game!, direction, Date.now()).snapshot;
    studentSocket.send(JSON.stringify({ type: 'move', seq: uploaded.seq, direction }));
    await new Promise((resolve) => setTimeout(resolve, 300)); // alarm armed, window not fired

    await abortAllDurableObjects();
    stub = env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomSession>;
    const lateTeacherMessages: Array<Record<string, unknown>> = [];
    const revivedTeacherResponse = await request(`/api/rooms/${roomId}/ws`, {
      headers: { Cookie: teacher, Upgrade: 'websocket' },
    });
    expect(revivedTeacherResponse.status).toBe(101);
    const revivedTeacherSocket = revivedTeacherResponse.webSocket!;
    const revivedInitial = nextMessage(revivedTeacherSocket);
    revivedTeacherSocket.accept();
    await revivedInitial;
    revivedTeacherSocket.addEventListener('message', (event) => {
      lateTeacherMessages.push(JSON.parse(String(event.data)) as Record<string, unknown>);
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lateMerged = lateTeacherMessages.filter((message) => message.type === 'teacher-snapshot');
    expect(lateMerged.length).toBeLessThanOrEqual(1);
    const latePlayers = lateMerged[lateMerged.length - 1]?.players as
      Array<{ studentNumber: string; game: GameSnapshot }> | undefined;
    expect(latePlayers?.find((player) => player.studentNumber === 'P303')?.game.seq).toBe(
      uploaded.seq,
    );
    studentSocket.close(1000);
    teacherSocket.close(1000);
    revivedTeacherSocket.close(1000);
  }, 15_000);

  it('notifies sockets opened before start when the room begins', async () => {
    const teacher = await login('teacher', 'integration-teacher-password');
    const students = [
      { studentNumber: 'P101', name: '候场一', className: '一班', gradeLevel: 6 },
      { studentNumber: 'P102', name: '候场二', className: '一班', gradeLevel: 6 },
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
    const firstCookie = await login('P101', 'integration-student-password');
    const secondCookie = await login('P102', 'integration-student-password');
    const roomResponse = await request('/api/teacher/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacher },
      body: JSON.stringify({ name: '等待推送房间', mode: 'duel', durationMinutes: 1 }),
    });
    const roomId = ((await roomResponse.json()) as { room: { id: string } }).room.id;
    for (const cookie of [firstCookie, secondCookie]) {
      expect(
        (
          await request(`/api/rooms/${roomId}/join`, {
            method: 'POST',
            headers: { Cookie: cookie },
          })
        ).status,
      ).toBe(200);
    }

    const lobbySocketResponse = await request(`/api/rooms/${roomId}/ws`, {
      headers: { Cookie: firstCookie, Upgrade: 'websocket' },
    });
    expect(lobbySocketResponse.status).toBe(101);
    const lobbySocket = lobbySocketResponse.webSocket!;
    const initial = nextMessage(lobbySocket);
    lobbySocket.accept();
    expect(await initial).toMatchObject({ type: 'state', roomStatus: 'open', game: null });

    const startNotice = nextMessage(lobbySocket);
    const startResponse = await request(`/api/teacher/rooms/${roomId}/start`, {
      method: 'POST',
      headers: { Cookie: teacher },
    });
    expect(startResponse.status).toBe(200);
    expect(await startNotice).toMatchObject({ type: 'state', roomStatus: 'countdown' });
    lobbySocket.close(1000);
  }, 15_000);

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

    const player = await env.DB.prepare(
      `SELECT u.id, s.token_hash
       FROM users u
       JOIN sessions s ON s.user_id = u.id
       WHERE u.login_id = 'P001'`,
    ).first<{ id: string; token_hash: string }>();
    const connect = async (captureInitial: boolean) => {
      const response = await stub.fetch('https://room.internal/ws', {
        headers: {
          Upgrade: 'websocket',
          'X-Room-Id': roomId,
          'X-Role': 'student',
          'X-User-Id': player!.id,
          'X-Session-Hash': player!.token_hash,
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
    const firstGame = applyMove(initialPlayerState.game!, validDirection, Date.now()).snapshot;

    // A newer tab takes control and immediately demotes the old controller,
    // without restoring per-move student broadcasts.
    const displacedControllerState = nextMessage(firstTab);
    const secondConnection = await connect(false);
    const secondTab = secondConnection.socket;
    expect(await displacedControllerState).toMatchObject({ canControl: false, game: { seq: 0 } });

    // Legacy/unknown messages and boards from non-controllers get a targeted
    // corrective state snapshot instead of being applied.
    const legacyCorrection = nextMessage(firstTab);
    firstTab.send(JSON.stringify({ type: 'move', seq: 1, direction: validDirection }));
    expect(await legacyCorrection).toMatchObject({ canControl: false, game: { seq: 0 } });
    const staleTabCorrection = nextMessage(firstTab);
    firstTab.send(JSON.stringify({ type: 'board', game: firstGame }));
    expect(await staleTabCorrection).toMatchObject({ canControl: false, game: { seq: 0 } });

    // The controller sends only directions; the server replays them and does
    // not push per-move snapshots back to student sockets.
    const secondDirection = (['up', 'down', 'left', 'right'] as const).find(
      (direction) => projectMove(firstGame.board, direction).moved,
    )!;
    const secondGame = applyMove(firstGame, secondDirection, Date.now()).snapshot;
    secondTab.send(JSON.stringify({ type: 'move', seq: firstGame.seq, direction: validDirection }));
    secondTab.send(
      JSON.stringify({ type: 'move', seq: secondGame.seq, direction: secondDirection }),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    const uploadedState = await stub.fetch('https://room.internal/snapshot', {
      headers: { 'X-Room-Id': roomId, 'X-Role': 'student', 'X-User-Id': player!.id },
    });
    expect((await uploadedState.json()) as ServerPlayerState).toMatchObject({
      roomStatus: 'live',
      game: { seq: secondGame.seq, score: secondGame.score },
    });
    firstTab.close(1000);
    secondTab.close(1000);
    await abortAllDurableObjects();
    stub = env.ROOMS.get(env.ROOMS.idFromName(roomId)) as DurableObjectStub<RoomSession>;
    const afterEviction = await stub.fetch('https://room.internal/snapshot', {
      headers: { 'X-Room-Id': roomId, 'X-Role': 'student', 'X-User-Id': player!.id },
    });
    expect((await afterEviction.json()) as ServerPlayerState).toMatchObject({
      roomStatus: 'live',
      game: { seq: 2 },
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
      game: { seq: 2 },
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
