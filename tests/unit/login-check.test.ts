import { afterEach, expect, it, vi } from 'vitest';
import { checkLoginCookie, confirmLoginSession } from '../../src/lib/login-check';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('requires both a server cookie round trip and a matching session identity', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(json({ challenge: 'test' }))
    .mockResolvedValueOnce(json({ supported: true }))
    .mockResolvedValueOnce(json({ state: 'valid', user: { id: 'a' } }));
  vi.stubGlobal('fetch', fetch);
  await checkLoginCookie();
  expect(await confirmLoginSession('a')).toEqual({ id: 'a' });
  for (const [, init] of fetch.mock.calls)
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
});
it.each([
  [{ state: 'missing' }, 'cookieMissing'],
  [{ state: 'invalid' }, 'sessionInvalid'],
  [{ state: 'valid', user: { id: 'b' } }, 'sessionInvalid'],
  [{}, 'checkUnknown'],
  [{ state: 'valid' }, 'checkUnknown'],
])('rejects an unconfirmed session %j', async (value, code) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => json(value)),
  );
  await expect(confirmLoginSession('a')).rejects.toMatchObject({ code });
});
it('reports cookie rejection separately from network or server uncertainty', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce(json({ challenge: 'test' }))
      .mockResolvedValueOnce(json({ supported: false })),
  );
  await expect(checkLoginCookie()).rejects.toMatchObject({ code: 'cookieMissing' });
  for (const fetch of [
    vi.fn().mockRejectedValue(new Error('offline')),
    vi.fn(async () => json({}, 503)),
    vi.fn(async () => json({})),
  ]) {
    vi.stubGlobal('fetch', fetch);
    await expect(checkLoginCookie()).rejects.toMatchObject({ code: 'checkUnknown' });
  }
});
it('bounds unknown network checks without classifying them as cookie rejection', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_path, init: RequestInit) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    ),
  );
  const checking = expect(checkLoginCookie()).rejects.toMatchObject({ code: 'checkUnknown' });
  await vi.advanceTimersByTimeAsync(60_000);
  await checking;
});
