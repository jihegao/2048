import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { applyMove, createGame } from '../../shared/game';
import type { Direction } from '../../shared/types';
import type { PersonalResultsResponse } from '../../shared/types';
import { settleExpiredTimedSessions } from '../../worker/routes/timed-practice';

const origin = 'https://example.com';

async function request(path: string, cookie = '', init: RequestInit = {}) {
  return exports.default.fetch(`${origin}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', Cookie: cookie, ...init.headers },
  });
}

async function login(loginId: string, password: string): Promise<string> {
  const response = await request('/api/auth/login', '', {
    method: 'POST',
    body: JSON.stringify({ loginId, password, locale: 'zh-CN' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';', 1)[0];
}

describe.sequential('server-authoritative timed practice', () => {
  let teacher = '';
  let student = '';
  let userId = '';

  it('creates a student and keeps teacher endpoints private', async () => {
    teacher = await login('teacher', 'integration-teacher-password');
    const rows = [
      { studentNumber: 'T20263101', name: '限时学生', className: '六年级一班', gradeLevel: 6 },
    ];
    const preview = await request('/api/teacher/users/import/validate', teacher, {
      method: 'POST',
      body: JSON.stringify({ rows }),
    });
    const token = ((await preview.json()) as { token: string }).token;
    const commit = await request('/api/teacher/users/import/commit', teacher, {
      method: 'POST',
      body: JSON.stringify({ rows, token }),
    });
    expect(commit.status).toBe(200);
    userId = (await env.DB.prepare('SELECT id FROM users WHERE student_no = ?')
      .bind('T20263101')
      .first<{ id: string }>())!.id;
    student = await login('T20263101', 'integration-student-password');
    expect((await request('/api/teacher/timed-practice/top', student)).status).toBe(403);
  });

  it('accepts each operation once, settles at the fixed deadline, and rejects late moves', async () => {
    const start = await request('/api/practice/timed/start', student, { method: 'POST' });
    expect(start.status).toBe(200);
    const started = (await start.json()) as {
      status: string;
      session: { id: string; seq: number; deadlineAt: string; startedAt: string };
    };
    expect(started.status).toBe('active');
    expect(Date.parse(started.session.deadlineAt) - Date.parse(started.session.startedAt)).toBe(
      180_000,
    );
    const resumed = await request('/api/practice/timed/start', student, { method: 'POST' });
    expect(((await resumed.json()) as { session: { id: string } }).session.id).toBe(
      started.session.id,
    );
    const body = { sessionId: started.session.id, seq: 1, direction: 'left' };
    const accepted = await request('/api/practice/timed/move', student, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(accepted.status).toBe(200);
    expect(((await accepted.json()) as { session: { seq: number } }).session.seq).toBe(1);
    const duplicate = await request('/api/practice/timed/move', student, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect(duplicate.status).toBe(200);
    expect(((await duplicate.json()) as { session: { seq: number } }).session.seq).toBe(1);
    const conflict = await request('/api/practice/timed/move', student, {
      method: 'POST',
      body: JSON.stringify({ ...body, direction: 'right' }),
    });
    expect(conflict.status).toBe(409);

    const oldStart = Date.now() - 181_000;
    await env.DB.prepare(
      `UPDATE timed_practice_sessions SET started_at = ?, deadline_at = ? WHERE id = ?`,
    )
      .bind(oldStart, oldStart + 180_000, started.session.id)
      .run();
    const finish = await request('/api/practice/timed/finish', student, {
      method: 'POST',
      body: JSON.stringify({ sessionId: started.session.id }),
    });
    expect(finish.status).toBe(200);
    const finished = (await finish.json()) as {
      status: string;
      result: { id: string; score: number; endReason: string; endedAt: string };
    };
    expect(finished.status).toBe('settled');
    expect(finished.result.endReason).toBe('time_limit');
    expect(Date.parse(finished.result.endedAt)).toBe(oldStart + 180_000);
    const late = await request('/api/practice/timed/move', student, {
      method: 'POST',
      body: JSON.stringify({ ...body, seq: 2, direction: 'up' }),
    });
    expect(late.status).toBe(200);
    expect(((await late.json()) as { result: { id: string } }).result.id).toBe(finished.result.id);
    const again = await request('/api/practice/timed/finish', student, {
      method: 'POST',
      body: JSON.stringify({ sessionId: started.session.id }),
    });
    expect(((await again.json()) as { result: { id: string } }).result.id).toBe(finished.result.id);
    const count = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM timed_practice_results WHERE session_id = ?',
    )
      .bind(started.session.id)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
    const recordedGrade = await env.DB.prepare(
      'SELECT grade_at_completion FROM timed_practice_results WHERE session_id = ?',
    )
      .bind(started.session.id)
      .first<{ grade_at_completion: string | null }>();
    expect(recordedGrade?.grade_at_completion).toBe('6');
    const row = await env.DB.prepare(
      'SELECT seq, moves_json FROM timed_practice_sessions WHERE id = ?',
    )
      .bind(started.session.id)
      .first<{ seq: number; moves_json: string }>();
    expect(row?.seq).toBe(1);
    expect(JSON.parse(row!.moves_json)).toHaveLength(1);
  });

  it('keeps top 10 timed results separate from unlimited practice and exports raw traceable rows', async () => {
    const now = Date.now();
    for (let index = 0; index < 11; index += 1) {
      const id = `timed-seed-${index}`;
      const startedAt = now - 200_000 - index * 1000;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO timed_practice_sessions (
             id, user_id, mode, duration_seconds, engine_version, seed,
             started_at, deadline_at, seq, moves_json, snapshot_json, status, settled_at
           ) VALUES (?, ?, 'timed_3m', 180, '1.0.0', 1, ?, ?, 0, '[]', ?, 'settled', ?)`,
        ).bind(
          id,
          userId,
          startedAt,
          startedAt + 180_000,
          JSON.stringify(createGame(1, startedAt)),
          now,
        ),
        env.DB.prepare(
          `INSERT INTO timed_practice_results (
             id, session_id, user_id, mode, duration_seconds, engine_version,
             score, max_tile, valid_move_count, final_board_json,
             started_at, deadline_at, ended_at, end_reason, settled_at
           ) VALUES (?, ?, ?, 'timed_3m', 180, '1.0.0', ?, 128, 5, '[]', ?, ?, ?, 'time_limit', ?)`,
        ).bind(
          id,
          id,
          userId,
          index * 100,
          startedAt,
          startedAt + 180_000,
          startedAt + 180_000,
          now,
        ),
      ]);
    }
    const personal = await request('/api/me/results', student);
    const data = (await personal.json()) as PersonalResultsResponse;
    expect(data.timedPracticeBest).toHaveLength(10);
    expect(data.timedPracticeBest.map((row) => row.score)).toEqual([
      1000, 900, 800, 700, 600, 500, 400, 300, 200, 100,
    ]);
    expect(data.practiceBest).toEqual([]);
    const top = await request('/api/teacher/timed-practice/top', teacher);
    const topData = (await top.json()) as {
      qualificationDecided: boolean;
      includesTestAccounts: boolean;
      items: Array<{ session_id: string }>;
    };
    expect(topData.qualificationDecided).toBe(false);
    expect(topData.includesTestAccounts).toBe(true);
    expect(topData.items).toHaveLength(10);
    const trace = await request(
      `/api/teacher/timed-practice/${topData.items[0].session_id}`,
      teacher,
    );
    expect(trace.status).toBe(200);
    const csv = await request('/api/teacher/timed-practice/export.csv', teacher);
    expect(csv.status).toBe(200);
    expect(csv.headers.get('X-Qualification-Status')).toContain('includes-test-accounts');
    expect((await csv.text()).split('\r\n')).toHaveLength(11);
  });

  it('settles an abandoned game through the scheduled path', async () => {
    const started = (await (
      await request('/api/practice/timed/start', student, {
        method: 'POST',
      })
    ).json()) as { session: { id: string } };
    const startAt = Date.now() - 181_000;
    await env.DB.prepare(
      `UPDATE timed_practice_sessions SET started_at = ?, deadline_at = ? WHERE id = ?`,
    )
      .bind(startAt, startAt + 180_000, started.session.id)
      .run();
    expect(await settleExpiredTimedSessions(env)).toBe(1);
    expect(await settleExpiredTimedSessions(env)).toBe(0);
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM timed_practice_results WHERE session_id = ?`,
    )
      .bind(started.session.id)
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
    const grade = await env.DB.prepare(
      'SELECT grade_at_completion FROM timed_practice_results WHERE session_id = ?',
    )
      .bind(started.session.id)
      .first<{ grade_at_completion: string | null }>();
    expect(grade?.grade_at_completion).toBe('6');
  });

  it('settles an early game over before the 180-second deadline', async () => {
    const started = (await (
      await request('/api/practice/timed/start', student, {
        method: 'POST',
      })
    ).json()) as { session: { id: string; startedAt: string } };
    const startedAt = Date.parse(started.session.startedAt);
    const directions: Direction[] = ['left', 'down', 'right', 'up'];
    const moves: Array<{ direction: Direction; receivedAt: number }> = [];
    let snapshot = createGame(1, startedAt);
    while (snapshot.status !== 'over' && moves.length < 3000) {
      const direction = directions[moves.length % directions.length];
      const receivedAt = startedAt + moves.length + 1;
      moves.push({ direction, receivedAt });
      snapshot = applyMove(snapshot, direction, receivedAt).snapshot;
    }
    expect(snapshot.status).toBe('over');
    await env.DB.prepare(
      `UPDATE timed_practice_sessions
       SET seed = 1, seq = ?, moves_json = ?, snapshot_json = ? WHERE id = ?`,
    )
      .bind(moves.length, JSON.stringify(moves), JSON.stringify(snapshot), started.session.id)
      .run();
    const finish = await request('/api/practice/timed/finish', student, {
      method: 'POST',
      body: JSON.stringify({ sessionId: started.session.id }),
    });
    expect(finish.status).toBe(200);
    const result = (await finish.json()) as {
      status: string;
      result: { endReason: string; score: number; validMoveCount: number };
    };
    expect(result.status).toBe('settled');
    expect(result.result.endReason).toBe('game_over');
    expect(result.result.score).toBe(snapshot.score);
    expect(result.result.validMoveCount).toBe(snapshot.moveCount);
  });
});
