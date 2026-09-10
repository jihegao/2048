import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const origin = 'https://example.com';
const teacherPassword = 'integration-teacher-password';
const studentPassword = 'integration-student-password';

let teacherCookie = '';
let creatorCookie = '';
let memberCookie = '';
let racerCookie = '';
let importedMemberCookie = '';

let creatorTeamId = '';
let importedTeamId = '';
let creatorUserId = '';

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

async function importStudents(rows: unknown[]): Promise<void> {
  const previewResponse = await request('/api/teacher/users/import/validate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({ rows }),
  });
  expect(previewResponse.status).toBe(200);
  const preview = (await previewResponse.json()) as { token: string; errors: unknown[] };
  expect(preview.errors).toEqual([]);
  const commit = await request('/api/teacher/users/import/commit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', Cookie: teacherCookie },
    body: JSON.stringify({ rows, token: preview.token }),
  });
  expect(commit.status).toBe(200);
}

function createTeamBody(name: string, logo?: string) {
  return JSON.stringify({ name, ...(logo ? { logo } : {}) });
}

describe.sequential('student team self-service', () => {
  it('guards the create endpoint behind student auth', async () => {
    teacherCookie = await login('teacher', teacherPassword);
    const anonymous = await request('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: createTeamBody('未登录队', 'lion'),
    });
    expect(anonymous.status).toBe(401);
    const teacherAttempt = await request('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacherCookie },
      body: createTeamBody('教师队', 'lion'),
    });
    expect(teacherAttempt.status).toBe(403);
  });

  it('seeds students and a teacher-managed team', async () => {
    await importStudents(
      Array.from({ length: 6 }, (_, index) => ({
        studentNumber: `S10${index + 1}`,
        name: `自助学生${index + 1}`,
        className: '自助班',
        gradeLevel: 6,
      })),
    );
    creatorCookie = await login('S101', studentPassword);
    memberCookie = await login('S102', studentPassword);
    racerCookie = await login('S103', studentPassword);
    importedMemberCookie = await login('S104', studentPassword);

    const previewResponse = await request('/api/teacher/teams/import/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({
        rows: [{ name: '教师管理队', memberStudentNumbers: ['S104', 'S105', 'S106'] }],
      }),
    });
    const preview = (await previewResponse.json()) as { token: string; errors: unknown[] };
    expect(preview.errors).toEqual([]);
    const commit = await request('/api/teacher/teams/import/commit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({
        rows: [{ name: '教师管理队', memberStudentNumbers: ['S104', 'S105', 'S106'] }],
        token: preview.token,
      }),
    });
    expect(commit.status).toBe(200);

    const teacherTeams = await request(
      `/api/teacher/teams?query=${encodeURIComponent('教师管理队')}`,
      { headers: { Cookie: teacherCookie } },
    );
    const listed = (await teacherTeams.json()) as {
      total: number;
      items: Array<{ id: string; logo: string | null; creator_id: string | null }>;
    };
    expect(listed.total).toBe(1);
    importedTeamId = listed.items[0].id;
    expect(listed.items[0].creator_id).toBeNull();
    expect(listed.items[0].logo).toBeNull();
  });

  it('creates a team with a preset logo and reports ownership', async () => {
    const me = await request('/api/me', { headers: { Cookie: creatorCookie } });
    creatorUserId = ((await me.json()) as { user: { id: string } }).user.id;

    const created = await request('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: creatorCookie },
      body: createTeamBody('自建一队', 'tiger'),
    });
    expect(created.status).toBe(201);

    const myTeam = await request('/api/me/team', { headers: { Cookie: creatorCookie } });
    const teamBody = (await myTeam.json()) as {
      team: {
        id: string;
        name: string;
        logo: string;
        isOwner: boolean;
        members: Array<{ student_no: string }>;
      } | null;
    };
    expect(teamBody.team).toMatchObject({
      name: '自建一队',
      logo: 'tiger',
      isOwner: true,
      members: [{ student_no: 'S101' }],
    });
    creatorTeamId = teamBody.team!.id;
  });

  it('rejects invalid logos, duplicate names, and students already in teams', async () => {
    const badLogo = await request('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: memberCookie },
      body: createTeamBody('徽标无效队', 'custom-url'),
    });
    expect(badLogo.status).toBe(422);
    expect(await badLogo.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });

    const duplicateName = await request('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: memberCookie },
      body: createTeamBody('自建一队', 'wolf'),
    });
    expect(duplicateName.status).toBe(409);
    expect(await duplicateName.json()).toMatchObject({ error: { code: 'TEAM_NAME_TAKEN' } });

    const alreadyInTeam = await request('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: creatorCookie },
      body: createTeamBody('再建一队', 'wolf'),
    });
    expect(alreadyInTeam.status).toBe(409);
    expect(await alreadyInTeam.json()).toMatchObject({ error: { code: 'TEAM_CONFLICT' } });
  });

  it('allows only one of two concurrent creates to succeed', async () => {
    const attempts = ['并发甲队', '并发乙队'].map((name) =>
      request('/api/teams', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Cookie: racerCookie },
        body: createTeamBody(name, 'eagle'),
      }),
    );
    const responses = await Promise.all(attempts);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);

    const myTeam = await request('/api/me/team', { headers: { Cookie: racerCookie } });
    const teamBody = (await myTeam.json()) as { team: { name: string } | null };
    expect(['并发甲队', '并发乙队']).toContain(teamBody.team?.name);

    const teacherTeams = await request(`/api/teacher/teams?query=${encodeURIComponent('并发')}`, {
      headers: { Cookie: teacherCookie },
    });
    expect(await teacherTeams.json()).toMatchObject({ total: 1 });
  });

  it('blocks delete for non-creators and teacher-managed teams', async () => {
    const join = await request(`/api/teams/${creatorTeamId}/join`, {
      method: 'POST',
      headers: { Cookie: memberCookie },
    });
    expect(join.status).toBe(200);

    const memberDelete = await request(`/api/teams/${creatorTeamId}`, {
      method: 'DELETE',
      headers: { Cookie: memberCookie },
    });
    expect(memberDelete.status).toBe(403);
    expect(await memberDelete.json()).toMatchObject({ error: { code: 'TEAM_DELETE_FORBIDDEN' } });

    const importedDelete = await request(`/api/teams/${importedTeamId}`, {
      method: 'DELETE',
      headers: { Cookie: importedMemberCookie },
    });
    expect(importedDelete.status).toBe(403);
    expect(await importedDelete.json()).toMatchObject({ error: { code: 'TEAM_DELETE_FORBIDDEN' } });
  });

  it('blocks create and delete while members are in rooms', async () => {
    const room = await request('/api/teacher/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({ name: '冻结测试房间', mode: 'duel', durationMinutes: 1 }),
    });
    const roomId = ((await room.json()) as { room: { id: string } }).room.id;

    const joined = await request(`/api/rooms/${roomId}/join`, {
      method: 'POST',
      headers: { Cookie: memberCookie },
    });
    expect(joined.status).toBe(200);

    const createWhileActive = await request('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: memberCookie },
      body: createTeamBody('候场创建队', 'owl'),
    });
    expect(createWhileActive.status).toBe(409);
    expect(await createWhileActive.json()).toMatchObject({ error: { code: 'ACTIVE_ROOM' } });

    const deleteFrozen = await request(`/api/teams/${creatorTeamId}`, {
      method: 'DELETE',
      headers: { Cookie: creatorCookie },
    });
    expect(deleteFrozen.status).toBe(409);
    expect(await deleteFrozen.json()).toMatchObject({ error: { code: 'TEAM_FROZEN' } });

    await request(`/api/rooms/${roomId}/leave`, {
      method: 'POST',
      headers: { Cookie: memberCookie },
    });
  });

  it('enforces single ownership even after the creator is removed by a teacher', async () => {
    const memberList = await request(`/api/teacher/teams?query=${encodeURIComponent('自建一队')}`, {
      headers: { Cookie: teacherCookie },
    });
    const members = (await memberList.json()) as {
      items: Array<{ id: string; members: Array<{ id: string; student_no: string }> }>;
    };
    const team = members.items.find((candidate) => candidate.id === creatorTeamId)!;
    const creatorMemberRow = team.members.find((member) => member.student_no === 'S101')!;
    const removed = await request(
      `/api/teacher/teams/${creatorTeamId}/members/${creatorMemberRow.id}`,
      { method: 'DELETE', headers: { Cookie: teacherCookie } },
    );
    expect(removed.status).toBe(200);

    const notMember = await request('/api/me/team', { headers: { Cookie: creatorCookie } });
    expect(await notMember.json()).toEqual({ team: null });

    const recreate = await request('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: creatorCookie },
      body: createTeamBody('再建二队', 'panda'),
    });
    expect(recreate.status).toBe(409);
    expect(await recreate.json()).toMatchObject({ error: { code: 'TEAM_ALREADY_OWNED' } });

    const joinOther = await request(`/api/teams/${importedTeamId}/join`, {
      method: 'POST',
      headers: { Cookie: creatorCookie },
    });
    expect(joinOther.status).toBe(409);
    expect(await joinOther.json()).toMatchObject({
      error: expect.objectContaining({
        code: expect.stringMatching(/^(TEAM_ALREADY_OWNED|TEAM_FULL)$/),
      }),
    });

    const cleared = await request(`/api/teacher/teams/${importedTeamId}/members`, {
      method: 'DELETE',
      headers: { Cookie: teacherCookie },
    });
    expect(cleared.status).toBe(200);
    const joinEmptied = await request(`/api/teams/${importedTeamId}/join`, {
      method: 'POST',
      headers: { Cookie: creatorCookie },
    });
    expect(joinEmptied.status).toBe(409);
    expect(await joinEmptied.json()).toMatchObject({ error: { code: 'TEAM_ALREADY_OWNED' } });
  });

  it('soft-deletes the team while preserving personal results and history', async () => {
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO practice_results (
         id, challenge_id, user_id, engine_version, score, max_tile,
         valid_move_count, final_board_json, started_at, ended_at
       ) VALUES ('result-selfservice', 'challenge-selfservice', ?, 'test-engine',
                 1234, 256, 40, '[]', ?, ?)`,
    )
      .bind(creatorUserId, now - 1000, now)
      .run();

    const deleted = await request(`/api/teams/${creatorTeamId}`, {
      method: 'DELETE',
      headers: { Cookie: creatorCookie },
    });
    expect(deleted.status).toBe(200);

    const row = await env.DB.prepare('SELECT deleted_at, name FROM teams WHERE id = ?')
      .bind(creatorTeamId)
      .first<{ deleted_at: number; name: string }>();
    expect(row?.deleted_at).not.toBeNull();
    expect(row?.name).toBe('自建一队');
    expect(
      await env.DB.prepare('SELECT COUNT(*) AS count FROM team_members WHERE team_id = ?')
        .bind(creatorTeamId)
        .first<{ count: number }>(),
    ).toMatchObject({ count: 0 });

    const memberTeam = await request('/api/me/team', { headers: { Cookie: memberCookie } });
    expect(await memberTeam.json()).toEqual({ team: null });

    const search = await request(`/api/teams/search?query=${encodeURIComponent('自建一队')}`, {
      headers: { Cookie: memberCookie },
    });
    expect(await search.json()).toEqual({ items: [] });

    const teacherTeams = await request(
      `/api/teacher/teams?query=${encodeURIComponent('自建一队')}`,
      { headers: { Cookie: teacherCookie } },
    );
    expect(await teacherTeams.json()).toMatchObject({ total: 0, items: [] });

    const results = await request('/api/me/results', { headers: { Cookie: creatorCookie } });
    const resultsBody = (await results.json()) as { items: Array<{ type: string; score: number }> };
    expect(resultsBody.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'practice', score: 1234 })]),
    );

    const importPreview = await request('/api/teacher/teams/import/validate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: teacherCookie },
      body: JSON.stringify({
        rows: [{ name: '自建一队', memberStudentNumbers: ['S101', 'S102', 'S103'] }],
      }),
    });
    const preview = (await importPreview.json()) as { errors: Array<{ message: string }> };
    expect(preview.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: '团队名称已被已解散团队占用，请更换名称' }),
      ]),
    );
  });

  it('lets the creator build a new team after deleting the old one', async () => {
    const reuse = await request('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: creatorCookie },
      body: createTeamBody('自建一队', 'fox'),
    });
    expect(reuse.status).toBe(409);
    expect(await reuse.json()).toMatchObject({ error: { code: 'TEAM_NAME_TAKEN' } });

    const recreated = await request('/api/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json', Cookie: creatorCookie },
      body: createTeamBody('自建二队', 'dragon'),
    });
    expect(recreated.status).toBe(201);
    const myTeam = await request('/api/me/team', { headers: { Cookie: creatorCookie } });
    expect(await myTeam.json()).toMatchObject({ team: { name: '自建二队', logo: 'dragon' } });
  });
});
