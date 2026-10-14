import { env, exports } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyBracket } from '../../shared/brackets';
import { clearTournamentWinner } from '../../shared/tournaments';
import type { TournamentData } from '../../shared/tournaments';
import { hashPassword } from '../../worker/lib/crypto';

const origin = 'https://example.com';
async function request(path: string, cookie: string, method = 'GET', body?: unknown) {
  return exports.default.fetch(origin + path, {
    method,
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function login(loginId = 'teacher', password = 'integration-teacher-password') {
  const result = await request('/api/auth/login', '', 'POST', { loginId, password });
  expect(result.status).toBe(200);
  return result.headers.get('set-cookie')!.split(';', 1)[0];
}
let teacher: string;
const student = (i: number) => login(`TOUR${i}`, 'tournament-student-password');
async function create(kind: 'teams8' | 'players16' = 'players16', title = '赛事X') {
  const state = emptyBracket(kind);
  state.title = title;
  state.names = Array.from({ length: kind === 'teams8' ? 8 : 16 }, (_, i) =>
    kind === 'teams8' ? `队伍${i}` : `学生${i} · 一班 · TOUR${i}`,
  );
  const result = await request('/api/teacher/tournaments', teacher, 'POST', { kind, state });
  expect(result.status).toBe(201);
  return (await result.json()) as TournamentData;
}
async function rooms(event: TournamentData, durationMinutes = 5) {
  const result = await request(
    `/api/teacher/tournaments/${event.event.id}/rooms`,
    teacher,
    'POST',
    { revision: event.revision, durationMinutes },
  );
  expect(result.status).toBe(200);
  return (await result.json()) as TournamentData;
}
async function save(event: TournamentData) {
  return request(`/api/teacher/tournaments/${event.event.id}`, teacher, 'PUT', {
    revision: event.revision,
    state: event.state,
  });
}
async function advanceFirstRound(event: TournamentData) {
  event.state.winners[0] = event.state.winners[0].map((_, i) => `tour-s${i * 2}`);
  const result = await save(event);
  expect(result.status).toBe(200);
  return (await result.json()) as TournamentData;
}
async function join(id: string, i: number) {
  return request(`/api/rooms/${id}/join`, await student(i), 'POST');
}
describe('independent tournaments and all-round rooms', () => {
  beforeEach(async () => {
    const previousRooms = await env.DB.prepare('SELECT id FROM rooms').all<{ id: string }>();
    for (const room of previousRooms.results)
      await runInDurableObject(
        env.ROOMS.get(env.ROOMS.idFromName(room.id)),
        async (_instance, state) => {
          await state.storage.deleteAll();
        },
      );
    await env.DB.batch(
      [
        'active_participations',
        'match_players',
        'room_entries',
        'tournament_room_history',
        'tournament_rooms',
        'rooms',
        'tournament_audit',
        'tournament_events',
        'team_members',
        'teams',
      ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
    );
    await env.DB.prepare("DELETE FROM users WHERE id LIKE 'tour-s%'").run();
    await env.DB.prepare('DELETE FROM tournament_brackets').run();
    teacher = await login();
    const now = Date.now(),
      salt = 'tournament-student-salt';
    const hash = await hashPassword(
      'tournament-student-password',
      salt,
      100000,
      'integration-password-pepper',
    );
    await env.DB.batch([
      ...Array.from({ length: 24 }, (_, i) =>
        env.DB.prepare(
          `INSERT INTO users (id, login_id, role, student_no, display_name, class_name, password_hash, password_salt, password_iterations, created_at, updated_at) VALUES (?, ?, 'student', ?, ?, '一班', ?, ?, 100000, ?, ?)`,
        ).bind(`tour-s${i}`, `TOUR${i}`, `TOUR${i}`, `学生${i}`, hash, salt, now, now),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        env.DB.prepare(
          'INSERT INTO teams (id, code, name, logo, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).bind(`tour-t${i}`, `TT${i}`, `队伍${i}`, `icon${i + 1}`, now, now),
      ),
      ...Array.from({ length: 24 }, (_, i) =>
        env.DB.prepare(
          'INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)',
        ).bind(`tour-t${Math.floor(i / 3)}`, `tour-s${i}`, now),
      ),
    ]);
  });
  it('rejects anonymous/student administration and cross-origin requests', async () => {
    expect((await request('/api/teacher/tournaments?kind=players16', '')).status).toBe(401);
    const cookie = await student(0);
    expect((await request('/api/teacher/tournaments?kind=players16', cookie)).status).toBe(403);
    expect(
      (await request('/api/teacher/tournaments', cookie, 'POST', { kind: 'players16' })).status,
    ).toBe(403);
    const result = await exports.default.fetch(origin + '/api/teacher/tournaments', {
      method: 'POST',
      headers: {
        Cookie: teacher,
        Origin: 'https://foreign.example',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'players16' }),
    });
    expect(result.status).toBe(403);
  });
  it('preserves legacy saves during rollout and rejects old-client writes once the imported event is managed', async () => {
    const state = emptyBracket('players16');
    state.title = '原线上对阵';
    expect(
      (await request('/api/teacher/brackets/players16', teacher, 'PUT', { revision: 0, state }))
        .status,
    ).toBe(200);
    state.title = '旧客户端更新';
    expect(
      (await request('/api/teacher/brackets/players16', teacher, 'PUT', { revision: 1, state }))
        .status,
    ).toBe(200);
    const event = (await (
      await request('/api/teacher/tournaments/legacy-players16', teacher)
    ).json()) as TournamentData;
    expect(event.state.title).toBe('旧客户端更新');
    event.state.title = '新赛事管理更新';
    expect((await save(event)).status).toBe(200);
    expect(
      (await request('/api/teacher/brackets/players16', teacher, 'PUT', { revision: 2, state }))
        .status,
    ).toBe(409);
    expect(
      await (await request('/api/teacher/tournaments/legacy-players16', teacher)).json(),
    ).toMatchObject({ state: { title: '新赛事管理更新' } });
  });
  it('clears stale dependent winners server-side even if a caller retains them', async () => {
    let event = await advanceFirstRound(await rooms(await create()));
    event.state.winners[1][0] = 'tour-s0';
    event = (await (await save(event)).json()) as TournamentData;
    event.state.winners[0][1] = 'tour-s3';
    event = (await (await save(event)).json()) as TournamentData;
    expect(event.state.winners[1][0]).toBeNull();
    expect(
      event.rooms.find((room) => room.round === 2 && room.match === 0)?.participants[0],
    ).toBeNull();
  });
  it('keeps multiple events independent and copies a roster without rooms or winners', async () => {
    let first = await create();
    const second = await create('players16', '赛事Y');
    first = await advanceFirstRound(first);
    const copy = await request('/api/teacher/tournaments', teacher, 'POST', {
      kind: 'players16',
      copyId: first.event.id,
    });
    const data = (await copy.json()) as TournamentData;
    expect(data.state.title).toBe('赛事X（副本）');
    expect(data.state.names).toEqual(first.state.names);
    expect(data.state.winners.flat().every((value) => value === null)).toBe(true);
    expect(data.rooms).toEqual([]);
    expect(
      await (await request(`/api/teacher/tournaments/${second.event.id}`, teacher)).json(),
    ).toMatchObject({ state: second.state });
    const list = (await (
      await request('/api/teacher/tournaments?kind=players16', teacher)
    ).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(3);
  });
  for (const kind of ['teams8', 'players16'] as const)
    it(`creates and names all ${kind} rooms without occupying future slots`, async () => {
      const event = await rooms(await create(kind), 3);
      expect(event.rooms).toHaveLength(kind === 'teams8' ? 7 : 15);
      expect(event.rooms[0]).toMatchObject({
        name: '赛事X-第一轮A组',
        durationMinutes: 3,
        status: 'open',
        entryCount: 0,
        participants: kind === 'teams8' ? ['tour-t0', 'tour-t1'] : ['tour-s0', 'tour-s1'],
      });
      expect(event.rooms.at(-1)).toMatchObject({ name: '赛事X-决赛', participants: [null, null] });
      expect(
        await env.DB.prepare('SELECT COUNT(*) AS count FROM active_participations').first(),
      ).toMatchObject({ count: 0 });
      const room = await request(`/api/teacher/rooms/${event.rooms[0].roomId}`, teacher);
      expect(await room.json()).toMatchObject({
        room: { tournament: { event_id: event.event.id, title: '赛事X' } },
      });
      expect(
        (
          await request(`/api/teacher/rooms/${event.rooms[0].roomId}`, teacher, 'PATCH', {
            mode: 'duel',
          })
        ).status,
      ).toBe(409);
    });
  it('handles concurrent and repeated bulk requests without duplicates or orphan rooms', async () => {
    const event = await create();
    const path = `/api/teacher/tournaments/${event.event.id}/rooms`,
      body = { revision: event.revision, durationMinutes: 5 };
    const result = await Promise.all([
      request(path, teacher, 'POST', body),
      request(path, teacher, 'POST', body),
    ]);
    expect(result.map((value) => value.status)).toEqual([200, 200]);
    expect((await request(path, teacher, 'POST', body)).status).toBe(200);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM rooms').first()).toMatchObject({
      count: 15,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM tournament_audit WHERE action = 'rooms_created'",
      ).first(),
    ).toMatchObject({ count: 1 });
  });
  it('requires a complete unique roster and complete teams before creating rooms', async () => {
    const result = await request('/api/teacher/tournaments', teacher, 'POST', {
      kind: 'players16',
    });
    const event = (await result.json()) as TournamentData;
    expect(
      (
        await request(`/api/teacher/tournaments/${event.event.id}/rooms`, teacher, 'POST', {
          revision: 1,
          durationMinutes: 5,
        })
      ).status,
    ).toBe(422);
    const teams = await create('teams8');
    expect(teams.catalog.find((entry) => entry.id === 'tour-t0')?.memberCount).toBe(3);
    await env.DB.prepare("DELETE FROM team_members WHERE user_id = 'tour-s0'").run();
    const refreshed = (await (
      await request(`/api/teacher/tournaments/${teams.event.id}`, teacher)
    ).json()) as TournamentData;
    expect(refreshed.catalog.find((entry) => entry.id === 'tour-t0')?.memberCount).toBe(2);
    expect(
      (
        await request(`/api/teacher/tournaments/${teams.event.id}/rooms`, teacher, 'POST', {
          revision: 1,
          durationMinutes: 5,
        })
      ).status,
    ).toBe(422);
    expect(await env.DB.prepare('SELECT COUNT(*) AS count FROM rooms').first()).toMatchObject({
      count: 0,
    });
  });
  it('restricts admission to assigned participants and assigns the intended side even when B joins first', async () => {
    const event = await rooms(await create());
    const first = event.rooms[0],
      future = event.rooms.find((room) => room.round === 1)!;
    const listed = (await (await request('/api/rooms', await student(0))).json()) as {
      items: Array<{ id: string }>;
    };
    expect(listed.items.map((room) => room.id)).toEqual([first.roomId]);
    expect((await join(future.roomId, 0)).status).toBe(409);
    expect((await join(first.roomId, 3)).status).toBe(403);
    expect(await (await join(first.roomId, 1)).json()).toMatchObject({ side: 'B' });
    expect(await (await join(first.roomId, 0)).json()).toMatchObject({ side: 'A' });
    expect(
      (await request(`/api/teacher/rooms/${first.roomId}/start`, teacher, 'POST')).status,
    ).toBe(200);
  });
  it('serializes a concurrent start and advancement save without starting a stale roster', async () => {
    const event = await advanceFirstRound(await rooms(await create()));
    const next = event.rooms.find((room) => room.round === 1)!;
    expect((await join(next.roomId, 0)).status).toBe(200);
    expect((await join(next.roomId, 2)).status).toBe(200);
    event.state.winners[0][0] = 'tour-s1';
    const results = await Promise.all([
      request(`/api/teacher/rooms/${next.roomId}/start`, teacher, 'POST'),
      save(event),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    const current = await env.DB.prepare(
      'SELECT r.status, tr.participant_a FROM rooms r JOIN tournament_rooms tr ON tr.room_id = r.id WHERE r.id = ?',
    )
      .bind(next.roomId)
      .first<{ status: string; participant_a: string }>();
    if (results[0].status === 200)
      expect(current).toEqual({ status: 'countdown', participant_a: 'tour-s0' });
    else expect(current).toEqual({ status: 'open', participant_a: 'tour-s1' });
  });
  it('restricts team admission and applies both sides from the bracket', async () => {
    const event = await rooms(await create('teams8'));
    const listed = (await (await request('/api/rooms', await student(0))).json()) as {
      items: Array<{ id: string }>;
    };
    expect(listed.items.map((room) => room.id)).toEqual([event.rooms[0].roomId]);
    expect((await join(event.rooms[0].roomId, 6)).status).toBe(403);
    expect(await (await join(event.rooms[0].roomId, 4)).json()).toMatchObject({ side: 'B' });
    expect(await (await join(event.rooms[0].roomId, 0)).json()).toMatchObject({ side: 'A' });
    expect(
      (await request(`/api/teacher/rooms/${event.rooms[0].roomId}/start`, teacher, 'POST')).status,
    ).toBe(200);
  });
  it('updates later assignments and releases only obsolete waiting sides, retaining room codes', async () => {
    let event = await advanceFirstRound(await rooms(await create()));
    const next = event.rooms.find((room) => room.round === 1 && room.match === 0)!;
    expect(next.participants).toEqual(['tour-s0', 'tour-s2']);
    expect((await join(next.roomId, 0)).status).toBe(200);
    expect((await join(next.roomId, 2)).status).toBe(200);
    event.state.winners[0][0] = 'tour-s1';
    const preview = await request(
      `/api/teacher/tournaments/${event.event.id}/preview`,
      teacher,
      'POST',
      { revision: event.revision, state: event.state },
    );
    expect(await preview.json()).toMatchObject({
      impacts: expect.arrayContaining([
        expect.objectContaining({ round: 1, after: ['tour-s1', 'tour-s2'], blocked: false }),
      ]),
    });
    const saved = await save(event);
    expect(saved.status).toBe(200);
    event = (await saved.json()) as TournamentData;
    expect(event.rooms.find((room) => room.roomId === next.roomId)).toMatchObject({
      code: next.code,
      status: 'open',
      entryCount: 1,
      participants: ['tour-s1', 'tour-s2'],
    });
    expect(
      await env.DB.prepare('SELECT user_id FROM active_participations WHERE room_id = ?')
        .bind(next.roomId)
        .all(),
    ).toMatchObject({ results: [{ user_id: 'tour-s2' }] });
    expect((await join(next.roomId, 0)).status).toBe(403);
    expect((await join(next.roomId, 1)).status).toBe(200);
  });
  for (const status of ['countdown', 'live', 'ended'])
    it(`atomically blocks changing an affected ${status} room`, async () => {
      const event = await advanceFirstRound(await rooms(await create()));
      const next = event.rooms.find((room) => room.round === 1)!;
      if (status === 'countdown') {
        expect((await join(next.roomId, 0)).status).toBe(200);
        expect((await join(next.roomId, 2)).status).toBe(200);
      }
      await env.DB.prepare('UPDATE rooms SET status = ? WHERE id = ?')
        .bind(status, next.roomId)
        .run();
      const before = await env.DB.prepare(
        'SELECT state_json, revision FROM tournament_events WHERE id = ?',
      )
        .bind(event.event.id)
        .first();
      event.state.winners[0][0] = 'tour-s1';
      expect((await save(event)).status).toBe(409);
      expect(
        await env.DB.prepare('SELECT state_json, revision FROM tournament_events WHERE id = ?')
          .bind(event.event.id)
          .first(),
      ).toEqual(before);
      expect(
        await env.DB.prepare('SELECT participant_a FROM tournament_rooms WHERE room_id = ?')
          .bind(next.roomId)
          .first(),
      ).toMatchObject({ participant_a: 'tour-s0' });
    });
  it('keeps ended records and explicitly replaces a room for a rematch before changing earlier advancement', async () => {
    let event = await advanceFirstRound(await rooms(await create()));
    const next = event.rooms.find((room) => room.round === 1)!;
    await env.DB.prepare("UPDATE rooms SET status = 'ended', settled_at = 123 WHERE id = ?")
      .bind(next.roomId)
      .run();
    const result = await request(
      `/api/teacher/tournaments/${event.event.id}/rematch`,
      teacher,
      'POST',
      { revision: event.revision, round: 1, match: 0 },
    );
    expect(result.status).toBe(200);
    event = (await result.json()) as TournamentData;
    expect(event.history).toHaveLength(1);
    expect(event.history[0].roomId).toBe(next.roomId);
    expect(
      await env.DB.prepare('SELECT status, settled_at FROM rooms WHERE id = ?')
        .bind(next.roomId)
        .first(),
    ).toEqual({ status: 'ended', settled_at: 123 });
    const replacement = event.rooms.find((room) => room.round === 1)!;
    expect(replacement.roomId).not.toBe(next.roomId);
    expect(replacement.code).not.toBe(next.code);
    event.state.winners[0][0] = 'tour-s1';
    expect((await save(event)).status).toBe(200);
  });
  it('clears dependent results and associations when advancement is revoked', async () => {
    let event = await advanceFirstRound(await rooms(await create()));
    event.state.winners[1][0] = 'tour-s0';
    event = (await (await save(event)).json()) as TournamentData;
    event.state = clearTournamentWinner('players16', event.catalog, event.state, 0, 0);
    event = (await (await save(event)).json()) as TournamentData;
    expect(event.state.winners[1][0]).toBeNull();
    expect(event.rooms.find((room) => room.round === 1 && room.match === 0)?.participants).toEqual([
      null,
      'tour-s2',
    ]);
    expect(
      event.rooms.find((room) => room.round === 2 && room.match === 0)?.participants[0],
    ).toBeNull();
  });
  it('archives without deleting events or scores, cancels waiting rooms and supports restore', async () => {
    let event = await rooms(await create());
    expect((await join(event.rooms[0].roomId, 0)).status).toBe(200);
    const result = await request(`/api/teacher/tournaments/${event.event.id}`, teacher, 'PATCH', {
      revision: event.revision,
      archived: true,
    });
    expect(result.status).toBe(200);
    event = (await result.json()) as TournamentData;
    expect(event.event.status).toBe('archived');
    expect(event.rooms.every((room) => room.status === 'cancelled')).toBe(true);
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM active_participations').first(),
    ).toMatchObject({ count: 0 });
    expect((await save(event)).status).toBe(409);
    expect((await join(event.rooms[0].roomId, 0)).status).toBe(409);
    expect(
      await (
        await request('/api/teacher/tournaments?kind=players16&archived=true', teacher)
      ).json(),
    ).toMatchObject({ items: [expect.objectContaining({ id: event.event.id })] });
    const restored = await request(`/api/teacher/tournaments/${event.event.id}`, teacher, 'PATCH', {
      revision: event.revision,
      archived: false,
    });
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as TournamentData).event.archived).toBe(false);
  });
  it('prevents stale saves and blocks archive while a game is running', async () => {
    const event = await rooms(await create());
    const result = await Promise.all([save(event), save(event)]);
    expect(result.map((value) => value.status).sort()).toEqual([200, 409]);
    await env.DB.prepare("UPDATE rooms SET status = 'live' WHERE id = ?")
      .bind(event.rooms[0].roomId)
      .run();
    expect(
      (
        await request(`/api/teacher/tournaments/${event.event.id}`, teacher, 'PATCH', {
          revision: event.revision + 1,
          archived: true,
        })
      ).status,
    ).toBe(409);
    expect(
      await env.DB.prepare('SELECT archived_at FROM tournament_events WHERE id = ?')
        .bind(event.event.id)
        .first(),
    ).toMatchObject({ archived_at: null });
  });
});
