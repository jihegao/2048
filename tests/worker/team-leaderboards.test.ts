import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const origin = 'https://example.com';
const teacherPassword = 'integration-teacher-password';
const studentPassword = 'integration-student-password';

let teacherCookie = '';
let noTeamStudentCookie = '';
let zeroMemberStudentCookie = '';
let tailTeamStudentCookie = '';
let moverCookie = '';

let currentPeriodId = '';
let previousPeriodId = '';
let currentStart = 0;
let currentEnd = 0;

async function request(path: string, init: RequestInit = {}): Promise<Response> {
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

async function importUsers(rows: unknown[]): Promise<void> {
  const previewResponse = await request('/api/teacher/users/import/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({ rows }),
  });
  const preview = (await previewResponse.json()) as { token: string; errors: unknown[] };
  expect(preview.errors).toEqual([]);
  const commit = await request('/api/teacher/users/import/commit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({ rows, token: preview.token }),
  });
  expect(commit.status).toBe(200);
}

async function importTeams(rows: unknown[]): Promise<void> {
  const previewResponse = await request('/api/teacher/teams/import/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({ rows }),
  });
  const preview = (await previewResponse.json()) as { token: string; errors: unknown[] };
  expect(preview.errors).toEqual([]);
  const commit = await request('/api/teacher/teams/import/commit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({ rows, token: preview.token }),
  });
  expect(commit.status).toBe(200);
}

async function createPeriod(name: string, startAt: number, endAt: number): Promise<string> {
  const response = await request('/api/teacher/leaderboard-periods', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({
      name,
      startAt: new Date(startAt).toISOString(),
      endAt: new Date(endAt).toISOString(),
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { period: { id: string } }).period.id;
}

interface TeamEntry {
  rank: number;
  teamName: string;
  teamLogo: string | null;
  memberCount: number;
  totalScore: number;
  members: Array<{ name?: string; score: number }>;
}

async function teacherTeamBoard(periodId: string): Promise<{
  participantTeamCount: number;
  entries: TeamEntry[];
}> {
  const response = await request(`/api/teacher/leaderboards/teams?periodId=${periodId}`, {
    headers: { Cookie: teacherCookie },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    participantTeamCount: number;
    entries: TeamEntry[];
  };
}

describe.sequential('team practice leaderboard', () => {
  it('seeds students and teams and reports no active period first', async () => {
    teacherCookie = await login('teacher', teacherPassword);

    const baseStudents = Array.from({ length: 10 }, (_, index) => ({
      studentNumber: `T1${String(index + 1).padStart(2, '0')}`,
      name: `团队成员${index + 1}`,
      className: '榜单班',
      gradeLevel: 6,
    }));
    const extraStudents = Array.from({ length: 63 }, (_, index) => ({
      studentNumber: `E${String(index + 1).padStart(2, '0')}`,
      name: `尾巴成员${index + 1}`,
      className: '榜单班',
      gradeLevel: 6,
    }));
    await importUsers([...baseStudents, ...extraStudents]);

    const teamRows = [
      { name: '甲队', memberStudentNumbers: ['T101', 'T102', 'T103'] },
      { name: '乙队', memberStudentNumbers: ['T104', 'T105', 'T106'] },
      { name: '丙队', memberStudentNumbers: ['T107', 'T108', 'T109'] },
      ...Array.from({ length: 21 }, (_, index) => ({
        name: `尾队${String(index + 1).padStart(2, '0')}`,
        memberStudentNumbers: [
          `E${String(index * 3 + 1).padStart(2, '0')}`,
          `E${String(index * 3 + 2).padStart(2, '0')}`,
          `E${String(index * 3 + 3).padStart(2, '0')}`,
        ],
      })),
    ];
    await importTeams(teamRows);

    zeroMemberStudentCookie = await login('T103', studentPassword);
    noTeamStudentCookie = await login('T110', studentPassword);
    tailTeamStudentCookie = await login('E01', studentPassword);
    moverCookie = await login('T102', studentPassword);

    const unavailable = await request('/api/leaderboard/teams', {
      headers: { Cookie: zeroMemberStudentCookie },
    });
    expect(unavailable.status).toBe(200);
    expect(await unavailable.json()).toEqual({
      status: 'no_active_period',
      period: null,
      participantTeamCount: 0,
      currentUserTeamRank: null,
      entries: [],
    });
  });

  it('creates periods and practice results', async () => {
    const now = Date.now();
    currentStart = now - 60 * 60 * 1000;
    currentEnd = now + 60 * 60 * 1000;
    previousPeriodId = await createPeriod('上一期', currentStart - 60 * 60 * 1000, currentStart);
    currentPeriodId = await createPeriod('本期', currentStart, currentEnd);
    await createPeriod('下一期', currentEnd, currentEnd + 60 * 60 * 1000);

    const users = await env.DB.prepare(
      "SELECT id, student_no FROM users WHERE role = 'student' ORDER BY student_no",
    ).all<{ id: string; student_no: string }>();
    const userIds = new Map(users.results.map((user) => [user.student_no, user.id]));

    let resultIndex = 0;
    const statements: D1PreparedStatement[] = [];
    const addResult = (studentNumber: string, score: number, endedAt: number) => {
      resultIndex += 1;
      statements.push(
        env.DB.prepare(
          `INSERT INTO practice_results (
             id, challenge_id, user_id, engine_version, score, max_tile,
             valid_move_count, final_board_json, started_at, ended_at
           ) VALUES (?, ?, ?, 'test-engine', ?, ?, ?, ?, ?, ?)`,
        ).bind(
          `team-result-${resultIndex}`,
          `team-challenge-${resultIndex}`,
          userIds.get(studentNumber),
          score,
          512,
          100,
          '[]',
          endedAt - 1000,
          endedAt,
        ),
      );
    };

    addResult('T101', 1000, currentStart + 1000);
    addResult('T101', 400, currentStart + 2000);
    addResult('T102', 600, currentStart + 3000);
    addResult('T104', 1000, currentStart + 4000);
    addResult('T105', 600, currentStart + 5000);
    addResult('T107', 500, currentStart + 6000);
    addResult('T108', 400, currentStart + 7000);
    addResult('T109', 300, currentStart + 8000);
    addResult('T110', 99_999, currentStart + 9000);
    for (let index = 1; index <= 21; index += 1) {
      addResult(`E${String(index * 3 - 2).padStart(2, '0')}`, 100 + index, currentStart + 10_000);
    }
    addResult('T101', 7777, currentStart - 10_000);
    addResult('T101', 8888, currentEnd + 10_000);
    await env.DB.batch(statements);
  });

  it('aggregates member bests with ties, zero contributions, and current membership', async () => {
    const board = await teacherTeamBoard(currentPeriodId);
    expect(board.participantTeamCount).toBe(24);
    expect(board.entries).toHaveLength(24);

    const byName = new Map(board.entries.map((entry) => [entry.teamName, entry]));
    expect(byName.get('甲队')).toMatchObject({ rank: 1, totalScore: 1600, memberCount: 3 });
    expect(byName.get('乙队')).toMatchObject({ rank: 1, totalScore: 1600, memberCount: 3 });
    expect(byName.get('丙队')).toMatchObject({ rank: 3, totalScore: 1200 });
    expect(
      byName
        .get('甲队')!
        .members.map((member) => member.score)
        .sort((a, b) => b - a),
    ).toEqual([1000, 600, 0]);
    expect(byName.get('尾队21')).toMatchObject({ rank: 4, totalScore: 121 });
    expect(byName.get('尾队01')).toMatchObject({ rank: 24, totalScore: 101 });

    expect(board.entries.every((entry) => entry.totalScore <= 1600)).toBe(true);
    expect(
      board.entries.some((entry) => entry.members.some((member) => member.score === 7777)),
    ).toBe(false);
    expect(
      board.entries.some((entry) => entry.members.some((member) => member.score === 8888)),
    ).toBe(false);

    const previous = await teacherTeamBoard(previousPeriodId);
    expect(previous.participantTeamCount).toBe(24);
    expect(previous.entries.find((entry) => entry.teamName === '甲队')).toMatchObject({
      totalScore: 7777,
    });
    expect(
      previous.entries
        .filter((entry) => entry.teamName !== '甲队')
        .every((entry) => entry.totalScore === 0),
    ).toBe(true);
  });

  it('masks identities for students and includes the tail team beyond top 20', async () => {
    const response = await request('/api/leaderboard/teams', {
      headers: { Cookie: tailTeamStudentCookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      status: string;
      participantTeamCount: number;
      currentUserTeamRank: number;
      entries: Array<{
        rank: number;
        teamName: string;
        teamLogo: string | null;
        totalScore: number;
        isCurrentUserTeam: boolean;
        members: Array<Record<string, unknown>>;
      }>;
    };
    expect(body.status).toBe('available');
    expect(body.participantTeamCount).toBe(24);
    expect(body.entries).toHaveLength(21);
    expect(body.currentUserTeamRank).toBe(24);
    const own = body.entries.find((entry) => entry.isCurrentUserTeam);
    expect(own).toMatchObject({ teamName: '尾队01', rank: 24, totalScore: 101 });
    expect(body.entries[0]).toMatchObject({ rank: 1 });

    const memberKeys = ['className', 'isCurrentUser', 'maskedName', 'score', 'studentNumberSuffix'];
    for (const entry of body.entries) {
      for (const member of entry.members as Array<{
        maskedName: string;
        studentNumberSuffix: string;
      }>) {
        expect(Object.keys(member).sort()).toEqual(memberKeys);
        expect(member.maskedName.endsWith('*')).toBe(true);
        expect(member.studentNumberSuffix).toHaveLength(6);
      }
    }
    const serialized = JSON.stringify(body);
    for (const forbidden of ['studentId', 'userId', 'displayName']) {
      expect(serialized).not.toContain(forbidden);
    }

    const zeroMember = await request('/api/leaderboard/teams', {
      headers: { Cookie: zeroMemberStudentCookie },
    });
    const zeroBody = (await zeroMember.json()) as {
      currentUserTeamRank: number;
      entries: Array<{ teamName: string; isCurrentUserTeam: boolean }>;
    };
    expect(zeroBody.currentUserTeamRank).toBe(1);
    expect(zeroBody.entries.find((entry) => entry.isCurrentUserTeam)?.teamName).toBe('甲队');
  });

  it('reflects membership changes and student-created teams immediately', async () => {
    const created = await request('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: noTeamStudentCookie },
      body: JSON.stringify({ name: '自建榜单队', logo: 'shark' }),
    });
    expect(created.status).toBe(201);

    const board = await teacherTeamBoard(currentPeriodId);
    const created_ = board.entries.find((entry) => entry.teamName === '自建榜单队');
    expect(created_).toMatchObject({
      rank: 1,
      totalScore: 99_999,
      memberCount: 1,
      teamLogo: 'shark',
    });

    const studentView = await request('/api/leaderboard/teams', {
      headers: { Cookie: noTeamStudentCookie },
    });
    const studentBody = (await studentView.json()) as {
      currentUserTeamRank: number;
      entries: Array<{ teamName: string; isCurrentUserTeam: boolean }>;
    };
    expect(studentBody.currentUserTeamRank).toBe(1);
    expect(studentBody.entries.find((entry) => entry.isCurrentUserTeam)?.teamName).toBe(
      '自建榜单队',
    );

    const leave = await request('/api/me/team', {
      method: 'DELETE',
      headers: { Cookie: moverCookie },
    });
    expect(leave.status).toBe(200);

    const afterLeave = await teacherTeamBoard(currentPeriodId);
    expect(afterLeave.entries.find((entry) => entry.teamName === '甲队')).toMatchObject({
      totalScore: 1000,
      memberCount: 2,
    });

    const myTeam = await request('/api/me/team', {
      headers: { Cookie: noTeamStudentCookie },
    });
    const teamBody = (await myTeam.json()) as { team: { id: string } | null };
    const deleted = await request(`/api/teams/${teamBody.team!.id}`, {
      method: 'DELETE',
      headers: { Cookie: noTeamStudentCookie },
    });
    expect(deleted.status).toBe(200);
    const afterDelete = await teacherTeamBoard(currentPeriodId);
    expect(afterDelete.entries.find((entry) => entry.teamName === '自建榜单队')).toBeUndefined();
  });
});
