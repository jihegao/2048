import { env, exports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { emptyBracket } from '../../shared/brackets';
import { hashPassword, randomToken } from '../../worker/lib/crypto';

const origin = 'https://example.com';
const students = [
  { studentNumber: '000120260001', name: '李同学😀' },
  { studentNumber: '000120260002', name: '张小明' },
  { studentNumber: '12', name: '王' },
  { studentNumber: 'PRIVACY4', name: '赵同学' },
  { studentNumber: 'PRIVACY5', name: '钱同学' },
  { studentNumber: 'PRIVACY6', name: '孙同学' },
];

interface RoomEntry {
  side: string;
  student_id: string | null;
  student_no: string | null;
  display_name: string | null;
  team_id: string | null;
  team_name: string | null;
  team_code: string | null;
}

interface RoomDetail {
  id: string;
  participantCount: number;
  isCreatorTeamMember: boolean;
  entries: RoomEntry[];
  tournament: {
    event_id: string;
    participant_a: string | null;
    participant_b: string | null;
    student_a: string | null;
    student_b: string | null;
    title: string;
  } | null;
}

async function request(path: string, cookie = '', method = 'GET', body?: unknown) {
  return exports.default.fetch(`${origin}${path}`, {
    method,
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function login(loginId: string, password: string) {
  const response = await request('/api/auth/login', '', 'POST', { loginId, password });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { user: { id: string } };
  return {
    cookie: response.headers.get('set-cookie')!.split(';', 1)[0],
    userId: body.user.id,
  };
}

async function detail(roomId: string, cookie: string, teacher = false) {
  const response = await request(`/api/${teacher ? 'teacher/' : ''}rooms/${roomId}`, cookie);
  expect(response.status).toBe(200);
  return ((await response.json()) as { room: RoomDetail }).room;
}

let teacher: string;
let teacherId: string;
const studentCookies: string[] = [];
let duelRoomId: string;
let shortNumberRoomId: string;
let tournamentRoomId: string;
let futureTournamentRoomId: string;

async function createDuel(name: string) {
  const response = await request('/api/teacher/rooms', teacher, 'POST', {
    name,
    mode: 'duel',
    durationMinutes: 1,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { room: { id: string } }).room.id;
}

async function seedDuelEntries(roomId: string, participantIndices: number[]) {
  await env.DB.batch(
    participantIndices.map((index, side) =>
      env.DB.prepare(
        `INSERT INTO room_entries (room_id, side, student_id, joined_by, joined_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(roomId, side === 0 ? 'A' : 'B', `privacy-s${index}`, `privacy-s${index}`, Date.now()),
    ),
  );
}

describe.sequential('room identity privacy', () => {
  beforeAll(async () => {
    const session = await login('teacher', 'integration-teacher-password');
    teacher = session.cookie;
    teacherId = session.userId;
    const now = Date.now();
    const salt = randomToken(16);
    const hash = await hashPassword(
      'room-privacy-student-password',
      salt,
      100000,
      'integration-password-pepper',
    );
    await env.DB.batch([
      ...students.map((student, index) =>
        env.DB.prepare(
          `INSERT INTO users (id, login_id, role, student_no, display_name, class_name,
             grade_level, password_hash, password_salt, password_iterations, created_at, updated_at)
           VALUES (?, ?, 'student', ?, ?, '隐私测试班', 6, ?, ?, 100000, ?, ?)`,
        ).bind(
          `privacy-s${index}`,
          student.studentNumber,
          student.studentNumber,
          student.name,
          hash,
          salt,
          now,
          now,
        ),
      ),
      ...['A', 'B'].map((side) =>
        env.DB.prepare(
          'INSERT INTO teams (id, code, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).bind(`privacy-t${side}`, `PRIV${side}`, `隐私测试${side}队`, now, now),
      ),
      ...students.map((_, index) =>
        env.DB.prepare(
          'INSERT INTO team_members (team_id, user_id, joined_at) VALUES (?, ?, ?)',
        ).bind(`privacy-t${index < 3 ? 'A' : 'B'}`, `privacy-s${index}`, now),
      ),
    ]);
    for (const student of students) {
      const session = await login(student.studentNumber, 'room-privacy-student-password');
      studentCookies.push(session.cookie);
    }

    // Seed read-only rosters without occupying students used by the creation case.
    duelRoomId = await createDuel('普通身份测试');
    shortNumberRoomId = await createDuel('短学号身份测试');
    await seedDuelEntries(duelRoomId, [0, 1]);
    await seedDuelEntries(shortNumberRoomId, [0, 2]);

    tournamentRoomId = await createDuel('赛事身份测试');
    futureTournamentRoomId = await createDuel('赛事未定席位测试');
    const state = emptyBracket('players16');
    state.title = '隐私测试赛事';
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tournament_events (id, kind, state_json, revision, mutation_id,
           created_by, updated_by, created_at, updated_at)
         VALUES ('privacy-event', 'players16', ?, 1, 'privacy-fixture', ?, ?, ?, ?)`,
      ).bind(JSON.stringify(state), teacherId, teacherId, now, now),
      env.DB.prepare(
        `INSERT INTO tournament_rooms (event_id, round_index, match_index, room_id,
           participant_a, participant_b)
         VALUES ('privacy-event', 0, 0, ?, 'privacy-s0', 'privacy-s1')`,
      ).bind(tournamentRoomId),
      env.DB.prepare(
        `INSERT INTO tournament_rooms (event_id, round_index, match_index, room_id,
           participant_a, participant_b)
         VALUES ('privacy-event', 1, 0, ?, 'privacy-s0', NULL)`,
      ).bind(futureTournamentRoomId),
    ]);
  });

  it('shows each participant their full identity and masks the opposite student', async () => {
    const first = await detail(duelRoomId, studentCookies[0]);
    expect(first.entries).toMatchObject([
      { side: 'A', student_no: '000120260001', display_name: '李同学😀' },
      { side: 'B', student_no: '260002', display_name: '张小*' },
    ]);
    expect(JSON.stringify(first)).not.toContain('000120260002');
    expect(JSON.stringify(first)).not.toContain('张小明');

    const second = await detail(duelRoomId, studentCookies[1]);
    expect(second.entries).toMatchObject([
      { side: 'A', student_no: '260001', display_name: '李同学*' },
      { side: 'B', student_no: '000120260002', display_name: '张小明' },
    ]);
    expect(JSON.stringify(second)).not.toContain('000120260001');
    expect(JSON.stringify(second)).not.toContain('李同学😀');
  });

  it('masks both students for another viewer and keeps teacher details behind teacher access', async () => {
    const viewer = await detail(duelRoomId, studentCookies[2]);
    expect(viewer.entries).toMatchObject([
      { student_no: '260001', display_name: '李同学*' },
      { student_no: '260002', display_name: '张小*' },
    ]);
    for (const student of students.slice(0, 2)) {
      expect(JSON.stringify(viewer)).not.toContain(student.studentNumber);
      expect(JSON.stringify(viewer)).not.toContain(student.name);
    }
    const teacherView = await detail(duelRoomId, teacher, true);
    expect(teacherView.entries).toMatchObject([
      { student_no: '000120260001', display_name: '李同学😀' },
      { student_no: '000120260002', display_name: '张小明' },
    ]);
    expect((await request(`/api/rooms/${duelRoomId}`)).status).toBe(401);
    expect((await request(`/api/teacher/rooms/${duelRoomId}`, studentCookies[0])).status).toBe(403);
  });

  it('uses the established short-number padding and masks a single-character peer name', async () => {
    const peerView = await detail(shortNumberRoomId, studentCookies[0]);
    expect(peerView.entries[1]).toMatchObject({ student_no: '****12', display_name: '*' });
    const selfView = await detail(shortNumberRoomId, studentCookies[2]);
    expect(selfView.entries[1]).toMatchObject({ student_no: '12', display_name: '王' });
    const teacherView = await detail(shortNumberRoomId, teacher, true);
    expect(teacherView.entries[1]).toMatchObject({ student_no: '12', display_name: '王' });
  });

  it('preserves team names and null student identities on creation and subsequent views', async () => {
    const period = await request('/api/teacher/team-practice-periods', teacher, 'POST', {
      name: '隐私团队练习期',
    });
    expect(period.status).toBe(201);
    const response = await request('/api/rooms', studentCookies[0], 'POST', {
      name: '隐私团队房间',
      durationMinutes: 1,
    });
    expect(response.status).toBe(201);
    const created = ((await response.json()) as { room: RoomDetail }).room;
    expect(created.isCreatorTeamMember).toBe(true);
    expect(created.entries).toMatchObject([
      {
        side: 'A',
        student_id: null,
        student_no: null,
        display_name: null,
        team_id: 'privacy-tA',
        team_name: '隐私测试A队',
        team_code: 'PRIVA',
      },
    ]);
    expect((await request(`/api/rooms/${created.id}/join`, studentCookies[3], 'POST')).status).toBe(
      200,
    );
    for (const [cookie, isTeacher] of [
      [studentCookies[0], false],
      [studentCookies[3], false],
      [teacher, true],
    ] as const) {
      const room = await detail(created.id, cookie, isTeacher);
      expect(room.participantCount).toBe(6);
      expect(room.entries).toMatchObject([
        { team_name: '隐私测试A队', student_no: null, display_name: null },
        { team_name: '隐私测试B队', student_no: null, display_name: null },
      ]);
    }
  });

  it('masks assigned tournament opponents before they join and preserves unresolved slots', async () => {
    const first = await detail(tournamentRoomId, studentCookies[0]);
    expect(first.entries).toEqual([]);
    expect(first.tournament).toMatchObject({
      event_id: 'privacy-event',
      title: '隐私测试赛事',
      student_a: '李同学😀',
      student_b: '张小*',
    });
    expect(JSON.stringify(first)).not.toContain('张小明');
    const second = await detail(tournamentRoomId, studentCookies[1]);
    expect(second.tournament).toMatchObject({ student_a: '李同学*', student_b: '张小明' });
    expect(JSON.stringify(second)).not.toContain('李同学😀');
    const viewer = await detail(tournamentRoomId, studentCookies[2]);
    expect(viewer.tournament).toMatchObject({ student_a: '李同学*', student_b: '张小*' });
    const teacherView = await detail(tournamentRoomId, teacher, true);
    expect(teacherView.tournament).toMatchObject({ student_a: '李同学😀', student_b: '张小明' });
    const unresolved = await detail(futureTournamentRoomId, studentCookies[1]);
    expect(unresolved.tournament).toMatchObject({
      student_a: '李同学*',
      participant_b: null,
      student_b: null,
    });
  });
});
