import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { emptyBracket, type BracketData } from '../../shared/brackets';
import { hashPassword } from '../../worker/lib/crypto';
const origin = 'https://example.com';
async function login(loginId = 'teacher', password = 'integration-teacher-password') {
  const response = await exports.default.fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ loginId, password }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('set-cookie')!.split(';', 1)[0];
}
const get = (cookie: string, kind = 'teams8') =>
  exports.default.fetch(`${origin}/api/teacher/brackets/${kind}`, { headers: { Cookie: cookie } });
const put = (cookie: string, body: unknown, kind = 'teams8', extra: Record<string, string> = {}) =>
  exports.default.fetch(`${origin}/api/teacher/brackets/${kind}`, {
    method: 'PUT',
    headers: { Cookie: cookie, 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
async function seedTeams() {
  const now = Date.now();
  await env.DB.batch(
    Array.from({ length: 9 }, (_, i) =>
      env.DB.prepare(
        'INSERT INTO teams (id, code, name, logo, created_at, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(
        `bracket-${i}`,
        `BR${i}`,
        `对阵队${i}`,
        `icon${i + 1}`,
        now,
        now,
        i === 8 ? now : null,
      ),
    ),
  );
}
describe('teacher online brackets', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM tournament_brackets'),
      env.DB.prepare("DELETE FROM teams WHERE id LIKE 'bracket-%'"),
      env.DB.prepare("DELETE FROM users WHERE id = 'bracket-student' OR id LIKE 'roster-%'"),
    ]);
  });
  it('requires authentication and rejects student reads and writes', async () => {
    expect((await get('')).status).toBe(401);
    expect((await put('', { revision: 0, state: emptyBracket('teams8') })).status).toBe(401);
    const now = Date.now();
    const password = 'bracket-student-password';
    const salt = 'bracket-student-salt';
    const hash = await hashPassword(password, salt, 100000, 'integration-password-pepper');
    await env.DB.prepare(
      "INSERT INTO users (id, login_id, role, student_no, display_name, class_name, password_hash, password_salt, password_iterations, created_at, updated_at) VALUES ('bracket-student', 'BR001', 'student', 'BR001', '学生', '一班', ?, ?, 100000, ?, ?)",
    )
      .bind(hash, salt, now, now)
      .run();
    const student = await login('BR001', password);
    expect((await get(student)).status).toBe(403);
    expect((await put(student, { revision: 0, state: emptyBracket('teams8') })).status).toBe(403);
  });
  it('loads current team logos, excludes dissolved teams, and persists across reloads', async () => {
    const cookie = await login();
    await seedTeams();
    const response = await get(cookie);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const loaded = (await response.json()) as BracketData;
    expect(loaded.revision).toBe(0);
    expect(loaded.catalog).toHaveLength(8);
    expect(loaded.catalog[0]).toMatchObject({ logo: 'icon1', name: '对阵队0' });
    loaded.state.names = loaded.catalog.map((entry) => entry.name);
    loaded.state.winners[0][0] = loaded.catalog[0].id;
    loaded.state.title = '校内团队赛';
    expect((await put(cookie, { revision: 0, state: loaded.state })).status).toBe(200);
    expect(await (await get(cookie)).json()).toMatchObject({ revision: 1, state: loaded.state });
    const rows = await env.DB.prepare('SELECT COUNT(*) AS count FROM tournament_brackets').first<{
      count: number;
    }>();
    expect(rows?.count).toBe(1);
  });
  it('prevents a stale administrator from overwriting a newer first or subsequent save', async () => {
    const cookie = await login();
    const state = emptyBracket('teams8');
    const first = await Promise.all([
      put(cookie, { revision: 0, state: { ...state, title: 'A' } }),
      put(cookie, { revision: 0, state: { ...state, title: 'B' } }),
    ]);
    expect(first.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await put(cookie, { revision: 1, state: { ...state, title: '最新' } })).status).toBe(
      200,
    );
    expect((await put(cookie, { revision: 1, state: { ...state, title: '旧修改' } })).status).toBe(
      409,
    );
    expect(await (await get(cookie)).json()).toMatchObject({
      revision: 2,
      state: { title: '最新' },
    });
  });
  it('rejects forged winners, wrong dimensions, unknown kinds, and cross-origin saves', async () => {
    const cookie = await login();
    const state = emptyBracket('teams8');
    state.winners[2][0] = 'forged';
    expect((await put(cookie, { revision: 0, state })).status).toBe(422);
    expect((await put(cookie, { revision: 0, state: emptyBracket('players16') })).status).toBe(422);
    expect((await get(cookie, 'unknown')).status).toBe(404);
    expect(
      (
        await put(cookie, { revision: 0, state: emptyBracket('teams8') }, 'teams8', {
          Origin: 'https://attacker.example',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await put(cookie, {
          revision: 0,
          state: { ...emptyBracket('teams8'), title: 'a'.repeat(40000) },
        })
      ).status,
    ).toBe(413);
  });
  it('provides a minimal student catalog and keeps personal and team brackets independent', async () => {
    const cookie = await login();
    const now = Date.now();
    await env.DB.batch(
      [0, 1].map((i) =>
        env.DB.prepare(
          "INSERT INTO users (id, login_id, role, student_no, display_name, class_name, password_hash, password_salt, password_iterations, created_at, updated_at) VALUES (?, ?, 'student', ?, '同名', ?, 'unused', 'unused', 100000, ?, ?)",
        ).bind(`roster-${i}`, `ROSTER${i}`, `ROSTER${i}`, `${i + 1}班`, now, now),
      ),
    );
    const loaded = (await (await get(cookie, 'players16')).json()) as BracketData;
    expect(loaded.catalog).toHaveLength(2);
    expect(loaded.catalog[0].label).toContain('ROSTER0');
    expect(Object.keys(loaded.catalog[0]).sort()).toEqual(['id', 'label', 'logo', 'name']);
    loaded.state.names[0] = loaded.catalog[0].label;
    expect((await put(cookie, { revision: 0, state: loaded.state }, 'players16')).status).toBe(200);
    expect(await (await get(cookie)).json()).toMatchObject({
      revision: 0,
      state: emptyBracket('teams8'),
    });
  });
});
