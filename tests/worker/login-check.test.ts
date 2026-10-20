import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const origin = 'https://example.com';
const request = (path: string, body: unknown = {}, cookie?: string) =>
  exports.default.fetch(`${origin}/api/auth/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

describe('cookie preflight and session confirmation', () => {
  it('sets an identity-free cookie with auth security attributes, checks and clears only it', async () => {
    const login = await request('login', {
      loginId: 'teacher',
      password: 'integration-teacher-password',
    });
    const session = login.headers.get('set-cookie')!.split(';')[0];
    const user = ((await login.json()) as { user: { id: string } }).user;
    const started = await request('cookie-check', {}, session);
    expect(started.headers.get('cache-control')).toBe('no-store');
    const cookie = started.headers.get('set-cookie')!;
    for (const attribute of [
      '__Host-cookie-check-',
      'Max-Age=120',
      'Path=/',
      'Secure',
      'HttpOnly',
      'SameSite=Strict',
    ])
      expect(cookie).toContain(attribute);
    expect(cookie).not.toContain('__Host-session');
    expect(cookie).not.toContain(user.id);
    const challenge = await started.json();
    const checked = await request(
      'cookie-check/confirm',
      challenge,
      `${session}; ${cookie.split(';')[0]}`,
    );
    expect(await checked.json()).toEqual({ supported: true });
    expect(checked.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(checked.headers.get('set-cookie')).not.toContain('__Host-session');
    const confirmed = await request('session-confirm', {}, session);
    expect(await confirmed.json()).toMatchObject({ state: 'valid', user: { id: user.id } });
    expect(confirmed.headers.get('cache-control')).toBe('no-store');
    expect(await (await request('cookie-check/confirm', challenge)).json()).toEqual({
      supported: false,
    });
  });
  it('distinguishes no session cookie from an invalid session cookie', async () => {
    expect(await (await request('session-confirm')).json()).toEqual({
      state: 'missing',
      user: null,
    });
    expect(
      await (await request('session-confirm', {}, '__Host-session-fake=invalid')).json(),
    ).toEqual({ state: 'invalid', user: null });
  });
  it('isolates simultaneous probes and rejects cross-origin mutation', async () => {
    const first = await request('cookie-check');
    const second = await request('cookie-check');
    expect(
      await (
        await request(
          'cookie-check/confirm',
          await second.json(),
          first.headers.get('set-cookie')!.split(';')[0],
        )
      ).json(),
    ).toEqual({ supported: false });
    expect((await request('cookie-check/confirm', { challenge: '__Host-session' })).status).toBe(
      422,
    );
    const rejected = await exports.default.fetch(`${origin}/api/auth/cookie-check`, {
      method: 'POST',
      headers: { Origin: 'https://other.example' },
    });
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get('set-cookie')).toBeNull();
  });
});

it('locale persistence failure does not reject valid credentials or a confirmed session', async () => {
  await request('login', { loginId: 'teacher', password: 'integration-teacher-password' });
  await env.DB.exec("UPDATE users SET locale = NULL WHERE login_id = 'teacher'");
  await env.DB.exec(
    "CREATE TRIGGER reject_locale BEFORE UPDATE OF locale ON users BEGIN SELECT RAISE(ABORT, 'synthetic locale failure'); END",
  );
  const loggedIn = await request('login', {
    loginId: 'teacher',
    password: 'integration-teacher-password',
    locale: 'en',
  });
  expect(loggedIn.status).toBe(200);
  const cookie = loggedIn.headers.get('set-cookie')!.split(';')[0];
  expect(await (await request('session-confirm', {}, cookie)).json()).toMatchObject({
    state: 'valid',
    user: { locale: null },
  });
});
