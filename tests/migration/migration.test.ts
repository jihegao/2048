import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyMove, createGame } from '../../shared/game';
import type { Direction } from '../../shared/types';
import { base64UrlEncode, hashPassword } from '../../worker/lib/crypto';
import {
  migrationKeyProof,
  RUNTIME_SECRET_NAMES,
  runtimeKeyDigest,
  signRuntimeKeyProof,
  type RuntimeKeyProof,
} from '../../worker/lib/migration-key-proof';
import { migrationMode } from '../../worker/lib/migration';
import frozen from '../../worker/migration-freeze';
import worker from '../../worker/index';

const origin = 'https://synthetic.example';
const values = {
  BOOTSTRAP_TEACHER_USERNAME: 'synthetic-teacher',
  BOOTSTRAP_TEACHER_PASSWORD: 'synthetic-password',
  BOOTSTRAP_TEACHER_NAME: 'Synthetic Teacher',
  INITIAL_STUDENT_PASSWORD: 'synthetic-password',
  PASSWORD_PEPPER: 'synthetic-pepper',
  PRACTICE_SIGNING_KEY: 'synthetic-practice-key',
  IMPORT_SIGNING_KEY: 'synthetic-import-key',
};
const tables = [
  'users',
  'sessions',
  'teams',
  'team_members',
  'rooms',
  'room_entries',
  'active_participations',
  'match_players',
  'practice_results',
  'import_jobs',
  'leaderboard_periods',
  'timed_practice_sessions',
  'timed_practice_results',
  'team_practice_periods',
  'team_match_results',
  'team_period_standings',
  'd1_migrations',
];

async function phase(value: 'normal' | 'drain' | 'frozen') {
  await env.DB.prepare(
    'INSERT INTO __2048_write_fence(id,phase) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET phase=excluded.phase',
  )
    .bind(value)
    .run();
}

async function request(path: string, cookie = '', init: RequestInit = {}) {
  return exports.default.fetch(`${origin}${path}`, {
    ...init,
    headers: { Cookie: cookie, 'Content-Type': 'application/json', ...init.headers },
  });
}

async function login(loginId: string) {
  const response = await request('/api/auth/login', '', {
    method: 'POST',
    body: JSON.stringify({ loginId, password: 'synthetic-password' }),
  });
  expect(response.status).toBe(200);
  return response.headers.get('Set-Cookie')!.split(';', 1)[0];
}

async function businessSnapshot() {
  return Object.fromEntries(
    await Promise.all(
      tables.map(async (table) => [
        table,
        (await env.DB.prepare(`SELECT * FROM "${table}"`).all()).results,
      ]),
    ),
  );
}

async function proof(overrides: Partial<typeof values> = {}): Promise<RuntimeKeyProof> {
  const secrets = { ...values, ...overrides };
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(24)));
  const audience = 'synthetic-migration';
  const salt = base64UrlEncode(new Uint8Array(16));
  return {
    purpose: '2048-runtime-key-proof-v1',
    audience,
    nonce,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    proofs: Object.fromEntries(
      await Promise.all(
        RUNTIME_SECRET_NAMES.map(async (name) => [
          name,
          await runtimeKeyDigest(secrets[name], audience, nonce, name),
        ]),
      ),
    ),
    passwordFixture: {
      password: 'synthetic-password-fixture',
      salt,
      iterations: 100_000,
      expectedHash: await hashPassword(
        'synthetic-password-fixture',
        salt,
        100_000,
        secrets.PASSWORD_PEPPER,
      ),
    },
  };
}

async function proofRequest(payload: RuntimeKeyProof, key = values.IMPORT_SIGNING_KEY) {
  return new Request(`${origin}/api/_migration/key-proof`, {
    method: 'POST',
    headers: { Authorization: `Migration ${await signRuntimeKeyProof(payload, key)}` },
  });
}

beforeEach(async () => phase('normal'));

describe.sequential('drain keeps existing games and blocks admission', () => {
  it('allows a previously issued free-practice challenge to finish and save', async () => {
    const student = await login('SYNTHETIC-7');
    const started = await request('/api/practice/start', student, { method: 'POST' });
    const data = (await started.json()) as { challenge: string; seed: number; startedAt: string };
    let game = createGame(data.seed, Date.parse(data.startedAt));
    const directions: Direction[] = ['left', 'down', 'right', 'up'];
    const moves: Direction[] = [];
    for (let i = 0; i < 10_000 && game.status !== 'over'; i++) {
      const direction = directions[i % directions.length];
      const next = applyMove(game, direction, Date.parse(data.startedAt));
      if (next.moved) moves.push(direction);
      game = next.snapshot;
    }
    expect(game.status).toBe('over');
    await phase('drain');
    expect((await request('/api/practice/start', student, { method: 'POST' })).status).toBe(503);
    const saved = await request('/api/practice/complete', student, {
      method: 'POST',
      body: JSON.stringify({ challenge: data.challenge, moves }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ ok: true, result: { score: game.score } });
    const teacher = await login('synthetic-teacher');
    expect(
      (
        await request('/api/teacher/rooms', teacher, {
          method: 'POST',
          body: JSON.stringify({ name: 'blocked', mode: 'duel' }),
        })
      ).status,
    ).toBe(503);
    for (const path of ['join', 'start', 'cancel', 'leave']) {
      const stub = env.ROOMS.get(env.ROOMS.idFromName('synthetic-direct-admission'));
      expect((await stub.fetch(`https://room.internal/${path}`, { method: 'POST' })).status).toBe(
        503,
      );
    }
  });

  it('resumes a timed session, accepts pending moves, and settles once without replacement', async () => {
    const student = await login('SYNTHETIC-6');
    const start = await request('/api/practice/timed/start', student, { method: 'POST' });
    const started = (await start.json()) as { session: { id: string } };
    await phase('drain');
    const resumed = await request('/api/practice/timed/start', student, { method: 'POST' });
    expect(await resumed.json()).toMatchObject({
      status: 'active',
      session: { id: started.session.id },
    });
    expect(
      (
        await request('/api/practice/timed/moves', student, {
          method: 'POST',
          body: JSON.stringify({
            sessionId: started.session.id,
            seq: 1,
            directions: ['left', 'down'],
          }),
        })
      ).status,
    ).toBe(200);
    await env.DB.prepare(
      'UPDATE timed_practice_sessions SET started_at=?, deadline_at=? WHERE id=?',
    )
      .bind(Date.now() - 181_000, Date.now() - 1_000, started.session.id)
      .run();
    const finish = () =>
      request('/api/practice/timed/finish', student, {
        method: 'POST',
        body: JSON.stringify({ sessionId: started.session.id }),
      });
    const first = await finish();
    expect(await first.json()).toMatchObject({ status: 'settled' });
    expect((await finish()).status).toBe(200);
    expect(
      (
        await env.DB.prepare('SELECT COUNT(*) count FROM timed_practice_results WHERE session_id=?')
          .bind(started.session.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect((await request('/api/practice/timed/start', student, { method: 'POST' })).status).toBe(
      503,
    );
  });

  it('the D1 fence blocks stale admission while allowing ongoing settlement', async () => {
    await phase('drain');
    await expect(
      env.DB.prepare("UPDATE rooms SET status='countdown' WHERE id='waiting-room'").run(),
    ).rejects.toThrow('2048_MIGRATION_DRAINING');
    await expect(
      env.DB.prepare(
        "INSERT INTO active_participations VALUES('student-7','waiting-room','B')",
      ).run(),
    ).rejects.toThrow('2048_MIGRATION_DRAINING');
    await env.DB.prepare("UPDATE rooms SET status='live' WHERE id='ended-room'").run();
    await env.DB.prepare(
      "UPDATE rooms SET status='ended', settled_at=9 WHERE id='ended-room'",
    ).run();
    expect(await migrationMode(env)).toBe('drain');
  });
});

describe.sequential('full freeze is a database barrier, including late old code', () => {
  it('rejects insert/update/delete on all 17 populated tables and preserves their contents', async () => {
    const before = await businessSnapshot();
    for (const table of tables) expect(before[table].length).toBeGreaterThan(0);
    // A statement prepared before the freeze still cannot commit afterwards.
    const late = env.DB.prepare(
      "UPDATE users SET display_name='late stale write' WHERE id='student-1'",
    );
    await phase('frozen');
    await expect(late.run()).rejects.toThrow('2048_MIGRATION_FROZEN');
    for (const table of tables) {
      const columns = await env.DB.prepare(`PRAGMA table_info("${table}")`).all<{ name: string }>();
      const column = columns.results[0].name;
      for (const sql of [
        `INSERT INTO "${table}" DEFAULT VALUES`,
        `UPDATE "${table}" SET "${column}"="${column}"`,
        `DELETE FROM "${table}"`,
      ])
        await expect(env.DB.prepare(sql).run()).rejects.toThrow(
          /2048_MIGRATION_(FROZEN|DRAINING)/u,
        );
    }
    expect(await businessSnapshot()).toEqual(before);
  });

  it('blocks login, GET-side effects, WebSockets and cron before business handlers', async () => {
    const before = await businessSnapshot();
    await phase('frozen');
    for (const [method, path] of [
      ['POST', '/api/auth/login'],
      ['GET', '/api/me'],
      ['GET', '/api/practice/timed/current'],
      ['GET', '/api/rooms/waiting-room/ws'],
      ['POST', '/api/practice/complete'],
      ['PATCH', '/api/me/password'],
    ])
      expect((await request(path, '', { method })).status).toBe(503);
    await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now(), noRetry() {} }, env);
    expect(await businessSnapshot()).toEqual(before);
  });

  it('fails closed if the control row vanishes, without discarding any business row', async () => {
    const before = await businessSnapshot();
    await env.DB.prepare('DELETE FROM __2048_write_fence WHERE id=1').run();
    expect(await migrationMode(env)).toBe('frozen');
    await expect(env.DB.prepare('DELETE FROM sessions').run()).rejects.toThrow(
      '2048_MIGRATION_FROZEN',
    );
    expect((await request('/api/auth/login', '', { method: 'POST' })).status).toBe(503);
    expect(await businessSnapshot()).toEqual(before);
  });

  it('can reopen the same synthetic database without resetting users or migrations', async () => {
    const before = await businessSnapshot();
    await phase('frozen');
    await phase('normal');
    expect(await businessSnapshot()).toEqual(before);
    expect(await migrationMode(env)).toBe('normal');
    expect(await login('SYNTHETIC-7')).toContain('__Host-session-');
  });
});

describe.sequential('encrypted-secret source acceptance returns booleans only', () => {
  it('accepts the proof generated by the actual Node handoff runner', async () => {
    const response = await migrationKeyProof(
      new Request(`${origin}/api/_migration/key-proof`, {
        method: 'POST',
        headers: { Authorization: env.TEST_NODE_KEY_PROOF_AUTH },
      }),
      env,
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toMatchObject({ ok: true, passwordAlgorithmMatches: true });
  });
  it('checks all seven keys and the original password algorithm while frozen', async () => {
    const before = await businessSnapshot();
    await phase('frozen');
    const payload = await proof();
    const response = await frozen.fetch(await proofRequest(payload), env);
    expect(response.status).toBe(200);
    const result = (await response.json()) as { ok: boolean; matches: Record<string, boolean> };
    expect(result.ok).toBe(true);
    expect(result.matches).toEqual(
      Object.fromEntries(RUNTIME_SECRET_NAMES.map((name) => [name, true])),
    );
    const serialized = JSON.stringify(result);
    for (const value of Object.values(values)) expect(serialized).not.toContain(value);
    expect(serialized).not.toContain(payload.passwordFixture.expectedHash);
    expect(await businessSnapshot()).toEqual(before);
  });

  it('rejects a wrong pepper without replacing any runtime secret', async () => {
    const response = (await migrationKeyProof(
      await proofRequest(await proof({ PASSWORD_PEPPER: 'wrong-synthetic-pepper' })),
      env,
    ))!;
    expect(await response.json()).toMatchObject({
      ok: false,
      matches: { PASSWORD_PEPPER: false },
      passwordAlgorithmMatches: false,
    });
  });

  it.each(['expired', 'audience', 'signature', 'long-window', 'missing-auth'])(
    'refuses %s proof',
    async (reason) => {
      const payload = await proof();
      if (reason === 'expired') {
        payload.issuedAt -= 120_000;
        payload.expiresAt -= 120_000;
      }
      if (reason === 'audience') payload.audience = 'some-other-worker';
      if (reason === 'long-window') payload.expiresAt += 60_000;
      const request =
        reason === 'missing-auth'
          ? new Request(`${origin}/api/_migration/key-proof`, { method: 'POST' })
          : await proofRequest(
              payload,
              reason === 'signature' ? 'wrong-key' : values.IMPORT_SIGNING_KEY,
            );
      expect((await migrationKeyProof(request, env))?.status).toBe(401);
    },
  );
});
