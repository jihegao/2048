import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { RoomSession } from '../../worker/durable/room-session';
import { expireDueStudentRooms } from '../../worker/routes/rooms';

const origin = 'https://example.com';
async function request(path: string, cookie = '', method = 'GET', body?: unknown) {
  return exports.default.fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function login(id: string, password = 'integration-student-password') {
  const response = await request('/api/auth/login', '', 'POST', {
    loginId: id,
    password,
    locale: 'zh-CN',
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';', 1)[0];
}

async function importRows(teacher: string, path: string, rows: unknown[]) {
  const preview = await request(`/api/teacher/${path}/import/validate`, teacher, 'POST', { rows });
  expect(preview.status).toBe(200);
  const data = (await preview.json()) as { token: string; errors: unknown[] };
  expect(data.errors).toEqual([]);
  const commit = await request(`/api/teacher/${path}/import/commit`, teacher, 'POST', {
    rows,
    token: data.token,
  });
  expect(commit.status).toBe(200);
}

describe('team practice rooms and periods', () => {
  it('keeps team membership immutable when an existing or incoming member is active', async () => {
    const teacher = await login('teacher', 'integration-teacher-password');
    await importRows(
      teacher,
      'users',
      ['A1', 'A2', 'A3', 'X1'].map((suffix) => ({
        studentNumber: `TG${suffix}`,
        name: suffix,
        className: '约束班',
        gradeLevel: 1,
      })),
    );
    await importRows(teacher, 'teams', [
      {
        name: '约束队',
        memberStudentNumbers: ['TGA1', 'TGA2', 'TGA3'],
      },
    ]);
    const duel = await request('/api/teacher/rooms', teacher, 'POST', {
      name: '占用测试',
      mode: 'duel',
      durationMinutes: 1,
    });
    const roomId = ((await duel.json()) as { room: { id: string } }).room.id;
    const a1 = await login('TGA1');
    const x1 = await login('TGX1');
    expect((await request(`/api/rooms/${roomId}/join`, a1, 'POST')).status).toBe(200);
    expect((await request(`/api/rooms/${roomId}/join`, x1, 'POST')).status).toBe(200);
    await expect(
      env.DB.prepare(
        `DELETE FROM team_members WHERE user_id =
       (SELECT id FROM users WHERE student_no = 'TGA2')`,
      ).run(),
    ).rejects.toThrow('team is active in a room');
    await env.DB.prepare(
      `INSERT INTO teams (id, code, name, created_at, updated_at)
       VALUES ('tg-empty', 'TGEMPTY', '空约束队', ?, ?)`,
    )
      .bind(Date.now(), Date.now())
      .run();
    await expect(
      env.DB.prepare(
        `INSERT INTO team_members (team_id, user_id, joined_at)
       SELECT 'tg-empty', id, ? FROM users WHERE student_no = 'TGX1'`,
      )
        .bind(Date.now())
        .run(),
    ).rejects.toThrow('team is active in a room');
  });

  it('requires an open period, scopes visibility, serializes creation, and freezes settled points', async () => {
    const teacher = await login('teacher', 'integration-teacher-password');
    const students = ['A', 'B', 'C'].flatMap((prefix, index) =>
      [1, 2, 3].map((number) => ({
        studentNumber: `TP${prefix}${number}`,
        name: `${prefix}${number}`,
        className: '赛班',
        gradeLevel: index + 1,
      })),
    );
    await importRows(teacher, 'users', students);
    await importRows(
      teacher,
      'teams',
      ['A', 'B', 'C'].map((prefix) => ({
        name: `赛队${prefix}`,
        memberStudentNumbers: [1, 2, 3].map((n) => `TP${prefix}${n}`),
      })),
    );
    const a1 = await login('TPA1');
    const a2 = await login('TPA2');
    const a3 = await login('TPA3');
    const b1 = await login('TPB1');
    const c1 = await login('TPC1');
    const roomInput = { name: '同组练习赛', durationMinutes: 1 };

    expect((await request('/api/rooms', a2, 'POST', roomInput)).status).toBe(409);
    const opened = await request('/api/teacher/team-practice-periods', teacher, 'POST', {
      name: '第一期',
    });
    expect(opened.status).toBe(201);
    const period = ((await opened.json()) as { period: { id: string } }).period;
    const created = await request('/api/rooms', a2, 'POST', roomInput);
    expect(created.status).toBe(201);
    const room = (
      (await created.json()) as {
        room: {
          id: string;
          studentCreated: boolean;
          teamPracticePeriodId: string;
          participantCount: number;
        };
      }
    ).room;
    expect(room).toMatchObject({
      studentCreated: true,
      teamPracticePeriodId: period.id,
      participantCount: 3,
    });
    await expect(
      env.DB.prepare(
        `DELETE FROM team_members WHERE user_id =
       (SELECT id FROM users WHERE student_no = 'TPA3')`,
      ).run(),
    ).rejects.toThrow('team is active in a room');
    const competing = await Promise.all([
      request('/api/rooms', a1, 'POST', roomInput),
      request('/api/rooms', a3, 'POST', roomInput),
    ]);
    expect(competing.map((response) => response.status)).toEqual([409, 409]);

    const bList = await request('/api/rooms', b1);
    const cList = await request('/api/rooms', c1);
    expect(
      ((await bList.json()) as { items: Array<{ id: string }> }).items.some(
        (item) => item.id === room.id,
      ),
    ).toBe(true);
    expect(
      ((await cList.json()) as { items: Array<{ id: string }> }).items.some(
        (item) => item.id === room.id,
      ),
    ).toBe(false);
    expect((await request(`/api/rooms/${room.id}`, c1)).status).toBe(404);
    expect((await request(`/api/rooms/${room.id}/join`, c1, 'POST')).status).toBe(404);
    expect((await request(`/api/rooms/${room.id}/join`, b1, 'POST')).status).toBe(200);
    expect((await request(`/api/rooms/${room.id}/start`, a1, 'POST')).status).toBe(403);
    expect((await request(`/api/rooms/${room.id}/start`, a2, 'POST')).status).toBe(200);
    expect((await request(`/api/rooms/${room.id}/start`, a2, 'POST')).status).toBe(409);

    const closing = await request(
      `/api/teacher/team-practice-periods/${period.id}/close`,
      teacher,
      'POST',
    );
    expect(((await closing.json()) as { period: { status: string } }).period.status).toBe(
      'closing',
    );
    expect((await request('/api/rooms', b1, 'POST', roomInput)).status).toBe(409);

    const stub = env.ROOMS.get(env.ROOMS.idFromName(room.id)) as DurableObjectStub<RoomSession>;
    await runInDurableObject(stub, async (instance: RoomSession, state) => {
      const target = instance as unknown as { runtime: { startsAt: number } };
      target.runtime.startsAt = Date.now() - 1;
      await state.storage.put('room-runtime', target.runtime);
      return new Response('ok');
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (instance: RoomSession, state) => {
      const target = instance as unknown as { runtime: { endsAt: number } };
      target.runtime.endsAt = Date.now() - 1;
      await state.storage.put('room-runtime', target.runtime);
      return new Response('ok');
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const result = await request(
      `/api/teacher/team-practice-periods/${period.id}/results`,
      teacher,
    );
    expect(result.status).toBe(200);
    const data = (await result.json()) as {
      period: { status: string };
      standings: Array<{ matches: number; points: number }>;
      matches: Array<{ points: number }>;
    };
    expect(data.period.status).toBe('frozen');
    expect(data.standings).toHaveLength(2);
    expect(data.standings.every((row) => row.matches === 1)).toBe(true);
    expect(data.matches).toHaveLength(2);
    expect(data.matches.reduce((sum, row) => sum + row.points, 0)).toBe(2);

    const secondOpened = await request('/api/teacher/team-practice-periods', teacher, 'POST', {
      name: '第二期',
    });
    expect(secondOpened.status).toBe(201);
    const secondPeriod = ((await secondOpened.json()) as { period: { id: string } }).period;
    const editedRoomResponse = await request('/api/teacher/rooms', teacher, 'POST', {
      name: '待改为团队赛',
      mode: 'duel',
      durationMinutes: 1,
    });
    const editedRoom = ((await editedRoomResponse.json()) as { room: { id: string } }).room;
    const edited = await request(`/api/teacher/rooms/${editedRoom.id}`, teacher, 'PATCH', {
      mode: 'team_3v3',
    });
    expect(edited.status).toBe(200);
    expect(
      ((await edited.json()) as { room: { teamPracticePeriodId: string } }).room
        .teamPracticePeriodId,
    ).toBe(secondPeriod.id);
    const teacherCreated = await request('/api/teacher/rooms', teacher, 'POST', {
      name: '教师团队练习赛',
      mode: 'team_3v3',
      durationMinutes: 1,
    });
    expect(teacherCreated.status).toBe(201);
    const teacherRoom = (
      (await teacherCreated.json()) as { room: { id: string; teamPracticePeriodId: string } }
    ).room;
    expect(teacherRoom.teamPracticePeriodId).toBe(secondPeriod.id);
    expect((await request(`/api/rooms/${teacherRoom.id}/join`, a1, 'POST')).status).toBe(200);
    expect((await request(`/api/rooms/${teacherRoom.id}/join`, b1, 'POST')).status).toBe(200);
    expect(
      (await request(`/api/teacher/rooms/${teacherRoom.id}/start`, teacher, 'POST')).status,
    ).toBe(200);
    const teacherStub = env.ROOMS.get(
      env.ROOMS.idFromName(teacherRoom.id),
    ) as DurableObjectStub<RoomSession>;
    await runInDurableObject(teacherStub, async (instance: RoomSession, state) => {
      const target = instance as unknown as { runtime: { status: string; endsAt: number } };
      target.runtime.status = 'live';
      target.runtime.endsAt = Date.now() - 1;
      await state.storage.put('room-runtime', target.runtime);
      return new Response('ok');
    });
    expect(await runDurableObjectAlarm(teacherStub)).toBe(true);
    const teacherScores = await request(
      `/api/teacher/team-practice-periods/${secondPeriod.id}/results`,
      teacher,
    );
    const teacherData = (await teacherScores.json()) as { matches: Array<{ points: number }> };
    expect(teacherData.matches).toHaveLength(2);

    const unstarted = await request('/api/rooms', a1, 'POST', {
      name: '关闭后取消',
      durationMinutes: 1,
    });
    expect(unstarted.status).toBe(201);
    const unstartedRoom = ((await unstarted.json()) as { room: { id: string } }).room;
    expect((await request(`/api/rooms/${unstartedRoom.id}/join`, b1, 'POST')).status).toBe(200);
    expect(
      (
        await request(
          `/api/teacher/team-practice-periods/${secondPeriod.id}/close`,
          teacher,
          'POST',
        )
      ).status,
    ).toBe(200);
    expect((await request(`/api/rooms/${unstartedRoom.id}/start`, a1, 'POST')).status).toBe(409);
    const cancelled = await env.DB.prepare('SELECT status FROM rooms WHERE id = ?')
      .bind(unstartedRoom.id)
      .first<{ status: string }>();
    expect(cancelled?.status).toBe('cancelled');
    expect(
      (
        await env.DB.prepare(
          'SELECT COUNT(*) AS count FROM active_participations WHERE room_id = ?',
        )
          .bind(unstartedRoom.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);

    const thirdOpened = await request('/api/teacher/team-practice-periods', teacher, 'POST', {
      name: '第三期',
    });
    expect(thirdOpened.status).toBe(201);
    const expiring = await request('/api/rooms', a1, 'POST', {
      name: '即将到期',
      durationMinutes: 1,
    });
    expect(expiring.status).toBe(201);
    const expiringRoom = ((await expiring.json()) as { room: { id: string } }).room;
    await env.DB.prepare('UPDATE rooms SET self_room_expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, expiringRoom.id)
      .run();
    const expiringStub = env.ROOMS.get(
      env.ROOMS.idFromName(expiringRoom.id),
    ) as DurableObjectStub<RoomSession>;
    expect(await runDurableObjectAlarm(expiringStub)).toBe(true);
    const expired = await env.DB.prepare('SELECT status FROM rooms WHERE id = ?')
      .bind(expiringRoom.id)
      .first<{ status: string }>();
    expect(expired?.status).toBe('cancelled');
    const missedAlarm = await request('/api/rooms', a1, 'POST', {
      name: '定时扫描兜底',
      durationMinutes: 1,
    });
    expect(missedAlarm.status).toBe(201);
    const missedRoom = ((await missedAlarm.json()) as { room: { id: string } }).room;
    await env.DB.prepare('UPDATE rooms SET self_room_expires_at = ? WHERE id = ?')
      .bind(Date.now() - 1, missedRoom.id)
      .run();
    await expireDueStudentRooms(env);
    const swept = await env.DB.prepare('SELECT status FROM rooms WHERE id = ?')
      .bind(missedRoom.id)
      .first<{ status: string }>();
    expect(swept?.status).toBe('cancelled');
  }, 20_000);
});
